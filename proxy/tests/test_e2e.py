"""End-to-end through the real ASGI app, against the mock provider."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from conftest import mock_config, sse_events
from llm_proxy.api.messages import _complete
from llm_proxy.config import Capability
from llm_proxy.errors import ClientGone


def message(**body):
    body.setdefault("model", "test")
    body.setdefault("max_tokens", 100)
    body.setdefault("messages", [{"role": "user", "content": "ping"}])
    return body


def stream_text(sse_body: str) -> str:
    return "".join(
        json.loads(d)["delta"]["text"]
        for n, d in sse_events(sse_body)
        if n == "content_block_delta" and json.loads(d)["delta"]["type"] == "text_delta"
    )


# ------------------------------------------------------------------ catalogue


async def test_healthz(client):
    r = await client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ok",
        "providers": ["mock"],
        "models": ["test", "test-429", "test-capped", "test-refusal", "test-thinking", "test-tools"],
    }


async def test_models_shape(client):
    r = await client.get("/v1/models")
    assert r.status_code == 200
    body = r.json()
    assert body["object"] == "list"
    entry = next(m for m in body["data"] if m["id"] == "test")
    assert set(entry) == {
        "id", "object", "created", "owned_by", "display_name", "provider", "model_id", "fallbacks"
    }
    assert entry["object"] == "model"
    assert entry["provider"] == entry["owned_by"] == "mock"
    assert entry["model_id"] == "echo"
    assert entry["fallbacks"] == []


# ------------------------------------------------------------------- blocking


async def test_blocking(client):
    r = await client.post("/v1/messages", headers={"x-api-key": "retina-dev"}, json=message())
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "message" and body["role"] == "assistant"
    assert body["content"] == [{"type": "text", "text": "echo: ping"}]
    assert body["stop_reason"] == "end_turn"
    assert body["usage"]["output_tokens"] == 8
    assert body["stop_details"] is None
    assert r.headers["x-llm-proxy-model"] == "echo"
    assert r.headers["x-llm-proxy-provider"] == "mock"
    assert r.headers["x-llm-proxy-project"] == "retina-dev"
    assert r.headers["x-llm-proxy-cost-usd"] == "0.000000"
    assert r.headers["x-llm-proxy-stop-reason"] == "end_turn"
    assert r.headers["x-llm-proxy-request-id"].startswith("req_")
    assert "x-llm-proxy-warnings" not in r.headers


async def test_blocking_with_system_prompt(client):
    r = await client.post("/v1/messages", json=message(system="Be terse."))
    assert r.status_code == 200
    assert r.json()["content"][0]["text"] == "echo: ping"


async def test_blocking_tool_call(client):
    r = await client.post("/v1/messages", json=message(model="test-tools"))
    body = r.json()
    assert body["stop_reason"] == "tool_use"
    use = next(b for b in body["content"] if b["type"] == "tool_use")
    assert use["input"] == {"city": "Paris"}


async def test_refusal_returns_200_with_empty_content(client):
    r = await client.post("/v1/messages", json=message(model="test-refusal"))
    assert r.status_code == 200
    body = r.json()
    assert body["content"] == []
    assert body["stop_reason"] == "refusal"
    assert body["stop_details"]["category"] == "cyber"


# ------------------------------------------------------------------ streaming


async def test_streaming_shape(client):
    r = await client.post("/v1/messages", json=message(stream=True))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["x-llm-proxy-model"] == "echo"
    assert "x-llm-proxy-cost-usd" not in r.headers, "not known until the body ends"
    events = sse_events(r.text)
    names = [n for n, _ in events]
    assert names[0] == "message_start"
    assert names[-1] == "message_stop"
    assert "message_delta" in names
    assert all(n is not None for n in names), "every Anthropic frame must be named"
    assert stream_text(r.text) == "echo: ping"


async def test_streaming_thinking_blocks(client):
    r = await client.post("/v1/messages", json=message(model="test-thinking", stream=True))
    kinds = {
        json.loads(d)["delta"]["type"]
        for n, d in sse_events(r.text)
        if n == "content_block_delta"
    }
    assert {"thinking_delta", "signature_delta", "text_delta"} <= kinds


async def test_streaming_error_is_a_named_error_frame(client):
    """Once the stream is open the status is gone; the error rides in the body."""
    r = await client.post("/v1/messages", json=message(model="test-429", stream=True))
    assert r.status_code == 200
    events = sse_events(r.text)
    assert events[-1][0] == "error"
    assert json.loads(events[-1][1])["error"]["type"] == "api_error"


@pytest.mark.parametrize("chunk_size", [0, 3])
@pytest.mark.parametrize("stream", [False, True])
async def test_provider_chunking_cross_product(app, client, chunk_size, stream):
    """{provider chunks or not} x {client streams or not}."""
    app.state.proxy.registry.get("mock").chunk_size = chunk_size
    try:
        r = await client.post("/v1/messages", json=message(stream=stream))
        assert r.status_code == 200
        text = stream_text(r.text) if stream else r.json()["content"][0]["text"]
        assert text == "echo: ping"
    finally:
        app.state.proxy.registry.get("mock").chunk_size = 0


# ----------------------------------------------------------------------- errors


async def test_unknown_model_envelope(client):
    r = await client.post("/v1/messages", json=message(model="nope"))
    assert r.status_code == 404
    body = r.json()
    assert body["type"] == "error"
    assert body["error"]["type"] == "not_found_error"
    assert "unknown model 'nope'" in body["error"]["message"]
    assert "Configured aliases: test, test-429" in body["error"]["message"]
    assert body["error"]["detail"]["available"][0] == "test"


async def test_error_envelope_states_code_and_retryability(client):
    """A caller cannot tell these apart from the status: both would be 5xx-ish guesswork.

    The 404 below is permanent and the 429 is not, so a client that retries on
    status alone either gives up on an outage or retries a typo forever. The
    proxy already classifies its own errors, so it says so on the wire.
    """
    permanent = (await client.post("/v1/messages", json=message(model="nope"))).json()
    assert permanent["error"]["code"] == "unknown_model"
    assert permanent["error"]["retryable"] is False

    transient = (await client.post("/v1/messages", json=message(model="test-429"))).json()
    assert transient["error"]["code"] == "rate_limited"
    assert transient["error"]["retryable"] is True


async def test_invalid_json_is_400(client):
    r = await client.post("/v1/messages", content=b"{nope", headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert r.json()["error"]["type"] == "invalid_request_error"


async def test_missing_messages_is_400(client):
    r = await client.post("/v1/messages", json={"model": "test", "max_tokens": 5})
    assert r.status_code == 400


async def test_rate_limit_surfaces_as_429(client):
    r = await client.post("/v1/messages", json=message(model="test-429"))
    assert r.status_code == 429
    assert r.json()["error"]["type"] == "rate_limit_error"


async def test_cross_origin_request_is_refused(client):
    """127.0.0.1 is not a closed door: any browser page can POST here."""
    r = await client.post(
        "/v1/messages", headers={"Origin": "https://evil.example"}, json=message()
    )
    assert r.status_code == 403
    assert r.json()["error"]["type"] == "origin_not_allowed"


# ------------------------------------------------------------------ attribution


async def test_bearer_token_becomes_project(client):
    r = await client.post(
        "/v1/messages", headers={"Authorization": "Bearer research"}, json=message()
    )
    assert r.headers["x-llm-proxy-project"] == "research"


async def test_placeholder_key_falls_through_to_metadata(client):
    """SDKs force callers to send *something*; 'unused' is not a project."""
    r = await client.post(
        "/v1/messages",
        headers={"x-api-key": "unused"},
        json=message(metadata={"user_id": "frontend"}),
    )
    assert r.headers["x-llm-proxy-project"] == "frontend"


async def test_unattributed_when_nothing_is_sent(client):
    r = await client.post("/v1/messages", json=message())
    assert r.headers["x-llm-proxy-project"] == "unattributed"


async def test_real_api_key_is_never_used_as_a_project_label(client):
    """A pasted provider key must not be echoed back in a header."""
    r = await client.post(
        "/v1/messages", headers={"x-api-key": "sk-ant-api03-realkeymaterial"}, json=message()
    )
    assert r.headers["x-llm-proxy-project"] == "unattributed"


# ----------------------------------------------------------- alias defaults


async def test_alias_defaults_fill_gaps_but_do_not_override(app, client):
    """Config sets a ceiling for callers who didn't think about it, not for those who did."""
    from llm_proxy.canon.request import CanonRequest
    from llm_proxy.service import Pipeline

    pipe = Pipeline(app.state.proxy)
    silent = pipe.prepare(CanonRequest(alias="test-capped", messages=[]))
    assert silent.max_tokens == 1234

    explicit = pipe.prepare(CanonRequest(alias="test-capped", max_tokens=99, messages=[]))
    assert explicit.max_tokens == 99


