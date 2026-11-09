"""CanonResponse / CanonEvent -> Anthropic Messages API JSON and SSE.

Close to a rename, since the canonical IR is Anthropic-shaped. The interesting part
is `check_tool_pairing`, which catches the round-trip bug class before it reaches the
upstream as an opaque 400.
"""

from __future__ import annotations

from typing import Any, Iterable, Iterator

from ..canon.request import CanonMessage, CanonRequest, ContentBlock
from ..canon.response import CanonResponse
from ..canon.stream import CanonEvent
from ..errors import InvalidRequest

_STOP_MAP = {
    "end_turn": "end_turn",
    "tool_use": "tool_use",
    "max_tokens": "max_tokens",
    "stop_sequence": "stop_sequence",
    "refusal": "refusal",
    "pause_turn": "pause_turn",
    "model_context_window_exceeded": "model_context_window_exceeded",
    "error": "end_turn",
}


def block_json(block: ContentBlock) -> dict[str, Any]:
    kind = block.type
    if kind == "text":
        out: dict[str, Any] = {"type": "text", "text": block.text}
        if block.cache_control:
            out["cache_control"] = block.cache_control
        return out
    if kind == "thinking":
        out = {"type": "thinking", "thinking": block.thinking}
        if block.signature is not None:
            # Integrity-checked upstream — must be byte-identical to what we received.
            out["signature"] = block.signature
        return out
    if kind == "redacted_thinking":
        return {"type": "redacted_thinking", "data": block.data}
    if kind == "image":
        if block.source_kind == "url":
            return {"type": "image", "source": {"type": "url", "url": block.data}}
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": block.media_type or "image/png",
                "data": block.data,
            },
        }
    if kind == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    if kind == "tool_result":
        out = {
            "type": "tool_result",
            "tool_use_id": block.tool_use_id,
            "content": [block_json(c) for c in block.content],
        }
        if block.is_error:
            out["is_error"] = True
        return out
    if kind == "opaque":
        return dict(block.payload)
    raise InvalidRequest(f"cannot serialise block type {kind!r}")


def messages_json(messages: Iterable[CanonMessage]) -> list[dict[str, Any]]:
    return [
        {"role": m.role, "content": [block_json(b) for b in m.content]} for m in messages
    ]


def check_tool_pairing(messages: list[CanonMessage]) -> None:
    """Assert every assistant tool_use has a matching tool_result in the next turn.

    Anthropic rejects an unmatched pair with a 400 that names neither the id nor the
    turn, which is miserable to debug through a proxy. The commonest cause is an
    inbound translator that split parallel OpenAI `role:"tool"` messages into separate
    user turns instead of merging them, so failing loudly here points straight at it.
    """
    for i, msg in enumerate(messages):
        if msg.role != "assistant":
            continue
        wanted = {b.id for b in msg.content if b.type == "tool_use"}
        if not wanted:
            continue
        nxt = messages[i + 1] if i + 1 < len(messages) else None
        got = (
            {b.tool_use_id for b in nxt.content if b.type == "tool_result"}
            if nxt and nxt.role == "user"
            else set()
        )
        missing = wanted - got
        if missing:
            raise InvalidRequest(
                "every tool_use block must be answered by a tool_result in the very "
                f"next user turn; missing result(s) for {sorted(missing)} after "
                f"message {i}. If these came from an OpenAI-shaped request, the "
                "parallel role:'tool' messages were not merged into one turn.",
                detail={"missing_tool_use_ids": sorted(missing), "message_index": i},
            )


def render(resp: CanonResponse) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": resp.id,
        "type": "message",
        "role": "assistant",
        "model": resp.model_id,
        "content": [block_json(b) for b in resp.content],
        "stop_reason": _STOP_MAP.get(resp.stop_reason.value, "end_turn"),
        "stop_sequence": resp.stop_sequence,
        "usage": {
            "input_tokens": resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
            "cache_read_input_tokens": resp.usage.cache_read_input_tokens,
            "cache_creation_input_tokens": resp.usage.cache_creation_input_tokens,
        },
    }
    # Present only on a refusal; null everywhere else, matching upstream.
    body["stop_details"] = resp.stop_details if resp.stop_reason.value == "refusal" else None
    return body


