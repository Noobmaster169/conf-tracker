"""Anthropic response rendering and the aggregate/explode inverse."""

from __future__ import annotations

import pytest

from llm_proxy.canon.request import TextBlock, ThinkingBlock, ToolUseBlock
from llm_proxy.canon.response import CanonResponse, CanonUsage, StopReason
from llm_proxy.canon.stream import aggregate, explode
from llm_proxy.wire import anthropic_out


def _resp(**kw) -> CanonResponse:
    base = dict(
        id="msg_1",
        provider="mock",
        model_id="m",
        usage=CanonUsage(input_tokens=10, output_tokens=5),
    )
    base.update(kw)
    return CanonResponse(**base)


# ------------------------------------------------------------------ explode/aggregate

RESPONSES = {
    "text": _resp(content=[TextBlock(text="hello world")]),
    "empty": _resp(content=[]),
    "refusal": _resp(
        content=[],
        stop_reason=StopReason.REFUSAL,
        stop_details={"type": "refusal", "category": "cyber", "explanation": "no"},
    ),
    "tool": _resp(
        content=[
            TextBlock(text="checking"),
            ToolUseBlock(id="toolu_1", name="w", input={"city": "Paris"}),
        ],
        stop_reason=StopReason.TOOL_USE,
    ),
    "parallel_tools": _resp(
        content=[
            ToolUseBlock(id="toolu_1", name="w", input={"c": "Paris"}),
            ToolUseBlock(id="toolu_2", name="w", input={"c": "London"}),
        ],
        stop_reason=StopReason.TOOL_USE,
    ),
    "thinking": _resp(
        content=[
            ThinkingBlock(thinking="hmm", signature="sig_1"),
            TextBlock(text="answer"),
        ]
    ),
    "max_tokens": _resp(content=[TextBlock(text="trunc")], stop_reason=StopReason.MAX_TOKENS),
}


@pytest.mark.parametrize("name", sorted(RESPONSES))
def test_explode_aggregate_is_identity(name):
    """A BlockingOnly provider streams via explode(); a StreamOnly one blocks via aggregate()."""
    original = RESPONSES[name]
    rebuilt = aggregate(explode(original))
    assert [b.model_dump() for b in rebuilt.content] == [
        b.model_dump() for b in original.content
    ]
    assert rebuilt.stop_reason == original.stop_reason
    assert rebuilt.stop_details == original.stop_details
    assert rebuilt.usage.output_tokens == original.usage.output_tokens


def test_aggregate_tolerates_truncation():
    """A client disconnect must still yield the blocks that completed."""
    events = explode(RESPONSES["text"])[:3]  # message_start, block_start, text_delta
    partial = aggregate(events)
    assert partial.content[0].text == "hello world"


def test_aggregate_preserves_unparseable_tool_json():
    from llm_proxy.canon.stream import (
        BlockStart, BlockStop, MessageStart, ToolInputDelta,
    )

    events = [
        MessageStart(id="m"),
        BlockStart(index=0, block=ToolUseBlock(id="t1", name="w", input={})),
        ToolInputDelta(index=0, partial_json="{broken"),
        BlockStop(index=0),
    ]
    resp = aggregate(events)
    assert resp.content[0].input == {"__raw": "{broken"}


# ------------------------------------------------------------------ render: anthropic


def test_anthropic_render_keeps_blocks_and_stop_details():
    body = anthropic_out.render(RESPONSES["refusal"])
    assert body["stop_reason"] == "refusal"
    assert body["content"] == []
    assert body["stop_details"]["category"] == "cyber"


def test_anthropic_render_nulls_stop_details_when_not_a_refusal():
    """Upstream leaves stop_details null for every non-refusal; match that exactly."""
    assert anthropic_out.render(RESPONSES["text"])["stop_details"] is None


# ------------------------------------------------------------------------- streaming


def test_anthropic_stream_names_every_frame():
    frames = list(anthropic_out.stream(explode(RESPONSES["tool"]), "r", "m"))
    names = [name for name, _ in frames]
    assert names[0] == "message_start"
    assert names[-1] == "message_stop"
    assert "content_block_delta" in names
    # An Anthropic SDK ignores unnamed frames outright.
    assert all(name for name, _ in frames)


def test_anthropic_stream_tool_input_uses_input_json_delta():
    frames = list(anthropic_out.stream(explode(RESPONSES["tool"]), "r", "m"))
    deltas = [d for n, d in frames if n == "content_block_delta"]
    kinds = {d["delta"]["type"] for d in deltas}
    assert "input_json_delta" in kinds
