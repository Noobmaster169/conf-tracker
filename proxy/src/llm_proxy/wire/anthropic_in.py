"""Anthropic Messages API JSON -> CanonRequest.

Near-identity, because the canonical IR is Anthropic-shaped. The only real work is
normalising `system` into a block list and folding stray system-role messages.
"""

from __future__ import annotations

from typing import Any

from ..canon.request import (
    CanonMessage,
    CanonRequest,
    CanonTool,
    ContentBlock,
    ImageBlock,
    OpaqueBlock,
    Reasoning,
    RedactedThinkingBlock,
    Sampling,
    TextBlock,
    ThinkingBlock,
    ToolChoice,
    ToolResultBlock,
    ToolUseBlock,
)
from ..errors import InvalidRequest

_KNOWN_BLOCKS = {
    "text",
    "image",
    "tool_use",
    "tool_result",
    "thinking",
    "redacted_thinking",
}


def _block(raw: Any) -> ContentBlock:
    if isinstance(raw, str):
        return TextBlock(text=raw)
    if not isinstance(raw, dict):
        raise InvalidRequest(f"content block must be a string or object, got {type(raw).__name__}")

    kind = raw.get("type")
    if kind == "text":
        return TextBlock(text=raw.get("text", ""), cache_control=raw.get("cache_control"))
    if kind == "thinking":
        return ThinkingBlock(
            thinking=raw.get("thinking", "") or "", signature=raw.get("signature")
        )
    if kind == "redacted_thinking":
        return RedactedThinkingBlock(data=raw.get("data", ""))
    if kind == "image":
        src = raw.get("source") or {}
        if src.get("type") == "url":
            return ImageBlock(source_kind="url", data=src.get("url", ""))
        return ImageBlock(
            source_kind="base64",
            media_type=src.get("media_type"),
            data=src.get("data", ""),
        )
    if kind == "tool_use":
        tool_input = raw.get("input")
        return ToolUseBlock(
            id=raw.get("id", ""),
            name=raw.get("name", ""),
            input=tool_input if isinstance(tool_input, dict) else {},
        )
    if kind == "tool_result":
        content = raw.get("content")
        if isinstance(content, str):
            inner: list[ContentBlock] = [TextBlock(text=content)]
        elif isinstance(content, list):
            inner = [_block(c) for c in content]
        else:
            inner = []
        return ToolResultBlock(
            tool_use_id=raw.get("tool_use_id", ""),
            content=inner,
            is_error=bool(raw.get("is_error", False)),
        )

    # Anything else (document, search_result, web_search_tool_result, ...) survives
    # untouched rather than being dropped.
    return OpaqueBlock(original_type=str(kind), payload=raw)


def _system(raw: Any) -> list[TextBlock]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [TextBlock(text=raw)] if raw else []
    if isinstance(raw, list):
        out: list[TextBlock] = []
        for item in raw:
            if isinstance(item, str):
                out.append(TextBlock(text=item))
            elif isinstance(item, dict) and item.get("type") == "text":
                out.append(
                    TextBlock(text=item.get("text", ""), cache_control=item.get("cache_control"))
                )
        return out
    raise InvalidRequest("`system` must be a string or a list of text blocks")


def _tools(raw: Any) -> list[CanonTool]:
    if not raw:
        return []
    out: list[CanonTool] = []
    for t in raw:
        if not isinstance(t, dict):
            continue
        # Server-side tools carry a versioned `type` and no schema; they execute
        # upstream, so only providers that host them can honour the request.
        if "input_schema" not in t and t.get("type"):
            out.append(CanonTool(name=t.get("name", ""), server_type=t["type"]))
            continue
        out.append(
            CanonTool(
                name=t.get("name", ""),
                description=t.get("description", "") or "",
                input_schema=t.get("input_schema") or {},
                strict=t.get("strict"),
            )
        )
    return out


def _tool_choice(raw: Any) -> ToolChoice:
    if not isinstance(raw, dict):
        return ToolChoice()
    kind = raw.get("type", "auto")
    disable = bool(raw.get("disable_parallel_tool_use", False))
    if kind == "tool":
        return ToolChoice(mode="specific", name=raw.get("name"), disable_parallel=disable)
    if kind in ("auto", "any", "none"):
        return ToolChoice(mode=kind, disable_parallel=disable)
    return ToolChoice(disable_parallel=disable)


def _reasoning(body: dict[str, Any]) -> Reasoning:
    thinking = body.get("thinking")
    output_config = body.get("output_config") or {}
    effort = output_config.get("effort")

    if thinking is None:
        # Absent means "client said nothing" — NOT "off". On Opus 5 an omitted
        # `thinking` runs adaptive thinking, so collapsing auto->off here would
        # silently change both behaviour and cost.
        return Reasoning(mode="auto", effort=effort)

    kind = thinking.get("type") if isinstance(thinking, dict) else None
    display = thinking.get("display") if isinstance(thinking, dict) else None
    if kind == "disabled":
        return Reasoning(mode="off", effort=effort, display=display)
    if kind == "enabled":
        return Reasoning(
            mode="on",
            effort=effort,
            budget_tokens=thinking.get("budget_tokens"),
            display=display,
        )
    return Reasoning(mode="on", effort=effort, display=display)


def parse(body: dict[str, Any]) -> CanonRequest:
    if not isinstance(body, dict):
        raise InvalidRequest("request body must be a JSON object")
    alias = body.get("model")
    if not alias:
        raise InvalidRequest("`model` is required")
    raw_messages = body.get("messages")
    if not isinstance(raw_messages, list):
        raise InvalidRequest("`messages` is required and must be a list")

    system = _system(body.get("system"))
    messages: list[CanonMessage] = []

    for m in raw_messages:
        if not isinstance(m, dict):
            raise InvalidRequest("each message must be an object")
        role = m.get("role")
        content = m.get("content")
        blocks = (
            [TextBlock(text=content)]
            if isinstance(content, str)
            else [_block(c) for c in (content or [])]
        )

        if role == "system":
            # Leading system turns merge into the top-level field. A mid-conversation
            # one is model-gated upstream and cannot be message[0], so it degrades to
            # a marked user turn — stable under a second pass, so round-trips stay
            # idempotent.
            if not messages:
                system.extend(b for b in blocks if isinstance(b, TextBlock))
                continue
            blocks = [
                TextBlock(text=f"[system] {b.text}") if isinstance(b, TextBlock) else b
                for b in blocks
            ]
            role = "user"

        if role not in ("user", "assistant"):
            raise InvalidRequest(f"unsupported message role {role!r}")
        messages.append(CanonMessage(role=role, content=blocks))

    known = {
        "model", "messages", "system", "tools", "tool_choice", "max_tokens", "stream",
        "temperature", "top_p", "top_k", "stop_sequences", "thinking", "output_config",
        "metadata", "betas", "anthropic_version",
    }

    return CanonRequest(
        alias=alias,
        system=system,
        messages=messages,
        tools=_tools(body.get("tools")),
        tool_choice=_tool_choice(body.get("tool_choice")),
        max_tokens=body.get("max_tokens"),
        stream=bool(body.get("stream", False)),
        sampling=Sampling(
            temperature=body.get("temperature"),
            top_p=body.get("top_p"),
            top_k=body.get("top_k"),
            stop_sequences=list(body.get("stop_sequences") or []),
        ),
        reasoning=_reasoning(body),
        response_format=(body.get("output_config") or {}).get("format"),
        extra={k: v for k, v in body.items() if k not in known},
    )
