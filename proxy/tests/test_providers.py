"""Provider adapters, exercised without network or spend.

Ollama (openai_compatible) goes through httpx.MockTransport; claude-cli goes through
a real executable stub placed on PATH.
"""

from __future__ import annotations

import base64
import json
import os
import stat
import sys
import textwrap

import httpx
import pytest

from llm_proxy.canon.request import CanonMessage, CanonRequest, ImageBlock, TextBlock
from llm_proxy.canon.stream import aggregate
from llm_proxy.config import ProviderConfig
from llm_proxy.errors import (
    InvalidRequest,
    ProviderError,
    ProviderNotLoggedIn,
    ProviderTimeout,
    RateLimited,
)
from llm_proxy.providers.claude_cli import (
    ClaudeCliProvider,
    child_env,
    cli_args,
    failure_detail,
    flatten,
    partial_text,
    write_images,
    starts_attempt,
    tool_args,
)
from llm_proxy.providers.retry import is_login_failure
from llm_proxy.providers.openai_api import OpenAIProvider


def canon_req(provider: str, model_id: str, **kw) -> CanonRequest:
    base = dict(
        alias="a",
        provider=provider,
        model_id=model_id,
        request_id="req_test",
        max_tokens=100,
        messages=[CanonMessage(role="user", content=[TextBlock(text="hello")])],
    )
    base.update(kw)
    return CanonRequest(**base)


# ---------------------------------------------------------------------- ollama

OLLAMA = "http://127.0.0.1:11434/v1"


def ollama_provider(handler, **cfg) -> OpenAIProvider:
    p = OpenAIProvider("ollama", ProviderConfig(type="openai_compatible", base_url=OLLAMA, **cfg))
    p._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=OLLAMA)
    return p


def openai_sse(*chunks: dict) -> bytes:
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks)
    return (body + "data: [DONE]\n\n").encode()


async def test_stream_decodes_text_and_usage():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        # StreamOnly always streams upstream, with usage requested — it is the only
        # reliable way to get token counts off the OpenAI wire.
        assert body["stream"] is True
        assert body["stream_options"] == {"include_usage": True}
        assert body["messages"] == [{"role": "user", "content": "hello"}]
        return httpx.Response(200, content=openai_sse(
            {"id": "c1", "model": "qwen3:14b",
             "choices": [{"index": 0, "delta": {"role": "assistant", "content": "He"}}]},
            {"id": "c1", "model": "qwen3:14b",
             "choices": [{"index": 0, "delta": {"content": "llo"}}]},
            {"id": "c1", "model": "qwen3:14b",
             "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            {"id": "c1", "model": "qwen3:14b", "choices": [],
             "usage": {"prompt_tokens": 4, "completion_tokens": 2}},
        ), headers={"content-type": "text/event-stream"})

    resp = await ollama_provider(handler).complete(canon_req("ollama", "qwen3:14b"))
    assert resp.text() == "Hello"
    assert resp.usage.input_tokens == 4
    assert resp.usage.output_tokens == 2
    assert resp.stop_reason.value == "end_turn"


