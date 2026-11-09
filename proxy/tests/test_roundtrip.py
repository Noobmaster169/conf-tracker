"""Round-trip property tests for the Anthropic wire edge.

`anthropic_in -> canon -> anthropic_out -> anthropic_in` must be idempotent: a request
surviving a trip through the proxy comes out semantically identical.
"""

from __future__ import annotations

import pytest

from llm_proxy.canon.request import CanonRequest
from llm_proxy.errors import InvalidRequest
from llm_proxy.wire import anthropic_in, anthropic_out

CASES = {
    "plain_text": {
        "model": "m",
        "max_tokens": 100,
        "messages": [{"role": "user", "content": "hello"}],
    },
    "system_prompt": {
        "model": "m",
        "max_tokens": 100,
        "system": "You are terse.",
        "messages": [{"role": "user", "content": "hi"}],
    },
    "system_blocks_with_cache": {
        "model": "m",
        "max_tokens": 100,
        "system": [
            {"type": "text", "text": "big preamble", "cache_control": {"type": "ephemeral"}}
        ],
        "messages": [{"role": "user", "content": "hi"}],
    },
    "multi_turn": {
        "model": "m",
        "max_tokens": 100,
        "messages": [
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "three"},
        ],
    },
    "single_tool": {
        "model": "m",
        "max_tokens": 100,
        "tools": [
            {
                "name": "get_weather",
                "description": "weather",
                "input_schema": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            }
        ],
        "messages": [
            {"role": "user", "content": "weather in Paris?"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "checking"},
                    {"type": "tool_use", "id": "toolu_1", "name": "get_weather",
                     "input": {"city": "Paris"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "18C"}
                ],
            },
        ],
    },
    "parallel_tools": {
        "model": "m",
        "max_tokens": 100,
        "messages": [
            {"role": "user", "content": "weather in both?"},
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "toolu_1", "name": "w", "input": {"c": "Paris"}},
                    {"type": "tool_use", "id": "toolu_2", "name": "w", "input": {"c": "London"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "18C"},
                    {"type": "tool_result", "tool_use_id": "toolu_2", "content": "12C"},
                ],
            },
        ],
    },
    "tool_error_result": {
        "model": "m",
        "max_tokens": 100,
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "toolu_1", "name": "w", "input": {}}],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1",
                     "content": "boom", "is_error": True}
                ],
            },
        ],
    },
    "image_base64": {
        "model": "m",
        "max_tokens": 100,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64",
                     "media_type": "image/png", "data": "AAAA"}},
                    {"type": "text", "text": "what is this?"},
                ],
            }
        ],
    },
    "thinking_echo": {
        "model": "m",
        "max_tokens": 100,
        "messages": [
            {"role": "user", "content": "hard question"},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "reasoning", "signature": "sig_abc"},
                    {"type": "text", "text": "answer"},
                ],
            },
            {"role": "user", "content": "follow up"},
        ],
    },
    "opaque_block": {
        "model": "m",
        "max_tokens": 100,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "document", "source": {"type": "text", "data": "hello"},
                     "title": "doc"},
                    {"type": "text", "text": "summarise"},
                ],
            }
        ],
    },
    "tool_choice_specific": {
        "model": "m",
        "max_tokens": 100,
        "tools": [{"name": "w", "description": "", "input_schema": {"type": "object"}}],
        "tool_choice": {"type": "tool", "name": "w"},
        "messages": [{"role": "user", "content": "go"}],
    },
    "sampling_and_thinking": {
        "model": "m",
        "max_tokens": 100,
        "temperature": 0.5,
        "top_p": 0.9,
        "stop_sequences": ["END"],
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": "high"},
        "messages": [{"role": "user", "content": "go"}],
    },
}


def _payload(req: CanonRequest) -> dict:
    """The semantic content of a request, ignoring proxy bookkeeping."""
    return req.model_dump(exclude={"request_id", "project", "warnings", "provider", "model_id"})


@pytest.mark.parametrize("name", sorted(CASES))
def test_roundtrip_is_idempotent(name):
    body = CASES[name]
    once = anthropic_in.parse(body)
    rebuilt = anthropic_out.build_request(once)
    twice = anthropic_in.parse(rebuilt)
    assert _payload(once) == _payload(twice), f"{name} lost or mutated content"


def test_system_string_becomes_one_text_block():
    req = anthropic_in.parse(CASES["system_prompt"])
    assert [b.text for b in req.system] == ["You are terse."]


def test_leading_system_message_merges_into_system():
    req = anthropic_in.parse({
        "model": "m", "max_tokens": 1,
        "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "q"}],
    })
    assert [b.text for b in req.system] == ["sys"]
    assert [m.role for m in req.messages] == ["user"]


def test_thinking_signature_survives_roundtrip():
    """Signatures are integrity-checked upstream; a mutated one is rejected."""
    req = anthropic_in.parse(CASES["thinking_echo"])
    rebuilt = anthropic_out.build_request(req)
    assistant = next(m for m in rebuilt["messages"] if m["role"] == "assistant")
    thinking = next(b for b in assistant["content"] if b["type"] == "thinking")
    assert thinking["signature"] == "sig_abc"


def test_unknown_block_types_survive_as_opaque():
    req = anthropic_in.parse(CASES["opaque_block"])
    blocks = req.messages[0].content
    assert blocks[0].type == "opaque" and blocks[0].original_type == "document"
    rebuilt = anthropic_out.build_request(req)
    assert rebuilt["messages"][0]["content"][0] == {
        "type": "document",
        "source": {"type": "text", "data": "hello"},
        "title": "doc",
    }


def test_unmatched_tool_use_is_caught():
    body = {
        "model": "m",
        "max_tokens": 10,
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "toolu_1", "name": "w", "input": {}}],
            },
            {"role": "user", "content": "never answered the tool"},
        ],
    }
    req = anthropic_in.parse(body)
    with pytest.raises(InvalidRequest) as exc:
        anthropic_out.build_request(req)
    assert "toolu_1" in str(exc.value)


def test_absent_thinking_is_auto_not_off():
    """`auto` and `off` are different requests: an omitted `thinking` must not be
    rewritten as `disabled`."""
    req = anthropic_in.parse(CASES["plain_text"])
    assert req.reasoning.mode == "auto"
    assert "thinking" not in anthropic_out.build_request(req)

    off = anthropic_in.parse({**CASES["plain_text"], "thinking": {"type": "disabled"}})
    assert off.reasoning.mode == "off"
    assert anthropic_out.build_request(off)["thinking"] == {"type": "disabled"}


def test_effort_is_nested_under_output_config():
    req = anthropic_in.parse(CASES["sampling_and_thinking"])
    body = anthropic_out.build_request(req)
    assert body["output_config"]["effort"] == "high"
    assert "effort" not in body


def test_unknown_top_level_fields_pass_through_in_extra():
    req = anthropic_in.parse({**CASES["plain_text"], "service_tier": "auto"})
    assert req.extra == {"service_tier": "auto"}


@pytest.mark.parametrize("body,fragment", [
    ({"messages": []}, "`model` is required"),
    ({"model": "m"}, "`messages` is required"),
    ({"model": "m", "messages": [{"role": "tool", "content": "x"}]}, "unsupported message role"),
    ({"model": "m", "messages": [], "system": 3}, "`system` must be"),
])
def test_malformed_requests_are_invalid_request(body, fragment):
    with pytest.raises(InvalidRequest) as exc:
        anthropic_in.parse(body)
    assert fragment in str(exc.value)
