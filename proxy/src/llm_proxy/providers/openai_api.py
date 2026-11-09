"""OpenAI Chat Completions over HTTP — the `openai_compatible` adapter.

`base_url` is what turns Ollama (or vLLM, NIM, Groq, ...) into a YAML entry rather
than a new module; `_adapt` covers the ways such servers are only mostly
OpenAI-shaped.

`StreamOnly`: the upstream request always sets `stream=True` with
`stream_options.include_usage`, and blocking callers get the aggregate. That is the
only way to get token usage out of the OpenAI wire reliably.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

import httpx
import orjson

from ..canon.request import CanonRequest, TextBlock, ThinkingBlock, ToolUseBlock
from ..canon.response import CanonUsage, StopReason
from ..canon.stream import (
    BlockStart,
    BlockStop,
    CanonEvent,
    MessageDelta,
    MessageStart,
    MessageStop,
    StreamError,
    TextDelta,
    ThinkingDelta,
    ToolInputDelta,
)
from ..config import ProviderConfig
from ..errors import InvalidRequest, ProviderError, RateLimited
from ..wire import openai_out
from .base import StreamOnly
from .retry import ConcurrencyGate

_FINISH = {
    "stop": StopReason.END_TURN,
    "tool_calls": StopReason.TOOL_USE,
    "function_call": StopReason.TOOL_USE,
    "length": StopReason.MAX_TOKENS,
    "content_filter": StopReason.REFUSAL,
}


class OpenAIProvider(StreamOnly):
    type = "openai_compatible"

    def __init__(self, name: str, cfg: ProviderConfig) -> None:
        super().__init__(name, cfg)
        self.gate = ConcurrencyGate(cfg.max_concurrency)
        self._client: httpx.AsyncClient | None = None
        self._stream_options = cfg.supports_stream_options

    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            headers = {"content-type": "application/json", **self.cfg.extra_headers}
            key = self.cfg.api_key()
            if key:
                headers["authorization"] = f"Bearer {key}"
            elif self.cfg.api_key_env:
                raise ProviderError(
                    f"provider '{self.name}' expects {self.cfg.api_key_env} in the "
                    "environment but it is unset",
                    provider=self.name,
                )
            # api_key_env: null is legitimate — local Ollama and vLLM want no auth.
            self._client = httpx.AsyncClient(
                base_url=(self.cfg.base_url or "https://api.openai.com/v1").rstrip("/"),
                headers=headers,
                timeout=httpx.Timeout(self.cfg.timeout_s, connect=15.0),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _error(self, status: int, body: bytes) -> Exception:
        try:
            parsed = orjson.loads(body)
            message = (parsed.get("error") or {}).get("message") or body.decode()[:400]
        except Exception:  # noqa: BLE001
            message = body.decode(errors="replace")[:400]
        if status in (429, 529):
            return RateLimited(f"{self.name}: {message}", provider=self.name,
                               upstream_status=status)
        if status == 400:
            return InvalidRequest(f"{self.name} rejected the request: {message}",
                                  detail={"upstream_status": status})
        return ProviderError(f"{self.name} returned {status}: {message}",
                             provider=self.name, upstream_status=status)

    def _adapt(self, body: dict[str, Any]) -> dict[str, Any]:
        """Config-driven fixups for servers that are only mostly OpenAI-shaped."""
        if self.cfg.max_tokens_field != "max_completion_tokens":
            cap = body.pop("max_completion_tokens", None)
            if cap is not None:
                body[self.cfg.max_tokens_field] = cap
        # Last, and deliberately: an explicit per-provider setting outranks
        # anything the canonical request happened to build.
        body.update(self.cfg.extra_body)
        return body

    async def stream(self, req: CanonRequest) -> AsyncIterator[CanonEvent]:
        body = self._adapt(openai_out.build_request(req))
        body["stream"] = True
        if self._stream_options:
            body["stream_options"] = {"include_usage": True}

        try:
            async with self.gate.semaphore():
                async with self.client().stream(
                    "POST", "/chat/completions", json=body
                ) as response:
                    if response.status_code >= 400:
                        raw = await response.aread()
                        text = raw.decode(errors="replace")
                        if self._stream_options and "stream_options" in text:
                            # Some compatible endpoints reject the field. Remember and
                            # let the caller retry rather than failing every call.
                            self._stream_options = False
                            yield StreamError(
                                code="provider_error",
                                message=(
                                    f"{self.name} rejected stream_options; disabled for "
                                    "this process (set supports_stream_options: false "
                                    "in config to silence). Retry the request."
                                ),
                                retryable=True,
                            )
                            return
                        err = self._error(response.status_code, raw)
                        yield StreamError(
                            code=getattr(err, "code", "provider_error"),
                            message=str(err),
                            retryable=getattr(err, "retryable", False),
                        )
                        return
                    async for event in self._decode(response, req):
                        yield event
        except httpx.TimeoutException:
            yield StreamError(code="provider_timeout",
                              message=f"{self.name}: stream timed out", retryable=True)
        except httpx.HTTPError as e:
            yield StreamError(code="provider_error", message=f"{self.name}: {e}",
                              retryable=True)

    async def _decode(
        self, response: httpx.Response, req: CanonRequest
    ) -> AsyncIterator[CanonEvent]:
        """OpenAI SSE -> canonical events.

        OpenAI's flat channels have to be re-expanded into indexed canonical
        blocks. Text occupies block 0; each tool
        call gets its own block, numbered after it.
        """
        # All decode state is LOCAL. Putting any of it on `self` would share it
        # between concurrent requests on the same provider instance and interleave
        # two callers' blocks — a bug that only shows up under load.
        started = False
        text_index: int | None = None
        reasoning_index: int | None = None
        tool_blocks: dict[int, int] = {}  # openai tool slot -> canonical block index
        next_index = 0
        usage: CanonUsage | None = None
        finish: str | None = None
        model_id = req.model_id

        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                data = orjson.loads(payload)
            except orjson.JSONDecodeError:
                continue

            if not started:
                started = True
                model_id = data.get("model") or model_id
                yield MessageStart(
                    id=data.get("id") or req.request_id,
                    provider=self.name,
                    model_id=model_id,
                    alias=req.alias,
                )

            if data.get("usage"):
                u = data["usage"]
                usage = CanonUsage(
                    input_tokens=u.get("prompt_tokens") or 0,
                    output_tokens=u.get("completion_tokens") or 0,
                    cache_read_input_tokens=(u.get("prompt_tokens_details") or {}).get(
                        "cached_tokens"
                    ) or 0,
                    reasoning_tokens=(u.get("completion_tokens_details") or {}).get(
                        "reasoning_tokens"
                    ) or 0,
                )

            for choice in data.get("choices") or []:
                delta = choice.get("delta") or {}
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]

                reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                if reasoning:
                    if reasoning_index is None:
                        reasoning_index = next_index
                        next_index += 1
                        yield BlockStart(
                            index=reasoning_index, block=ThinkingBlock(thinking="")
                        )
                    yield ThinkingDelta(index=reasoning_index, thinking=reasoning)

                content = delta.get("content")
                if content:
                    if text_index is None:
                        text_index = next_index
                        next_index += 1
                        yield BlockStart(index=text_index, block=TextBlock(text=""))
                    yield TextDelta(index=text_index, text=content)

                for call in delta.get("tool_calls") or []:
                    slot = call.get("index", 0)
                    fn = call.get("function") or {}
                    if slot not in tool_blocks:
                        tool_blocks[slot] = next_index
                        next_index += 1
                        yield BlockStart(
                            index=tool_blocks[slot],
                            block=ToolUseBlock(
                                id=call.get("id") or f"call_{slot}",
                                name=fn.get("name", ""),
                                input={},
                            ),
                        )
                    if fn.get("arguments"):
                        yield ToolInputDelta(
                            index=tool_blocks[slot], partial_json=fn["arguments"]
                        )

        if reasoning_index is not None:
            yield BlockStop(index=reasoning_index)
        if text_index is not None:
            yield BlockStop(index=text_index)
        for block_index in tool_blocks.values():
            yield BlockStop(index=block_index)

        yield MessageDelta(
            stop_reason=_FINISH.get(finish or "stop", StopReason.END_TURN), usage=usage
        )
        yield MessageStop()