async def test_renames_the_output_cap_and_merges_extra_body():
    """Ollama 0.32 parses `max_completion_tokens`, ignores it, and generates to the
    context wall. It honours `max_tokens`. And `reasoning_effort: none` is the only
    switch that turns Qwen 3's thinking off — without it `content` comes back empty
    with the reasoning in a field no Anthropic-shaped client reads."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, content=openai_sse(
            {"id": "c1", "model": "qwen3", "choices": [
                {"index": 0, "delta": {"role": "assistant", "content": "ok"}}]},
            {"id": "c1", "model": "qwen3", "choices": [
                {"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ), headers={"content-type": "text/event-stream"})

    p = ollama_provider(
        handler, max_tokens_field="max_tokens", extra_body={"reasoning_effort": "none"}
    )
    await p.complete(canon_req("ollama", "qwen3:14b-ctx16k"))

    assert seen["max_tokens"] == 100
    assert "max_completion_tokens" not in seen
    assert seen["reasoning_effort"] == "none"


async def test_keeps_the_new_output_cap_name_by_default():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, content=openai_sse(
            {"id": "c1", "model": "m", "choices": [
                {"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ), headers={"content-type": "text/event-stream"})

    await ollama_provider(handler).complete(canon_req("ollama", "m"))

    assert seen["max_completion_tokens"] == 100
    assert "max_tokens" not in seen
    assert "reasoning_effort" not in seen


async def test_system_prompt_becomes_a_system_message():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, content=openai_sse(
            {"id": "c1", "model": "m", "choices": [
                {"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ), headers={"content-type": "text/event-stream"})

    await ollama_provider(handler).complete(
        canon_req("ollama", "m", system=[TextBlock(text="Be terse.")])
    )
    assert seen["messages"][0] == {"role": "system", "content": "Be terse."}


async def test_stream_decodes_parallel_tool_calls():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=openai_sse(
            {"id": "c", "model": "m", "choices": [{"index": 0, "delta": {
                "tool_calls": [{"index": 0, "id": "call_a", "type": "function",
                                "function": {"name": "w", "arguments": ""}}]}}]},
            {"id": "c", "model": "m", "choices": [{"index": 0, "delta": {
                "tool_calls": [{"index": 1, "id": "call_b", "type": "function",
                                "function": {"name": "w", "arguments": ""}}]}}]},
            {"id": "c", "model": "m", "choices": [{"index": 0, "delta": {
                "tool_calls": [{"index": 0,
                                "function": {"arguments": '{"c":"Paris"}'}}]}}]},
            {"id": "c", "model": "m", "choices": [{"index": 0, "delta": {
                "tool_calls": [{"index": 1,
                                "function": {"arguments": '{"c":"London"}'}}]}}]},
            {"id": "c", "model": "m",
             "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
        ), headers={"content-type": "text/event-stream"})

    resp = await ollama_provider(handler).complete(canon_req("ollama", "m"))
    uses = resp.tool_uses()
    assert [u.id for u in uses] == ["call_a", "call_b"]
    assert uses[0].input == {"c": "Paris"}
    assert uses[1].input == {"c": "London"}
    assert resp.stop_reason.value == "tool_use"


async def test_reasoning_content_becomes_a_thinking_block():
    """If Ollama does emit reasoning, it lands in a thinking block — never in text."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=openai_sse(
            {"id": "c", "model": "m", "choices": [
                {"index": 0, "delta": {"reasoning": "thinking..."}}]},
            {"id": "c", "model": "m", "choices": [
                {"index": 0, "delta": {"content": "answer"}}]},
            {"id": "c", "model": "m",
             "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ), headers={"content-type": "text/event-stream"})

    resp = await ollama_provider(handler).complete(canon_req("ollama", "m"))
    assert [b.type for b in resp.content] == ["thinking", "text"]
    assert resp.text() == "answer"


async def test_needs_no_api_key():
    """Local Ollama wants no auth; api_key_env: null must be legitimate."""
    p = OpenAIProvider(
        "ollama", ProviderConfig(type="openai_compatible", base_url=OLLAMA, api_key_env=None)
    )
    assert "authorization" not in p.client().headers
    await p.aclose()


async def test_missing_key_says_which_env_var(monkeypatch):
    monkeypatch.delenv("NOPE_KEY", raising=False)
    p = OpenAIProvider(
        "x", ProviderConfig(type="openai_compatible", base_url=OLLAMA, api_key_env="NOPE_KEY")
    )
    with pytest.raises(ProviderError) as exc:
        p.client()
    assert "NOPE_KEY" in str(exc.value)


async def test_connection_failure_is_a_provider_error():
    """No Ollama running: a clean 502 envelope, not a traceback."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with pytest.raises(ProviderError) as exc:
        await ollama_provider(handler).complete(canon_req("ollama", "m"))
    assert "connection refused" in str(exc.value)


async def test_upstream_404_is_a_provider_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"message": "model 'nope' not found"}})

    with pytest.raises(ProviderError) as exc:
        await ollama_provider(handler).complete(canon_req("ollama", "nope"))
    assert "not found" in str(exc.value)


async def test_upstream_429_is_rate_limited_in_the_stream():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "slow down"}})

    events = [e async for e in ollama_provider(handler).stream(canon_req("ollama", "m"))]
    assert events[-1].type == "error"
    assert events[-1].code == "rate_limited"
    assert events[-1].retryable is True


# ------------------------------------------------------------------ claude-cli


@pytest.fixture
def fake_claude(tmp_path, monkeypatch):
    """A real executable named `claude` on PATH.

    It asserts ANTHROPIC_API_KEY is present-but-EMPTY. That exact distinction is the
    regression documented in claude_cli.child_env — a deleted key gets refilled by
    the child's own load_dotenv(), the CLI then warns that the API key takes
    precedence over the claude.ai login, and exits 1.

    On Windows the stub needs a PATHEXT extension and a launcher. Without them
    `shutil.which("claude")` walks past an extensionless file and finds the real
    `claude.EXE`, so every test here quietly drove the live CLI and spent real
    subscription tokens instead of exercising the stub.
    """
    def make(script: str) -> str:
        if os.name == "nt":
            stub = tmp_path / "claude_stub.py"
            # Explicit, because a stub carrying a non-ASCII byte written in the
            # console codepage is not the UTF-8 source Python then reads it as.
            stub.write_text(script, encoding="utf-8")
            launcher = tmp_path / "claude.bat"
            launcher.write_text(f'@echo off\r\n"{sys.executable}" "{stub}" %*\r\n')
            path = launcher
        else:
            path = tmp_path / "claude"
            path.write_text(script)
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
        return str(path)

    return make


SUCCESS_STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    key = os.environ.get("ANTHROPIC_API_KEY", "__ABSENT__")
    if key != "":
        sys.stderr.write(f"ANTHROPIC_API_KEY must be blank, got {key!r}\\n")
        sys.exit(3)
    sys.stdin.read()
    print(json.dumps({
        "subtype": "success", "is_error": False, "result": "cli said hello",
        "session_id": "sess_1", "total_cost_usd": 0.0123,
        "usage": {"input_tokens": 11, "output_tokens": 4},
    }))
""")

