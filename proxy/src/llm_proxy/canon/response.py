"""Canonical response and usage."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .request import ContentBlock


class StopReason(str, Enum):
    """Why generation stopped.

    Superset of both wires. `refusal`, `pause_turn` and `model_context_window_exceeded`
    have no OpenAI equivalent and are mapped lossily on the way out (see wire/openai_out).
    """

    END_TURN = "end_turn"
    TOOL_USE = "tool_use"
    MAX_TOKENS = "max_tokens"
    STOP_SEQUENCE = "stop_sequence"
    REFUSAL = "refusal"
    PAUSE_TURN = "pause_turn"
    CONTEXT_EXCEEDED = "model_context_window_exceeded"
    ERROR = "error"


class CanonUsage(BaseModel):
    model_config = ConfigDict(extra="allow")

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    reasoning_tokens: int = 0
    # claude-cli reports `total_cost_usd` directly, and it is what X-LLM-Proxy-Cost-USD
    # carries. Note this is a *counterfactual* number for the subscription rail (what
    # the call would have cost via API): no money leaves the account.
    reported_cost_usd: float | None = None

    def merge(self, other: "CanonUsage") -> "CanonUsage":
        return CanonUsage(
            input_tokens=self.input_tokens or other.input_tokens,
            output_tokens=self.output_tokens or other.output_tokens,
            cache_read_input_tokens=self.cache_read_input_tokens
            or other.cache_read_input_tokens,
            cache_creation_input_tokens=self.cache_creation_input_tokens
            or other.cache_creation_input_tokens,
            reasoning_tokens=self.reasoning_tokens or other.reasoning_tokens,
            reported_cost_usd=(
                self.reported_cost_usd
                if self.reported_cost_usd is not None
                else other.reported_cost_usd
            ),
        )


class CanonResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    provider: str
    model_id: str
    alias: str = ""
    # MAY legitimately be empty: a classifier refusal returns HTTP 200 with no content
    # blocks at all. Anything that indexes content[0] unconditionally will crash here.
    content: list[ContentBlock] = Field(default_factory=list)
    stop_reason: StopReason = StopReason.END_TURN
    stop_sequence: str | None = None
    # Populated ONLY when stop_reason == refusal ({type, category, explanation});
    # null for every other stop reason. Branch on stop_reason, never on this.
    stop_details: dict[str, Any] | None = None
    usage: CanonUsage = Field(default_factory=CanonUsage)

    cost_usd: float = 0.0
    warnings: list[str] = Field(default_factory=list)

    def text(self) -> str:
        return "".join(b.text for b in self.content if b.type == "text")

    def tool_uses(self) -> list[Any]:
        return [b for b in self.content if b.type == "tool_use"]
