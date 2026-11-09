"""The Claude Code CLI as a provider — the subscription money rail.

A subprocess, not an HTTP client.

Two things about this adapter are non-obvious and both are load-bearing:

  1. `ANTHROPIC_API_KEY` must be BLANKED, not deleted, in the child environment.
     See `child_env` below for why.
  2. The cost it reports is COUNTERFACTUAL. `total_cost_usd` is what the call would
     have cost via the API; no money leaves the account. It is surfaced as
     X-LLM-Proxy-Cost-USD for information, never treated as spend.

Capability-wise this is a poor cousin of the HTTP API: `claude -p` spawns a whole
agent session per call, so there is no tool-use API, no separate system prompt, and
seconds of startup latency. The session's built-in tools are the provider's `tools`
list, none by default (see `tool_args`). The `claudecli/*` entry in capabilities.py says so, and
rejects requests it cannot honour rather than silently degrading them.

Structured output is the exception: `output_config.format` maps onto the CLI's own
`--json-schema`, which validates the answer against the schema and returns it in the
envelope's `structured_output`. Streamed, the JSON arrives as a preview while the model
writes it, and the validated object rides on the final message_delta.
`max_tokens` has no CLI equivalent and is ignored.

Images are the other exception, and the mechanism is not obvious. `claude -p` takes one
prompt string on stdin, so there is nowhere to put an image content block. But the CLI's
own Read tool opens an image from disk, so a request carrying images is served by writing
each one to a private temporary directory, naming the paths in the prompt and enabling
Read for that call alone. The caller still sends ordinary Anthropic image blocks; the
translation lives here, which is what the capability table is for.
"""

from __future__ import annotations

import asyncio
import base64
import os
import shutil
import tempfile
from typing import Any, AsyncIterator, NamedTuple

import orjson

from ..canon.request import CanonRequest, ImageBlock, TextBlock
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
)
from ..config import ProviderConfig
from ..errors import (
    InvalidRequest,
    ProviderError,
    ProviderNotLoggedIn,
    ProviderTimeout,
    RateLimited,
)
from .base import BlockingOnly
from .retry import ConcurrencyGate, is_login_failure, is_retryable


def child_env(cfg: ProviderConfig) -> dict[str, str]:
    """Environment for the `claude` subprocess.

    `claudecli` is the SUBSCRIPTION path and must not see an API key. If the shell
    that started the proxy exports ANTHROPIC_API_KEY, the CLI warns "claude.ai
    connectors are disabled because ANTHROPIC_API_KEY ... takes precedence over your
    claude.ai login" and can exit 1 — which killed a 395-unit run 11 minutes in, in
    the project this was ported from. Blank rather than delete: a child that calls
    load_dotenv() would otherwise just refill it from a .env file.
    """
    env = dict(os.environ)
    if cfg.neutralise_anthropic_key:
        env["ANTHROPIC_API_KEY"] = ""
    return env


def flatten(req: CanonRequest) -> str:
    """Render the conversation as the single prompt string `claude -p` accepts.

    There is no separate system field and no structured turn format here, so system
    text is prepended and roles are marked inline. Lossy by construction — which is
    why capabilities.py routes tool-using requests away from this provider.
    """
    parts: list[str] = []
    for block in req.system:
        if block.text:
            parts.append(block.text)
    for msg in req.messages:
        text = msg.text().strip()
        if not text:
            continue
        parts.append(text if len(req.messages) == 1 else f"{msg.role.capitalize()}: {text}")
    return "\n\n".join(parts)


# What the CLI's Read tool can open. A media type outside this is refused rather than
# written with a misleading suffix, which Read would fail on with a worse message.
IMAGE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


class Prompt(NamedTuple):
    """What `claude -p` is given: the text, and the images it may read."""

    text: str
    image_paths: list[str]


def image_blocks(req: CanonRequest) -> list[ImageBlock]:
    return [b for m in req.messages for b in m.content if isinstance(b, ImageBlock)]