# ------------------------------------------------- capabilities in the pipeline


@pytest.fixture
def config():
    return mock_config(capabilities={"mock/echo": Capability(sampling="deny", tools="deny")})


async def test_capability_warnings_reach_the_response_headers(client):
    """A caller whose temperature was silently dropped deserves to know."""
    r = await client.post("/v1/messages", json=message(temperature=0.7))
    assert r.status_code == 200
    assert "temperature" in r.headers["x-llm-proxy-warnings"]


async def test_unsupported_feature_is_a_400(client):
    r = await client.post(
        "/v1/messages",
        json=message(tools=[{"name": "w", "input_schema": {"type": "object"}}]),
    )
    assert r.status_code == 400
    body = r.json()
    assert body["error"]["type"] == "invalid_request_error"
    assert "cannot serve tool_use" in body["error"]["message"]
    assert body["error"]["detail"] == {"alias": "test", "route": "mock/echo"}


async def test_abandoned_call_is_cancelled_rather_than_left_holding_a_slot():
    """A caller that hung up must not keep a claudecli slot warm.

    `claude -p` runs at max_concurrency 2. A backend whose own timeout fired has
    already requeued its job, so an abandoned call that keeps running blocks the
    retry behind an answer nobody will read. The providers reap their child on
    cancellation; this proves something now triggers it.
    """
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def never_answers(_req):
        started.set()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    async def is_disconnected():
        # Connected until the call is under way, gone immediately after.
        return started.is_set()

    with pytest.raises(ClientGone):
        await _complete(
            SimpleNamespace(complete=never_answers),
            SimpleNamespace(model="test", model_id="mock/echo"),
            SimpleNamespace(is_disconnected=is_disconnected),
        )

    await asyncio.wait_for(cancelled.wait(), timeout=1)
