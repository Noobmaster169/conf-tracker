"""CanonRequest -> OpenAI Chat Completions request JSON.

The lossy edge: `thinking.signature`, `cache_control` and opaque block types have no
chat-completions representation and are dropped here.
"""

from __future__ import annotations

import json
from typing import Any

from ..canon.request import CanonRequest, ContentBlock


def _arguments(tool_input: dict[str, Any]) -> str:
    """Tool input dict -> the JSON string OpenAI expects.

    A `__raw` payload came from JSON we could not parse on the way in; re-emit those
    bytes verbatim rather than inventing a re-encoding of a value we never had.
    """
    if set(tool_input) == {"__raw"} and isinstance(tool_input["__raw"], str):
        return tool_input["__raw"]
    return json.dumps(tool_input, sort_keys=True)


def _split(content: list[ContentBlock]) -> tuple[str, list[dict[str, Any]]]:
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for block in content:
        if block.type == "text":
            text_parts.append(block.text)
        elif block.type == "tool_use":
            tool_calls.append(
                {
                    "id": block.id,
                    "type": "function",
                    "function": {"name": block.name, "arguments": _arguments(block.input)},
                }
            )
    return "".join(text_parts), tool_calls


def _response_format(fmt: dict[str, Any]) -> dict[str, Any]:
    """Anthropic's `{type: json_schema, schema}` as OpenAI's nested `json_schema` object.

    The canonical request holds the Anthropic shape, since that is the only wire in.
    Passed through unchanged, an OpenAI-compatible server ignores it or answers 400.
    """
    if fmt.get("type") == "json_schema" and "schema" in fmt and "json_schema" not in fmt:
        return {
            "type": "json_schema",
            "json_schema": {"name": "output", "schema": fmt["schema"], "strict": True},
        }
    return fmt


def build_request(req: CanonRequest) -> dict[str, Any]:
    """Canonical -> the JSON body for POST /v1/chat/completions.

    System text becomes a leading system message; tool results become `role:"tool"`
    messages.
    """
    messages: list[dict[str, Any]] = []
    if req.system:
        messages.append({"role": "system", "content": "".join(b.text for b in req.system)})

    for m in req.messages:
        text, tool_calls = _split(m.content)
        results = [b for b in m.content if b.type == "tool_result"]
        images = [b for b in m.content if b.type == "image"]

        if m.role == "user":
            # One tool message per result.
            for r in results:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": r.tool_use_id,
                        "content": "".join(c.text for c in r.content if c.type == "text"),
                    }
                )
            if text or images:
                if images:
                    parts: list[dict[str, Any]] = []
                    if text:
                        parts.append({"type": "text", "text": text})
                    for img in images:
                        url = (
                            img.data
                            if img.source_kind == "url"
                            else f"data:{img.media_type or 'image/png'};base64,{img.data}"
                        )
                        parts.append({"type": "image_url", "image_url": {"url": url}})
                    messages.append({"role": "user", "content": parts})
                else:
                    messages.append({"role": "user", "content": text})
            continue

        assistant: dict[str, Any] = {"role": "assistant", "content": text or None}
        if tool_calls:
            assistant["tool_calls"] = tool_calls
        messages.append(assistant)

    body: dict[str, Any] = {"model": req.model_id or req.alias, "messages": messages}
    if req.max_tokens is not None:
        body["max_completion_tokens"] = req.max_tokens
    if req.tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema or {"type": "object", "properties": {}},
                    **({"strict": t.strict} if t.strict is not None else {}),
                },
            }
            for t in req.tools
            if not t.server_type
        ]

    tc = req.tool_choice
    if tc.mode == "any":
        body["tool_choice"] = "required"
    elif tc.mode == "none":
        body["tool_choice"] = "none"
    elif tc.mode == "specific":
        body["tool_choice"] = {"type": "function", "function": {"name": tc.name}}
    if tc.disable_parallel:
        body["parallel_tool_calls"] = False

    s = req.sampling
    if s.temperature is not None:
        body["temperature"] = s.temperature
    if s.top_p is not None:
        body["top_p"] = s.top_p
    if s.stop_sequences:
        body["stop"] = s.stop_sequences
    if s.seed is not None:
        body["seed"] = s.seed
    if s.frequency_penalty is not None:
        body["frequency_penalty"] = s.frequency_penalty
    if s.presence_penalty is not None:
        body["presence_penalty"] = s.presence_penalty
    if req.reasoning.effort:
        body["reasoning_effort"] = req.reasoning.effort
    if req.response_format:
        body["response_format"] = _response_format(req.response_format)

    body.update(req.extra)
    return body
