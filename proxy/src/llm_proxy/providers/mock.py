"""Deterministic scripted provider.

The default end-to-end test path. Every failure mode the proxy must handle is
reproducible here for zero dollars and zero network, which is what keeps the real
suite runnable in CI and on a plane.

The model_id selects the script, one of `_SCRIPTS` below.
"""

from __future__ import annotations

from typing import AsyncIterator

from ..canon.request import CanonRequest, TextBlock, ThinkingBlock, ToolUseBlock
from ..canon.response import CanonResponse, CanonUsage, StopReason
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
    explode,
)
from ..config import ProviderConfig
from ..errors import RateLimited
from .base import Provider

_SCRIPTS = ("echo", "tool_call", "refusal", "thinking", "error_429")


class MockProvider(Provider):
    type = "mock"

    def __init__(self, name: str, cfg: ProviderConfig) -> None:
        super().__init__(name, cfg)
        # Chunk size for synthetic streaming; 0 means "emit each block in one delta".
        self.chunk_size = 0

    def _build(self, req: CanonRequest) -> CanonResponse:
        script = (req.model_id or "echo").split("/")[-1]
        prompt = req.messages[-1].text() if req.messages else ""
        usage = CanonUsage(input_tokens=max(1, len(prompt) // 4), output_tokens=8)
        base = dict(id="msg_mock_0001", provider=self.name, model_id=req.model_id, alias=req.alias)

        if script == "refusal":
            # HTTP 200, empty content, stop_reason=refusal. Anything that indexes
            # content[0] unconditionally breaks right here — which is the point.
            return CanonResponse(
                **base,
                content=[],
                stop_reason=StopReason.REFUSAL,
                stop_details={
                    "type": "refusal",
                    "category": "cyber",
                    "explanation": "declined by mock policy",
                },
                usage=usage,
            )
        if script == "thinking":
            return CanonResponse(
                **base,
                content=[
                    ThinkingBlock(thinking="considering the request", signature="sig_mock"),
                    TextBlock(text="thought about it"),
                ],
                stop_reason=StopReason.END_TURN,
                usage=usage,
            )
        if script == "tool_call":
            return CanonResponse(
                **base,
                content=[
                    TextBlock(text="Let me look that up."),
                    ToolUseBlock(
                        id="toolu_mock_1", name="get_weather", input={"city": "Paris"}
                    ),
                ],
                stop_reason=StopReason.TOOL_USE,
                usage=usage,
            )
        return CanonResponse(
            **base,
            content=[TextBlock(text=f"echo: {prompt}")],
            stop_reason=StopReason.END_TURN,
            usage=usage,
        )

    async def complete(self, req: CanonRequest) -> CanonResponse:
        script = (req.model_id or "echo").split("/")[-1]
        if script == "error_429":
            raise RateLimited("mock provider is rate limited", provider=self.name)
        return self._build(req)

    async def stream(self, req: CanonRequest) -> AsyncIterator[CanonEvent]:
        script = (req.model_id or "echo").split("/")[-1]
        if script == "error_429":
            yield StreamError(code="rate_limited", message="mock provider is rate limited", retryable=True)
            return

        resp = self._build(req)
        if not self.chunk_size:
            for ev in explode(resp):
                yield ev
            return

        # Real chunking, so the outbound SSE state machines get exercised against
        # multi-delta blocks rather than the one-delta-per-block happy path.
        yield MessageStart(
            id=resp.id,
            provider=resp.provider,
            model_id=resp.model_id,
            alias=resp.alias,
            usage=CanonUsage(input_tokens=resp.usage.input_tokens),
        )
        n = self.chunk_size
        for i, block in enumerate(resp.content):
            if block.type == "text":
                yield BlockStart(index=i, block=TextBlock(text=""))
                for j in range(0, len(block.text), n):
                    yield TextDelta(index=i, text=block.text[j : j + n])
            elif block.type == "thinking":
                yield BlockStart(index=i, block=ThinkingBlock(thinking=""))
                for j in range(0, len(block.thinking), n):
                    yield ThinkingDelta(index=i, thinking=block.thinking[j : j + n])
            elif block.type == "tool_use":
                import json

                yield BlockStart(
                    index=i, block=ToolUseBlock(id=block.id, name=block.name, input={})
                )
                raw = json.dumps(block.input, sort_keys=True)
                for j in range(0, len(raw), n):
                    yield ToolInputDelta(index=i, partial_json=raw[j : j + n])
            else:
                yield BlockStart(index=i, block=block.model_copy(deep=True))
            yield BlockStop(index=i)

        yield MessageDelta(
            stop_reason=resp.stop_reason, stop_details=resp.stop_details, usage=resp.usage
        )
        yield MessageStop()