# `claude -p --output-format stream-json --verbose`: one JSON object per line.
STREAM_STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, sys
    args = sys.argv[1:]
    assert "stream-json" in args and "--verbose" in args, args
    assert "--include-partial-messages" in args, args
    assert args[args.index("--tools") + 1] == "", args
    assert args[args.index("--model") + 1] == "haiku", args
    prompt = sys.stdin.read()
    assert prompt.startswith("Be terse."), prompt
    print(json.dumps({"type": "system", "subtype": "init", "session_id": "sess_2"}))
    print(json.dumps({"type": "assistant", "message": {
        "content": [{"type": "text", "text": "proxy "}],
        "usage": {"input_tokens": 9, "output_tokens": 1}}}))
    print(json.dumps({"type": "assistant", "message": {
        "content": [{"type": "text", "text": "ok"}],
        "usage": {"input_tokens": 9, "output_tokens": 2}}}))
    print(json.dumps({"type": "result", "subtype": "success", "result": "proxy ok",
                      "total_cost_usd": 0.002, "session_id": "sess_2"}))
""")


async def test_blanks_the_api_key_rather_than_deleting_it(fake_claude, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-reach-the-child")
    fake_claude(SUCCESS_STUB)

    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    resp = await provider.complete(canon_req("claudecli", "opus"))
    assert resp.text() == "cli said hello"
    assert resp.id == "sess_1"
    assert resp.usage.reported_cost_usd == 0.0123
    assert resp.usage.input_tokens == 11


def test_child_env_blanks_not_removes(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-real")
    env = child_env(ProviderConfig(type="claudecli"))
    assert "ANTHROPIC_API_KEY" in env, "deleting lets the child's load_dotenv() refill it"
    assert env["ANTHROPIC_API_KEY"] == ""


def test_child_env_can_be_left_alone(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-real")
    env = child_env(ProviderConfig(type="claudecli", neutralise_anthropic_key=False))
    assert env["ANTHROPIC_API_KEY"] == "sk-ant-real"


async def test_native_stream_mode_reads_stream_json(fake_claude):
    fake_claude(STREAM_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    req = canon_req("claudecli", "haiku", system=[TextBlock(text="Be terse.")])
    events = [e async for e in provider.stream(req)]
    assert [e.type for e in events] == [
        "message_start", "block_start", "text_delta", "text_delta", "block_stop",
        "message_delta", "message_stop",
    ]
    resp = aggregate(events)
    assert resp.text() == "proxy ok"
    assert resp.usage.output_tokens == 2
    assert resp.usage.reported_cost_usd == 0.002


async def test_synthetic_stream_mode_explodes_the_json_envelope(fake_claude):
    fake_claude(SUCCESS_STUB)
    provider = ClaudeCliProvider(
        "claudecli", ProviderConfig(type="claudecli", stream_mode="synthetic")
    )
    events = [e async for e in provider.stream(canon_req("claudecli", "opus"))]
    assert events[0].type == "message_start" and events[-1].type == "message_stop"
    assert aggregate(events).text() == "cli said hello"


async def test_error_exit_is_surfaced(fake_claude):
    fake_claude(textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys
        sys.stdin.read()
        sys.stderr.write("something broke permanently\\n")
        sys.exit(1)
    """))
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    with pytest.raises(ProviderError) as exc:
        await provider.complete(canon_req("claudecli", "opus"))
    assert "something broke permanently" in str(exc.value)


