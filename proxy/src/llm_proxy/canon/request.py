"""Canonical request: content blocks, messages, tools, and generation knobs."""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

# --------------------------------------------------------------------------- blocks


class _Block(BaseModel):
    model_config = ConfigDict(extra="allow")


class TextBlock(_Block):
    type: Literal["text"] = "text"
    text: str
    # Anthropic prompt-caching marker. Opaque to the proxy; passed through so callers
    # that already tuned their breakpoints keep their cache hits.
    cache_control: dict[str, Any] | None = None


class ThinkingBlock(_Block):
    type: Literal["thinking"] = "thinking"
    # Empty string when the model ran with display="omitted" (the default on Opus 5,
    # Opus 4.7/4.8, Sonnet 5 and Fable 5). An empty thinking block is normal, not a bug.
    thinking: str = ""
    # Opaque and integrity-checked upstream. MUST round-trip byte-identical: the API
    # rejects modified thinking blocks when continuing a conversation on the same model.
    signature: str | None = None


class RedactedThinkingBlock(_Block):
    type: Literal["redacted_thinking"] = "redacted_thinking"
    data: str


class ImageBlock(_Block):
    type: Literal["image"] = "image"
    source_kind: Literal["base64", "url"]
    media_type: str | None = None  # required when source_kind == "base64"
    data: str  # base64 payload, or the URL


class ToolUseBlock(_Block):
    type: Literal["tool_use"] = "tool_use"
    # Provider-assigned (Anthropic `toolu_*`, OpenAI `call_*`). Passed through verbatim
    # in both directions — regenerating it breaks the tool_use/tool_result pairing and
    # earns an opaque upstream 400.
    id: str
    name: str
    # ALWAYS a parsed dict. OpenAI carries this as a JSON *string* in
    # `function.arguments`; the inbound translator parses it and the outbound one
    # re-serialises. Keeping it parsed in the middle is what stops double-encoding.
    input: dict[str, Any] = Field(default_factory=dict)


class ToolResultBlock(_Block):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: list["ContentBlock"] = Field(default_factory=list)
    is_error: bool = False


class OpaqueBlock(_Block):
    """A block the proxy does not model, carried through byte-for-byte.

    Anthropic keeps adding block types (`document`, `search_result`,
    `web_search_tool_result`, `container_upload`, ...). A closed union would silently
    drop them, which is worse than not understanding them: an Anthropic->Anthropic
    round-trip through the proxy would quietly corrupt the conversation. Instead the
    original JSON is parked in `payload` and re-emitted verbatim on the way out.
    Only the Anthropic wire can carry these; the OpenAI edge drops them with a warning.
    """

    type: Literal["opaque"] = "opaque"
    original_type: str
    payload: dict[str, Any] = Field(default_factory=dict)


ContentBlock = Annotated[
    Union[
        TextBlock,
        ThinkingBlock,
        RedactedThinkingBlock,
        ImageBlock,
        ToolUseBlock,
        ToolResultBlock,
        OpaqueBlock,
    ],
    Field(discriminator="type"),
]

ToolResultBlock.model_rebuild()


# ------------------------------------------------------------------------- messages


class CanonMessage(BaseModel):
    """A conversation turn.

    `role` is only user/assistant. There is deliberately no "system" role (system text
    lives in `CanonRequest.system`) and no "tool" role (OpenAI's `role:"tool"` messages
    normalise into `ToolResultBlock`s inside a user turn). Normalising both away at the
    edge means no provider adapter has to think about them.
    """

    role: Literal["user", "assistant"]
    content: list[ContentBlock] = Field(default_factory=list)

    def text(self) -> str:
        return "".join(b.text for b in self.content if isinstance(b, TextBlock))


# ---------------------------------------------------------------------------- tools


class CanonTool(BaseModel):
    name: str
    description: str = ""
    # JSON Schema. Anthropic calls this `input_schema`; OpenAI nests the identical
    # object at `function.parameters`.
    input_schema: dict[str, Any] = Field(default_factory=dict)
    strict: bool | None = None
    # Set for Anthropic server-side tools (web_search_20260209, code_execution_*, ...),
    # which have no schema and execute upstream. Providers that can't host them reject.
    server_type: str | None = None


class ToolChoice(BaseModel):
    # "any" is Anthropic's name for OpenAI's "required".
    mode: Literal["auto", "any", "none", "specific"] = "auto"
    name: str | None = None  # set iff mode == "specific"
    disable_parallel: bool = False


# ---------------------------------------------------------------------------- knobs


class Sampling(BaseModel):
    """Sampling parameters. Every field is Optional and that is load-bearing.

    `None` means "the client did not ask for this"; a set value means "the client
    asked". capabilities.py needs the distinction: it must strip a caller-supplied
    `temperature` before it reaches a model that 400s on it, but must not invent one
    for a model that would accept it.
    """

    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    stop_sequences: list[str] = Field(default_factory=list)
    seed: int | None = None
    frequency_penalty: float | None = None
    presence_penalty: float | None = None


class Reasoning(BaseModel):
    """One unified thinking/reasoning knob, mapped per provider.

    `mode="auto"` means the client said nothing, which is NOT the same as "off" —
    on Opus 5 omitting `thinking` runs adaptive thinking, so "auto" and "off" produce
    materially different requests and bills.
    """

    mode: Literal["auto", "on", "off"] = "auto"
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    # Legacy input only. Honoured on models that still accept budget_tokens
    # (Opus 4.6, Sonnet 4.6, Haiku 4.5); translated to `effort` elsewhere.
    budget_tokens: int | None = None
    display: Literal["omitted", "summarized"] | None = None


# -------------------------------------------------------------------------- request


class CanonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # --- routing -----------------------------------------------------------------
    alias: str  # exactly what the client put in `model`
    provider: str = ""  # resolved by routing.py
    model_id: str = ""  # resolved by routing.py

    # --- payload -----------------------------------------------------------------
    system: list[TextBlock] = Field(default_factory=list)
    messages: list[CanonMessage] = Field(default_factory=list)
    tools: list[CanonTool] = Field(default_factory=list)
    tool_choice: ToolChoice = Field(default_factory=ToolChoice)

    # --- generation ---------------------------------------------------------------
    max_tokens: int | None = None
    stream: bool = False
    sampling: Sampling = Field(default_factory=Sampling)
    reasoning: Reasoning = Field(default_factory=Reasoning)
    response_format: dict[str, Any] | None = None

    # --- proxy metadata -----------------------------------------------------------
    project: str = "unattributed"
    request_id: str = ""
    # Unrecognised provider-specific fields, passed through untouched.
    extra: dict[str, Any] = Field(default_factory=dict)
    # Populated by capabilities.normalize(); surfaced as X-LLM-Proxy-Warnings.
    warnings: list[str] = Field(default_factory=list)

    def route(self) -> str:
        return f"{self.provider}/{self.model_id}"
