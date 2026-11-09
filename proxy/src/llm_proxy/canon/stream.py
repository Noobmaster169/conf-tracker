"""Canonical stream events, plus the aggregate/explode pair.

The event vocabulary is deliberately isomorphic to Anthropic's SSE dialect, so
`wire/anthropic_out.stream()` is close to a rename while `wire/openai_out.stream()`
carries the state machine.

`aggregate()` and `explode()` are inverses. Together they buy three things for free:

  * a blocking client served by a streaming-only provider (aggregate the events),
  * a streaming client served by a blocking-only provider (explode the response),
  * caching a streamed response and replaying it as a synthetic stream later.
"""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

from .request import ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock
from .response import CanonResponse, CanonUsage, StopReason


class MessageStart(BaseModel):
    type: Literal["message_start"] = "message_start"
    id: str
    provider: str = ""
    model_id: str = ""
    alias: str = ""
    usage: CanonUsage = Field(default_factory=CanonUsage)


class BlockStart(BaseModel):
    type: Literal["block_start"] = "block_start"
    index: int
    # An empty shell of the block that is about to be filled: TextBlock(text=""),
    # ToolUseBlock(input={}), etc.
    block: ContentBlock


class TextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    index: int
    text: str


class ThinkingDelta(BaseModel):
    type: Literal["thinking_delta"] = "thinking_delta"
    index: int
    thinking: str


class SignatureDelta(BaseModel):
    type: Literal["signature_delta"] = "signature_delta"
    index: int
    signature: str


class ToolInputDelta(BaseModel):
    """A fragment of the JSON for a tool_use block's `input`.

    Both wires stream tool arguments as partial JSON text rather than structured
    values, so the fragment stays a string until the block closes.
    """

    type: Literal["tool_input_delta"] = "tool_input_delta"
    index: int
    partial_json: str


class BlockStop(BaseModel):
    type: Literal["block_stop"] = "block_stop"
    index: int


class MessageDelta(BaseModel):
    type: Literal["message_delta"] = "message_delta"
    stop_reason: StopReason | None = None
    stop_sequence: str | None = None
    stop_details: dict[str, Any] | None = None
    usage: CanonUsage | None = None
    # A schema-bound stream: the provider's validated answer. The text deltas
    # before it are the model writing that JSON, a preview; this is the answer.
    structured: Any = None


class MessageStop(BaseModel):
    type: Literal["message_stop"] = "message_stop"


class StreamError(BaseModel):
    """Terminal failure.

    Providers yield this as their FINAL event rather than raising mid-iteration: once
    the response has started, the HTTP status is already on the wire and an exception
    would just truncate the body with no explanation.
    """

    type: Literal["error"] = "error"
    code: str
    message: str
    retryable: bool = False


CanonEvent = Annotated[
    Union[
        MessageStart,
        BlockStart,
        TextDelta,
        ThinkingDelta,
        SignatureDelta,
        ToolInputDelta,
        BlockStop,
        MessageDelta,
        MessageStop,
        StreamError,
    ],
    Field(discriminator="type"),
]


# --------------------------------------------------------------------------- inverse


def aggregate(events: list[CanonEvent]) -> CanonResponse:
    """Fold a canonical event list into a CanonResponse.

    Tolerates truncation: a stream cut short still produces the blocks that completed,
    so a client_abort can be logged with the usage actually incurred.
    """
    resp = CanonResponse(id="", provider="", model_id="")
    blocks: dict[int, Any] = {}
    tool_json: dict[int, list[str]] = {}
    order: list[int] = []

    for ev in events:
        kind = ev.type
        if kind == "message_start":
            resp.id = ev.id
            resp.provider = ev.provider
            resp.model_id = ev.model_id
            resp.alias = ev.alias
            resp.usage = ev.usage.merge(resp.usage)
        elif kind == "block_start":
            blocks[ev.index] = ev.block.model_copy(deep=True)
            if ev.index not in order:
                order.append(ev.index)
            if ev.block.type == "tool_use":
                tool_json[ev.index] = []
        elif kind == "text_delta":
            blk = blocks.get(ev.index)
            if isinstance(blk, TextBlock):
                blk.text += ev.text
        elif kind == "thinking_delta":
            blk = blocks.get(ev.index)
            if isinstance(blk, ThinkingBlock):
                blk.thinking += ev.thinking
        elif kind == "signature_delta":
            blk = blocks.get(ev.index)
            if isinstance(blk, ThinkingBlock):
                blk.signature = (blk.signature or "") + ev.signature
        elif kind == "tool_input_delta":
            tool_json.setdefault(ev.index, []).append(ev.partial_json)
        elif kind == "block_stop":
            blk = blocks.get(ev.index)
            if isinstance(blk, ToolUseBlock):
                raw = "".join(tool_json.get(ev.index, []))
                if raw.strip():
                    try:
                        parsed = json.loads(raw)
                    except json.JSONDecodeError:
                        # Preserve the bytes rather than dropping the call. The
                        # outbound translator re-emits __raw verbatim so a downstream
                        # tool runner can still see what the model meant.
                        parsed = {"__raw": raw}
                    blk.input = parsed if isinstance(parsed, dict) else {"__raw": raw}
        elif kind == "message_delta":
            if ev.stop_reason is not None:
                resp.stop_reason = ev.stop_reason
            if ev.stop_sequence is not None:
                resp.stop_sequence = ev.stop_sequence
            if ev.stop_details is not None:
                resp.stop_details = ev.stop_details
            if ev.usage is not None:
                resp.usage = ev.usage.merge(resp.usage)
        elif kind == "error":
            resp.stop_reason = StopReason.ERROR
            resp.stop_details = {"type": "error", "code": ev.code, "message": ev.message}

    resp.content = [blocks[i] for i in order if i in blocks]
    return resp


def explode(resp: CanonResponse) -> list[CanonEvent]:
    """Render a CanonResponse as the event list that would have produced it.

    `aggregate(explode(r)) == r` for the fields the stream carries; that identity is
    asserted in the test suite because cache replay depends on it.
    """
    events: list[CanonEvent] = [
        MessageStart(
            id=resp.id,
            provider=resp.provider,
            model_id=resp.model_id,
            alias=resp.alias,
            usage=CanonUsage(input_tokens=resp.usage.input_tokens),
        )
    ]

    for i, block in enumerate(resp.content):
        if block.type == "text":
            events.append(BlockStart(index=i, block=TextBlock(text="", cache_control=block.cache_control)))
            if block.text:
                events.append(TextDelta(index=i, text=block.text))
        elif block.type == "thinking":
            events.append(BlockStart(index=i, block=ThinkingBlock(thinking="")))
            if block.thinking:
                events.append(ThinkingDelta(index=i, thinking=block.thinking))
            if block.signature:
                events.append(SignatureDelta(index=i, signature=block.signature))
        elif block.type == "tool_use":
            events.append(
                BlockStart(index=i, block=ToolUseBlock(id=block.id, name=block.name, input={}))
            )
            events.append(
                ToolInputDelta(
                    index=i, partial_json=json.dumps(block.input, sort_keys=True)
                )
            )
        else:
            # image / tool_result / redacted_thinking have no delta form; emit whole.
            events.append(BlockStart(index=i, block=block.model_copy(deep=True)))
        events.append(BlockStop(index=i))

    events.append(
        MessageDelta(
            stop_reason=resp.stop_reason,
            stop_sequence=resp.stop_sequence,
            stop_details=resp.stop_details,
            usage=resp.usage,
        )
    )
    events.append(MessageStop())
    return events