async def test_rate_limit_is_classified_retryable(fake_claude):
    fake_claude(textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys
        sys.stdin.read()
        sys.stderr.write("Error: usage limit reached\\n")
        sys.exit(1)
    """))
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    from llm_proxy.providers import retry

    monkey = retry.BACKOFF_S
    retry.BACKOFF_S = (0,)
    try:
        with pytest.raises(RateLimited):
            await provider.complete(canon_req("claudecli", "opus"))
    finally:
        retry.BACKOFF_S = monkey


async def test_malformed_json_is_a_clear_error(fake_claude):
    fake_claude(textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys
        sys.stdin.read()
        print("not json at all")
    """))
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    with pytest.raises(ProviderError) as exc:
        await provider.complete(canon_req("claudecli", "opus"))
    assert "JSON envelope" in str(exc.value)


async def test_timeout_kills_the_child(fake_claude):
    fake_claude(textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys, time
        sys.stdin.read()
        time.sleep(30)
    """))
    provider = ClaudeCliProvider(
        "claudecli", ProviderConfig(type="claudecli", timeout_s=1)
    )
    with pytest.raises(ProviderTimeout):
        await provider.complete(canon_req("claudecli", "opus"))


async def test_missing_binary_is_a_clear_error(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path))
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    with pytest.raises(ProviderError) as exc:
        await provider.complete(canon_req("claudecli", "opus"))
    assert "not found on PATH" in str(exc.value)


def test_flatten_folds_system_into_the_prompt():
    """`claude -p` has no separate system field; it has to go into the body."""
    req = canon_req(
        "claudecli", "opus",
        system=[TextBlock(text="Be terse.")],
        messages=[
            CanonMessage(role="user", content=[TextBlock(text="q1")]),
            CanonMessage(role="assistant", content=[TextBlock(text="a1")]),
            CanonMessage(role="user", content=[TextBlock(text="q2")]),
        ],
    )
    out = flatten(req)
    assert out.startswith("Be terse.")
    assert "User: q1" in out and "Assistant: a1" in out


def test_flatten_single_turn_has_no_role_marker():
    out = flatten(canon_req("claudecli", "opus"))
    assert out == "hello"


async def test_blocking_caller_sees_the_stream_error_status():
    """StreamOnly.complete must not flatten a 429 or a dead upstream into a 500."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "slow down"}})

    with pytest.raises(RateLimited):
        await ollama_provider(handler).complete(canon_req("ollama", "m"))


# ------------------------------------------------------------ structured output

SCHEMA = {
    "type": "object",
    "properties": {"category": {"type": "string", "enum": ["SPAM", "GENERAL"]}},
    "required": ["category"],
    "additionalProperties": False,
}
JSON_FORMAT = {"type": "json_schema", "schema": SCHEMA}


def test_cli_gets_the_schema_as_json_schema_flag():
    args = cli_args("claude", canon_req("claudecli", "sonnet", response_format=JSON_FORMAT), "json")
    assert json.loads(args[args.index("--json-schema") + 1]) == SCHEMA
    assert "--json-schema" not in cli_args("claude", canon_req("claudecli", "sonnet"), "json")


def test_cli_rejects_a_format_it_cannot_honour():
    with pytest.raises(InvalidRequest):
        cli_args("claude", canon_req("claudecli", "sonnet", response_format={"type": "json_object"}), "json")


def test_cli_answers_with_the_validated_object_not_the_prose():
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    envelope = {
        "subtype": "success",
        "result": "Here you go: {\"category\": \"SPAM\"} hope that helps",
        "structured_output": {"category": "SPAM"},
    }
    resp = provider._envelope_to_response(envelope, canon_req("claudecli", "sonnet", response_format=JSON_FORMAT))
    assert json.loads(resp.text()) == {"category": "SPAM"}


def test_cli_without_structured_output_is_an_error_not_prose():
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    envelope = {"subtype": "success", "result": "SPAM, I think"}
    with pytest.raises(ProviderError, match="structured_output"):
        provider._envelope_to_response(envelope, canon_req("claudecli", "sonnet", response_format=JSON_FORMAT))


async def test_openai_wire_nests_the_schema_the_way_openai_expects():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={
            "id": "c1", "model": "qwen3:14b",
            "choices": [{"message": {"role": "assistant", "content": "{}"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        })

    provider = ollama_provider(handler)
    await provider.complete(canon_req("ollama", "qwen3:14b", response_format=JSON_FORMAT))
    assert seen["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "output", "schema": SCHEMA, "strict": True},
    }


async def test_not_logged_in_is_permanent_and_says_what_to_set(fake_claude):
    fake_claude(textwrap.dedent("""\
        #!/usr/bin/env python3
        import json, sys
        sys.stdin.read()
        print(json.dumps({"type": "result", "subtype": "success", "is_error": True,
                          "total_cost_usd": 0, "usage": {"input_tokens": 0},
                          "result": "Not logged in \u00b7 Please run /login"}))
        sys.exit(1)
    """))
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    with pytest.raises(ProviderNotLoggedIn) as exc:
        await provider.complete(canon_req("claudecli", "opus"))
    assert exc.value.retryable is False
    assert "CLAUDE_CODE_OAUTH_TOKEN" in str(exc.value)


def test_failure_detail_reads_the_envelope_result_not_its_counters():
    envelope = '{"type":"result","usage":{"service_tier":"standard"},"result":"Not logged in"}'
    assert failure_detail(envelope, "") == "Not logged in"
    assert failure_detail("not json at all", "boom") == "boom"
    assert failure_detail("", "") == ""


@pytest.mark.parametrize(
    "detail, login",
    [
        ("Not logged in · Please run /login", True),
        ("Invalid API key · Fix external API key", True),
        ("OAuth token has expired. Please obtain a new token", True),
        ("Error: usage limit reached", False),
        ("something broke permanently", False),
    ],
)
def test_login_failures_are_told_apart_from_outages(detail, login):
    assert is_login_failure(detail) is login



# With --include-partial-messages the CLI sends raw stream events as the tokens
# arrive, then the finished message, which repeats the same text.
PARTIAL_STREAM_STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, sys
    sys.stdin.read()
    def event(e):
        print(json.dumps({"type": "stream_event", "event": e}))
    print(json.dumps({"type": "system", "subtype": "init", "tools": []}))
    event({"type": "message_start", "message": {}})
    event({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
    for piece in ["pro", "xy ", "ok"]:
        event({"type": "content_block_delta", "index": 0,
               "delta": {"type": "text_delta", "text": piece}})
    event({"type": "content_block_stop", "index": 0})
    print(json.dumps({"type": "assistant", "message": {
        "content": [{"type": "text", "text": "proxy ok"}],
        "usage": {"input_tokens": 9, "output_tokens": 3}}}))
    print(json.dumps({"type": "result", "subtype": "success", "result": "proxy ok",
                      "total_cost_usd": 0.001}))
""")


async def test_partial_messages_stream_token_by_token_without_repeating_the_text(fake_claude):
    fake_claude(PARTIAL_STREAM_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    events = [e async for e in provider.stream(canon_req("claudecli", "haiku"))]
    deltas = [e.text for e in events if e.type == "text_delta"]
    assert deltas == ["pro", "xy ", "ok"]
    resp = aggregate(events)
    assert resp.text() == "proxy ok"
    assert resp.usage.output_tokens == 3


@pytest.mark.parametrize(
    "event, text",
    [
        ({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}}, "hi"),
        ({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "{"}}, ""),
        ({"type": "message_start", "message": {}}, ""),
        ({}, ""),
    ],
)
def test_partial_text_reads_only_text_deltas(event, text):
    assert partial_text(event) == text


def test_no_tools_unless_configured():
    args = cli_args("claude", canon_req("claudecli", "sonnet"), "json")
    assert args[args.index("--tools") + 1] == ""
    assert "--allowedTools" not in args


def test_configured_tools_are_enabled_and_pre_approved():
    assert tool_args(["WebSearch", "WebFetch"]) == [
        "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
    ]
    args = cli_args("claude", canon_req("claudecli", "sonnet"), "json", ["WebSearch"])
    assert args[args.index("--tools") + 1] == "WebSearch"


STREAM_NOT_LOGGED_IN_STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, sys
    sys.stdin.read()
    print(json.dumps({"type": "system", "subtype": "init", "tools": []}))
    # What the pinned CLI (2.1.278) really sends first: a synthetic message.
    print(json.dumps({"type": "assistant", "error": "authentication_failed", "message": {
        "model": "<synthetic>",
        "content": [{"type": "text", "text": "Not logged in \\u00b7 Please run /login"}]}}))
    print(json.dumps({"type": "result", "subtype": "success", "is_error": True,
                      "result": "Not logged in \\u00b7 Please run /login", "total_cost_usd": 0}))
    sys.exit(1)
""")


async def test_a_failed_stream_never_sends_the_error_as_text_and_names_the_login(fake_claude):
    fake_claude(STREAM_NOT_LOGGED_IN_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    events = [e async for e in provider.stream(canon_req("claudecli", "haiku"))]
    assert [e for e in events if e.type == "text_delta"] == []
    error = next(e for e in events if e.type == "error")
    assert error.code == "provider_not_logged_in"
    assert error.retryable is False



# The event sequence the pinned CLI (2.1.278) really sends for a schema-bound
# call: thinking, then a StructuredOutput tool call whose input streams as JSON.
SCHEMA_STREAM_STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, sys
    args = sys.argv[1:]
    assert "--json-schema" in args and "--include-partial-messages" in args, args
    sys.stdin.read()
    def event(e):
        print(json.dumps({"type": "stream_event", "event": e}))
    event({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})
    event({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": ""}})
    event({"type": "content_block_start", "index": 1,
           "content_block": {"type": "tool_use", "name": "StructuredOutput", "input": {}}})
    for piece in ['{"rationale": "A draft', ' to check", "category"', ': "BL_COMPARISON", "confidence": 0.9}']:
        event({"type": "content_block_delta", "index": 1,
               "delta": {"type": "input_json_delta", "partial_json": piece}})
    print(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "StructuredOutput"}],
                      "usage": {"input_tokens": 50, "output_tokens": 30}}}))
    print(json.dumps({"type": "result", "subtype": "success", "result": "done",
                      "structured_output": {"rationale": "A draft to check", "category": "BL_COMPARISON",
                                            "confidence": 0.9},
                      "usage": {"input_tokens": 60, "output_tokens": 42}, "total_cost_usd": 0.004}))
""")


async def test_a_schema_bound_call_streams_its_json_and_ends_with_the_validated_answer(fake_claude):
    fake_claude(SCHEMA_STREAM_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    req = canon_req("claudecli", "haiku", response_format=JSON_FORMAT)
    events = [e async for e in provider.stream(req)]
    preview = "".join(e.text for e in events if e.type == "text_delta")
    assert preview == '{"rationale": "A draft to check", "category": "BL_COMPARISON", "confidence": 0.9}'
    final = next(e for e in events if e.type == "message_delta")
    assert final.structured == {"rationale": "A draft to check", "category": "BL_COMPARISON", "confidence": 0.9}
    assert final.usage.reported_cost_usd == 0.004
    assert final.usage.output_tokens == 42, "the session totals, not the first snapshot"


def test_partial_text_forwards_json_deltas_only_for_a_schema_call():
    event = {"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": '{"a"'}}
    assert partial_text(event, structured=True) == '{"a"'
    assert partial_text(event) == ""
    thinking = {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "hmm"}}
    assert partial_text(thinking, structured=True) == ""


def test_the_final_stream_event_carries_the_cost_and_the_structured_answer():
    from llm_proxy.canon.response import CanonUsage, StopReason
    from llm_proxy.canon.stream import MessageDelta
    from llm_proxy.wire.anthropic_out import event_frames

    ev = MessageDelta(
        stop_reason=StopReason.END_TURN,
        usage=CanonUsage(input_tokens=5, output_tokens=7, reported_cost_usd=0.01),
        structured={"category": "SPAM"},
    )
    [(name, payload)] = event_frames(ev, "msg_1", "haiku")
    assert name == "message_delta"
    assert payload["usage"] == {"input_tokens": 5, "output_tokens": 7, "cost_usd": 0.01}
    assert payload["structured_output"] == {"category": "SPAM"}


def test_a_stream_error_frame_carries_the_verdict():
    from llm_proxy.canon.stream import StreamError
    from llm_proxy.wire.anthropic_out import event_frames

    [(name, payload)] = event_frames(
        StreamError(code="provider_not_logged_in", message="not logged in", retryable=False), "msg_1", "haiku"
    )
    assert name == "error"
    assert payload["error"]["code"] == "provider_not_logged_in"
    assert payload["error"]["retryable"] is False


RETRIED_SCHEMA_STREAM_STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, sys
    sys.stdin.read()
    def event(e):
        print(json.dumps({"type": "stream_event", "event": e}))
    def attempt(pieces):
        event({"type": "content_block_start", "index": 1,
               "content_block": {"type": "tool_use", "name": "StructuredOutput", "input": {}}})
        for piece in pieces:
            event({"type": "content_block_delta", "index": 1,
                   "delta": {"type": "input_json_delta", "partial_json": piece}})
    attempt(['{"$PARAMETER_NAME": ', '"broken"}'])
    attempt(['{"category": ', '"SPAM"}'])
    print(json.dumps({"type": "result", "subtype": "success", "result": "done",
                      "structured_output": {"category": "SPAM"}, "total_cost_usd": 0.001}))
""")


async def test_each_attempt_at_a_schema_answer_streams_as_its_own_block(fake_claude):
    fake_claude(RETRIED_SCHEMA_STREAM_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    events = [e async for e in provider.stream(canon_req("claudecli", "haiku", response_format=JSON_FORMAT))]
    by_block: dict[int, str] = {}
    for e in events:
        if e.type == "text_delta":
            by_block[e.index] = by_block.get(e.index, "") + e.text
    assert by_block == {0: '{"$PARAMETER_NAME": "broken"}', 1: '{"category": "SPAM"}'}
    assert [e.index for e in events if e.type == "block_stop"] == [0, 1]
    assert next(e for e in events if e.type == "message_delta").structured == {"category": "SPAM"}


def test_only_a_tool_call_opens_an_attempt():
    assert starts_attempt({"type": "content_block_start", "content_block": {"type": "tool_use"}})
    assert not starts_attempt({"type": "content_block_start", "content_block": {"type": "thinking"}})
    assert not starts_attempt({"type": "content_block_delta", "delta": {}})


# ------------------------------------------------------- claudecli: images

# Reports what it was given, so a test can assert the flags and the prompt the
# provider built rather than the answer it got back.
ECHO_STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, sys
    prompt = sys.stdin.read()
    print(json.dumps({
        "subtype": "success", "is_error": False,
        "result": json.dumps({"argv": sys.argv[1:], "prompt": prompt}),
        "session_id": "sess_img", "usage": {"input_tokens": 1, "output_tokens": 1},
    }))
""")

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\nnot-really-a-png").decode()


def image_req(**kw):
    return canon_req(
        "claudecli",
        "sonnet",
        messages=[CanonMessage(role="user", content=[
            TextBlock(text="What does it say?"),
            ImageBlock(source_kind="base64", media_type="image/png", data=PNG, **kw),
        ])],
    )


async def test_an_image_is_written_to_disk_and_read_by_the_session(fake_claude):
    """`claude -p` takes no image block, so the provider hands the CLI a file and Read."""
    fake_claude(ECHO_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))

    said = json.loads((await provider.complete(image_req())).text())

    assert "--tools" in said["argv"]
    assert "Read" in said["argv"][said["argv"].index("--tools") + 1]
    # Pre-approved, and only over the directory this request's images went to.
    allowed = said["argv"][said["argv"].index("--allowedTools") + 1]
    assert allowed.startswith("Read(") and allowed.endswith("/**)")
    written = [line[2:] for line in said["prompt"].splitlines() if line.startswith("- ")]
    assert len(written) == 1 and written[0].endswith(".png")
    assert "What does it say?" in said["prompt"]


async def test_the_image_file_holds_the_decoded_bytes_and_is_removed_after(fake_claude):
    """The scratch directory is the request's, and it does not outlive it."""
    seen: dict[str, bytes] = {}
    fake_claude(ECHO_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))

    original = write_images

    def spy(blocks, directory):
        paths = original(blocks, directory)
        for path in paths:
            seen[path] = open(path, "rb").read()
        return paths

    import llm_proxy.providers.claude_cli as module
    module.write_images = spy
    try:
        await provider.complete(image_req())
    finally:
        module.write_images = original

    (path, data), = seen.items()
    assert data == base64.b64decode(PNG)
    assert not os.path.exists(path), "the scratch directory must not outlive the request"


async def test_a_request_with_no_image_gets_no_filesystem(fake_claude):
    fake_claude(ECHO_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))

    said = json.loads((await provider.complete(canon_req("claudecli", "sonnet"))).text())

    assert said["argv"][said["argv"].index("--tools") + 1] == ""
    assert "--allowedTools" not in said["argv"]