def build_request(req: CanonRequest) -> dict[str, Any]:
    """Canonical -> the JSON body for POST /v1/messages.

    The inverse of `anthropic_in.parse`; the round-trip tests feed one into the
    other to prove the wire edge is lossless.
    """
    check_tool_pairing(req.messages)
    body: dict[str, Any] = {
        "model": req.model_id or req.alias,
        "messages": messages_json(req.messages),
        "max_tokens": req.max_tokens or 4096,
    }
    if req.system:
        body["system"] = [block_json(b) for b in req.system]
    if req.tools:
        tools: list[dict[str, Any]] = []
        for t in req.tools:
            if t.server_type:
                tools.append({"type": t.server_type, "name": t.name})
            else:
                tools.append(
                    {
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema or {"type": "object", "properties": {}},
                        **({"strict": t.strict} if t.strict is not None else {}),
                    }
                )
        body["tools"] = tools

    tc = req.tool_choice
    if tc.mode != "auto" or tc.disable_parallel:
        if tc.mode == "specific":
            choice: dict[str, Any] = {"type": "tool", "name": tc.name}
        else:
            choice = {"type": tc.mode}
        if tc.disable_parallel:
            choice["disable_parallel_tool_use"] = True
        body["tool_choice"] = choice

    s = req.sampling
    if s.temperature is not None:
        body["temperature"] = s.temperature
    if s.top_p is not None:
        body["top_p"] = s.top_p
    if s.top_k is not None:
        body["top_k"] = s.top_k
    if s.stop_sequences:
        body["stop_sequences"] = s.stop_sequences

    r = req.reasoning
    if r.mode == "off":
        body["thinking"] = {"type": "disabled"}
    elif r.mode == "on":
        thinking: dict[str, Any] = (
            {"type": "enabled", "budget_tokens": r.budget_tokens}
            if r.budget_tokens is not None
            else {"type": "adaptive"}
        )
        if r.display:
            thinking["display"] = r.display
        body["thinking"] = thinking

    output_config: dict[str, Any] = {}
    if r.effort:
        # Effort is nested under output_config, not top-level. A top-level `effort`
        # is silently ignored upstream, which looks like the parameter not working.
        output_config["effort"] = r.effort
    if req.response_format:
        output_config["format"] = req.response_format
    if output_config:
        body["output_config"] = output_config

    if req.stream:
        body["stream"] = True

    body.update(req.extra)
    return body


# ------------------------------------------------------------------------ streaming


def event_frames(ev: CanonEvent, resp_id: str, model_id: str) -> list[tuple[str, dict]]:
    """One canonical event -> the (event_name, data) frames it produces.

    Stateless — the canonical vocabulary was chosen to match this dialect, so unlike
    the OpenAI side there is no block-index bookkeeping to carry between events. That
    is what lets the endpoint emit each frame the moment its event arrives.
    """
    kind = ev.type

    if kind == "message_start":
        return [(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": ev.id or resp_id,
                    "type": "message",
                    "role": "assistant",
                    "model": ev.model_id or model_id,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {
                        "input_tokens": ev.usage.input_tokens,
                        "output_tokens": ev.usage.output_tokens,
                    },
                },
            },
        )]

    if kind == "block_start":
        shell = (
            {"type": "tool_use", "id": ev.block.id, "name": ev.block.name, "input": {}}
            if ev.block.type == "tool_use"
            else block_json(ev.block)
        )
        return [(
            "content_block_start",
            {"type": "content_block_start", "index": ev.index, "content_block": shell},
        )]

    _DELTAS = {
        "text_delta": lambda e: {"type": "text_delta", "text": e.text},
        "thinking_delta": lambda e: {"type": "thinking_delta", "thinking": e.thinking},
        "signature_delta": lambda e: {"type": "signature_delta", "signature": e.signature},
        "tool_input_delta": lambda e: {
            "type": "input_json_delta",
            "partial_json": e.partial_json,
        },
    }
    if kind in _DELTAS:
        return [(
            "content_block_delta",
            {"type": "content_block_delta", "index": ev.index, "delta": _DELTAS[kind](ev)},
        )]

    if kind == "block_stop":
        return [("content_block_stop", {"type": "content_block_stop", "index": ev.index})]

    if kind == "message_delta":
        delta: dict[str, Any] = {}
        if ev.stop_reason is not None:
            delta["stop_reason"] = _STOP_MAP.get(ev.stop_reason.value, "end_turn")
        if ev.stop_sequence is not None:
            delta["stop_sequence"] = ev.stop_sequence
        payload: dict[str, Any] = {"type": "message_delta", "delta": delta}
        if ev.usage is not None:
            payload["usage"] = {
                "input_tokens": ev.usage.input_tokens,
                "output_tokens": ev.usage.output_tokens,
            }
            # Headers go out before a stream's cost is known, so a streamed call
            # carries it here instead of X-LLM-Proxy-Cost-USD. An extension:
            # Anthropic clients ignore fields they do not know.
            if ev.usage.reported_cost_usd is not None:
                payload["usage"]["cost_usd"] = ev.usage.reported_cost_usd
        if ev.structured is not None:
            payload["structured_output"] = ev.structured
        return [("message_delta", payload)]

    if kind == "message_stop":
        return [("message_stop", {"type": "message_stop"})]

    if kind == "error":
        # The same `code` and `retryable` a non-streamed error carries: a client
        # decides from `retryable` whether to wait out an outage or fail now, and
        # without it a missing login read as an outage and was retried forever.
        return [(
            "error",
            {"type": "error", "error": {
                "type": "api_error", "message": ev.message, "code": ev.code, "retryable": ev.retryable,
            }},
        )]

    return []


def stream(
    events: Iterable[CanonEvent], resp_id: str, model_id: str
) -> Iterator[tuple[str, dict]]:
    """Whole-list convenience wrapper around event_frames (used by tests)."""
    for ev in events:
        yield from event_frames(ev, resp_id, model_id)