def write_images(blocks: list[ImageBlock], directory: str) -> list[str]:
    """Each image as a file the Read tool can open. The directory is the caller's to remove."""
    paths: list[str] = []
    for index, block in enumerate(blocks, start=1):
        if block.source_kind != "base64":
            raise InvalidRequest(
                "claudecli can only take an image sent as base64, not as a url",
                detail={"param": "messages[].content[].source"},
            )
        suffix = IMAGE_SUFFIXES.get(block.media_type or "")
        if suffix is None:
            raise InvalidRequest(
                f"claudecli cannot read an image of type {block.media_type!r}; "
                f"send one of {', '.join(sorted(IMAGE_SUFFIXES))}",
                detail={"param": "messages[].content[].source.media_type"},
            )
        path = os.path.join(directory, f"image_{index}{suffix}")
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(block.data))
        paths.append(path)
    return paths


def with_images(text: str, paths: list[str]) -> str:
    """The prompt, plus where the images are. Appended last so it reads as the final instruction."""
    if not paths:
        return text
    listed = "\n".join(f"- {path}" for path in paths)
    return (
        f"{text}\n\nThe images this request is about are on disk. Read each of these "
        f"files before answering, and answer only from what they show:\n{listed}"
    )


def output_schema(req: CanonRequest) -> dict[str, Any] | None:
    """The JSON Schema from `output_config.format`, or None when the caller wants prose."""
    fmt = req.response_format
    if not fmt:
        return None
    schema = fmt.get("schema")
    if fmt.get("type") != "json_schema" or not isinstance(schema, dict):
        raise InvalidRequest(
            "output_config.format must be {type: 'json_schema', schema: {...}}",
            detail={"param": "output_config.format"},
        )
    return schema


def failure_detail(out: str, err: str) -> str:
    """What a failed `claude -p` said, for the error and for classifying it.

    With `--output-format json` the CLI reports a failure inside its envelope, whose
    `result` is the message (`Not logged in`, a rate limit) and comes after a block
    of usage counters. Reading `result` keeps the classifiers on the message rather
    than on whichever counters fit in the first few hundred characters.
    """
    parts: list[str] = []
    try:
        envelope = orjson.loads(out) if out else None
    except orjson.JSONDecodeError:
        envelope = None
    if isinstance(envelope, dict) and envelope.get("result"):
        parts.append(str(envelope["result"]))
    if err.strip():
        parts.append(err.strip())
    if not parts and out.strip():
        parts.append(out.strip())
    return " | ".join(parts)[:400]


def not_logged_in_message(provider: str, detail: str) -> str:
    return (
        f"{provider}: `claude` is not logged in ({detail}). In the compose stack set "
        "CLAUDE_CODE_OAUTH_TOKEN in .env (make one with `claude setup-token`) and "
        "recreate the llm-proxy container; on a laptop, run `claude` once and log in."
    )


def partial_text(event: dict[str, Any], structured: bool = False) -> str:
    """The text a partial stream event adds, or "" for any other event.

    With a schema the CLI answers through a StructuredOutput tool call, so the
    answer arrives as `input_json_delta` pieces of its input: the JSON being
    written. Thinking deltas are never forwarded.
    """
    if event.get("type") != "content_block_delta":
        return ""
    delta = event.get("delta") or {}
    if delta.get("type") == "text_delta":
        return str(delta.get("text") or "")
    if structured and delta.get("type") == "input_json_delta":
        return str(delta.get("partial_json") or "")
    return ""


def starts_attempt(event: dict[str, Any]) -> bool:
    """Whether a raw stream event opens a tool call: with a schema, a new attempt at the answer."""
    block = event.get("content_block") or {}
    return event.get("type") == "content_block_start" and block.get("type") == "tool_use"