async def test_a_url_image_is_refused(fake_claude):
    fake_claude(ECHO_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    req = canon_req("claudecli", "sonnet", messages=[CanonMessage(role="user", content=[
        ImageBlock(source_kind="url", data="https://example.test/bl.png"),
    ])])

    with pytest.raises(InvalidRequest, match="base64"):
        await provider.complete(req)


async def test_a_media_type_read_cannot_open_is_refused(fake_claude):
    """Refused here rather than written with a misleading suffix that Read then fails on."""
    fake_claude(ECHO_STUB)
    provider = ClaudeCliProvider("claudecli", ProviderConfig(type="claudecli"))
    req = canon_req("claudecli", "sonnet", messages=[CanonMessage(role="user", content=[
        ImageBlock(source_kind="base64", media_type="image/tiff", data=PNG),
    ])])

    with pytest.raises(InvalidRequest, match="image/tiff"):
        await provider.complete(req)


def test_read_is_granted_only_for_images_and_only_over_that_request_s_directory():
    """The picture is somebody else's text. A grant over the whole filesystem would
    make "read your credentials into the transcription" a thing it could ask for."""
    assert tool_args([]) == ["--tools", ""]
    assert tool_args([], "/tmp/x") == ["--tools", "Read", "--allowedTools", "Read(/tmp/x/**)"]
    # A trailing slash must not become `Read(/tmp/x//**)`, which matches nothing.
    assert tool_args([], "/tmp/x/")[3] == "Read(/tmp/x/**)"
    assert tool_args(["WebSearch"], "/tmp/x") == [
        "--tools", "WebSearch,Read", "--allowedTools", "WebSearch,Read(/tmp/x/**)",
    ]