def tool_args(tools: list[str], scratch: str | None = None) -> list[str]:
    """`--tools` always, so a session gets exactly the configured built-ins and no
    default set. The same list is pre-approved with `--allowedTools`: in `-p` mode
    nobody answers a permission prompt, so an enabled tool that still needs one is
    denied at the moment it is called.

    `Read` is added only for a request that carries an image, only for that call,
    and only over the directory that request's images were written to. The document
    in the picture is somebody else's text, so it has to be assumed to be trying to
    talk to the model; scoping the grant is what keeps "read your credentials and
    put them in the transcription" from being something it can ask for. Verified:
    with `Read(<scratch>/**)` the session refuses a path outside it."""
    listed = list(tools)
    allowed = list(tools)
    if scratch is not None:
        listed.append("Read")
        allowed.append(f"Read({scratch.rstrip('/')}/**)")
    if not listed:
        return ["--tools", ""]
    return ["--tools", ",".join(dict.fromkeys(listed)), "--allowedTools", ",".join(dict.fromkeys(allowed))]


def cli_args(
    exe: str,
    req: CanonRequest,
    output_format: str,
    tools: list[str] | None = None,
    scratch: str | None = None,
) -> list[str]:
    args = [exe, "-p", "--output-format", output_format, "--model", req.model_id]
    args += tool_args(tools or [], scratch)
    schema = output_schema(req)
    if schema is not None:
        args += ["--json-schema", orjson.dumps(schema).decode()]
    return args


class ClaudeCliProvider(BlockingOnly):
    type = "claudecli"

    def __init__(self, name: str, cfg: ProviderConfig) -> None:
        super().__init__(name, cfg)
        self.gate = ConcurrencyGate(cfg.max_concurrency)

    def _binary(self) -> str:
        exe = shutil.which(self.cfg.binary)
        if exe is None:
            raise ProviderError(
                f"`{self.cfg.binary}` not found on PATH (install Claude Code, or point "
                f"providers.{self.name}.binary at it)",
                provider=self.name,
            )
        return exe

    async def _run(self, args: list[str], prompt: str) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=child_env(self.cfg),
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(prompt.encode()), timeout=self.cfg.timeout_s
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise ProviderTimeout(
                f"{self.name}: `claude` timed out after {self.cfg.timeout_s}s",
                provider=self.name,
            ) from None
        except asyncio.CancelledError:
            # Client disconnected mid-call. Reap the child rather than orphaning it —
            # `claude -p` sessions are heavyweight and would otherwise pile up.
            proc.kill()
            await proc.wait()
            raise
        return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")

    def _envelope_to_response(self, envelope: dict[str, Any], req: CanonRequest) -> CanonResponse:
        if envelope.get("is_error") or envelope.get("subtype") not in (None, "success"):
            raise ProviderError(
                f"{self.name}: CLI error (subtype={envelope.get('subtype')}): "
                f"{str(envelope.get('result', ''))[:300]}",
                provider=self.name,
            )
        text = envelope.get("result") or ""
        if output_schema(req) is not None:
            # The validated object, not `result`: that is the model's prose and only
            # usually the same JSON. Missing means the CLI did not honour the schema,
            # and passing prose on would defeat the point of asking.
            structured = envelope.get("structured_output")
            if structured is None:
                raise ProviderError(
                    f"{self.name}: a JSON schema was sent but the CLI returned no "
                    "structured_output (is this Claude Code too old for --json-schema?)",
                    provider=self.name,
                )
            text = orjson.dumps(structured).decode()
        usage_raw = envelope.get("usage") or {}
        usage = CanonUsage(
            input_tokens=usage_raw.get("input_tokens") or 0,
            output_tokens=usage_raw.get("output_tokens") or 0,
            cache_read_input_tokens=usage_raw.get("cache_read_input_tokens") or 0,
            cache_creation_input_tokens=usage_raw.get("cache_creation_input_tokens") or 0,
            reported_cost_usd=envelope.get("total_cost_usd"),
        )
        return CanonResponse(
            id=envelope.get("session_id") or req.request_id,
            provider=self.name,
            model_id=req.model_id,
            alias=req.alias,
            content=[TextBlock(text=text)] if text else [],
            stop_reason=StopReason.END_TURN,
            usage=usage,
        )

    async def complete(self, req: CanonRequest) -> CanonResponse:
        exe = self._binary()
        # The scratch directory lives as long as the retry loop: every attempt re-runs
        # the CLI and each one has to be able to read the same images.
        with tempfile.TemporaryDirectory(prefix="llm-proxy-img-") as scratch:
            return await self._complete(req, exe, scratch)

    async def _complete(self, req: CanonRequest, exe: str, scratch: str) -> CanonResponse:
        paths = write_images(image_blocks(req), scratch)
        prompt = with_images(flatten(req), paths)
        args = cli_args(exe, req, "json", self.cfg.tools, scratch=scratch if paths else None)

        from .retry import BACKOFF_S

        last = ""
        for attempt in range(len(BACKOFF_S) + 1):
            async with self.gate.semaphore():
                rc, out, err = await self._run(args, prompt)
                last = failure_detail(out, err)
            if rc == 0:
                break
            if is_login_failure(last):
                raise ProviderNotLoggedIn(not_logged_in_message(self.name, last), provider=self.name)
            if attempt == len(BACKOFF_S) or not is_retryable(last):
                if is_retryable(last):
                    raise RateLimited(
                        f"{self.name}: rate limited, {attempt + 1} attempts exhausted: {last}",
                        provider=self.name,
                    )
                raise ProviderError(
                    f"{self.name}: `claude` exited {rc}: {last}", provider=self.name
                )
            # Sleep outside the semaphore — a limit is global, and holding a slot
            # while waiting would idle every other worker.
            import random

            await asyncio.sleep(BACKOFF_S[attempt] * (0.75 + random.random() * 0.5))

        try:
            envelope = orjson.loads(out)
        except orjson.JSONDecodeError as e:
            raise ProviderError(
                f"{self.name}: could not parse the CLI JSON envelope: {e}",
                provider=self.name,
            ) from e
        return self._envelope_to_response(envelope, req)

    async def stream(self, req: CanonRequest) -> AsyncIterator[CanonEvent]:
        if self.cfg.stream_mode != "native":
            async for event in super().stream(req):
                yield event
            return

        # A schema-bound call streams too: its deltas are the JSON as the model
        # writes it, a live preview. The answer is the CLI's validated
        # structured_output, sent on the final message_delta, never the deltas.
        schema = output_schema(req)
        structured: Any = None

        exe = self._binary()
        # Removed when the generator is exhausted or closed, which is also what
        # reaps the images a cancelled stream wrote.
        scratch = tempfile.TemporaryDirectory(prefix="llm-proxy-img-")
        paths = write_images(image_blocks(req), scratch.name)
        prompt = with_images(flatten(req), paths)
        # --include-partial-messages is what makes this a token stream: without it
        # the CLI emits each assistant message only once it is complete.
        args = [
            exe, "-p", "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--model", req.model_id,
            *tool_args(self.cfg.tools, scratch.name if paths else None),
        ]
        if schema is not None:
            args += ["--json-schema", orjson.dumps(schema).decode()]

        yield MessageStart(
            id=req.request_id, provider=self.name, model_id=req.model_id, alias=req.alias
        )
        yield BlockStart(index=0, block=TextBlock(text=""))
        block = 0
        block_has_text = False

        usage = CanonUsage()
        emitted = False
        streamed = False
        failure = ""
        proc: asyncio.subprocess.Process | None = None
        try:
            async with self.gate.semaphore():
                proc = await asyncio.create_subprocess_exec(
                    *args,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=child_env(self.cfg),
                )
                assert proc.stdin is not None and proc.stdout is not None
                proc.stdin.write(prompt.encode())
                await proc.stdin.drain()
                proc.stdin.close()

                async for raw_line in proc.stdout:
                    line = raw_line.decode(errors="replace").strip()
                    if not line:
                        continue
                    try:
                        event = orjson.loads(line)
                    except orjson.JSONDecodeError:
                        continue

                    kind = event.get("type")
                    if kind == "stream_event":
                        # A raw Anthropic stream event, from --include-partial-messages.
                        raw = event.get("event") or {}
                        # With a schema, each StructuredOutput call is one attempt at the
                        # answer, and the CLI makes the model try again when an attempt
                        # fails validation. Each attempt gets its own block, so a viewer
                        # restarts its preview instead of reading two attempts run together.
                        if schema is not None and starts_attempt(raw) and block_has_text:
                            yield BlockStop(index=block)
                            block += 1
                            block_has_text = False
                            yield BlockStart(index=block, block=TextBlock(text=""))
                        text = partial_text(raw, structured=schema is not None)
                        if text:
                            emitted = streamed = block_has_text = True
                            yield TextDelta(index=block, text=text)
                    elif kind == "assistant" and event.get("error"):
                        # The CLI reports a failed session as a synthetic assistant
                        # message with `error` set (authentication_failed, ...). Its
                        # text is the failure, never an answer to stream.
                        message = event.get("message") or {}
                        texts = [b.get("text", "") for b in message.get("content") or []]
                        failure = " ".join(t for t in texts if t) or str(event["error"])
                    elif kind == "assistant":
                        message = event.get("message") or {}
                        # The finished message repeats text the partials already
                        # sent; only a CLI that sends no partials needs it again.
                        for part in message.get("content") or []:
                            if not streamed and part.get("type") == "text" and part.get("text"):
                                emitted = True
                                yield TextDelta(index=0, text=part["text"])
                        if message.get("usage"):
                            u = message["usage"]
                            usage = CanonUsage(
                                input_tokens=u.get("input_tokens") or 0,
                                output_tokens=u.get("output_tokens") or 0,
                                cache_read_input_tokens=u.get("cache_read_input_tokens") or 0,
                                cache_creation_input_tokens=(
                                    u.get("cache_creation_input_tokens") or 0
                                ),
                                reported_cost_usd=usage.reported_cost_usd,
                            )
                    elif kind == "result":
                        if event.get("total_cost_usd") is not None:
                            usage.reported_cost_usd = event["total_cost_usd"]
                        # The session's totals. An assistant message's usage is a
                        # snapshot taken as it starts when partials are on.
                        totals = event.get("usage") or {}
                        if totals.get("output_tokens"):
                            usage.input_tokens = totals.get("input_tokens") or usage.input_tokens
                            usage.output_tokens = totals["output_tokens"]
                            usage.cache_read_input_tokens = (
                                totals.get("cache_read_input_tokens") or usage.cache_read_input_tokens
                            )
                            usage.cache_creation_input_tokens = (
                                totals.get("cache_creation_input_tokens") or usage.cache_creation_input_tokens
                            )
                        # A failed session reports why in `result` ("Not logged in").
                        # That is an error message, never text for the caller.
                        if event.get("is_error"):
                            failure = str(event.get("result") or "")
                        elif schema is not None:
                            structured = event.get("structured_output")
                        elif not emitted and event.get("result"):
                            yield TextDelta(index=0, text=event["result"])
                            emitted = True

                await proc.wait()
                if proc.returncode not in (0, None):
                    stderr = (await proc.stderr.read()).decode(errors="replace")
                    detail = " | ".join(part for part in (failure, stderr.strip()) if part)[:400]
                    if is_login_failure(detail):
                        yield StreamError(
                            code=ProviderNotLoggedIn.code,
                            message=not_logged_in_message(self.name, detail),
                            retryable=False,
                        )
                        return
                    yield StreamError(
                        code="provider_error",
                        message=f"{self.name}: `claude` exited {proc.returncode}: {detail}",
                        retryable=is_retryable(detail),
                    )
                    return
        except asyncio.CancelledError:
            if proc is not None and proc.returncode is None:
                proc.kill()
                await proc.wait()
            raise
        except Exception as e:  # noqa: BLE001
            if proc is not None and proc.returncode is None:
                proc.kill()
                await proc.wait()
            yield StreamError(code="provider_error", message=f"{self.name}: {e}")
            return
        finally:
            scratch.cleanup()

        if schema is not None and structured is None:
            yield StreamError(
                code="provider_error",
                message=f"{self.name}: a JSON schema was sent but the CLI returned no structured_output",
            )
            return
        yield BlockStop(index=block)
        yield MessageDelta(stop_reason=StopReason.END_TURN, usage=usage, structured=structured)
        yield MessageStop()
