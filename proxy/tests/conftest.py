"""Shared fixtures. Everything here runs against the mock provider: no network, no cost."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from llm_proxy.config import ModelEntry, ModelParams, ProviderConfig, ProxyConfig
from llm_proxy.main import create_app
from llm_proxy.settings import Settings


def mock_config(**overrides) -> ProxyConfig:
    cfg = ProxyConfig(
        providers={"mock": ProviderConfig(type="mock")},
        model_list=[
            ModelEntry(model_name="test", params=ModelParams(model="mock/echo")),
            ModelEntry(model_name="test-tools", params=ModelParams(model="mock/tool_call")),
            ModelEntry(model_name="test-refusal", params=ModelParams(model="mock/refusal")),
            ModelEntry(model_name="test-thinking", params=ModelParams(model="mock/thinking")),
            ModelEntry(model_name="test-429", params=ModelParams(model="mock/error_429")),
            ModelEntry(
                model_name="test-capped",
                params=ModelParams(model="mock/echo", max_tokens=1234),
            ),
        ],
        **overrides,
    )
    cfg.validate_wiring()
    return cfg


@pytest.fixture
def config() -> ProxyConfig:
    return mock_config()


@pytest.fixture
def app(config, tmp_path):
    return create_app(config, Settings(config_path=tmp_path / "proxy.yaml"))


@pytest.fixture
async def client(app):
    # ASGITransport drives the app in-process: no socket, no port, no flakiness.
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://proxy"
    ) as ac:
        # Trigger the lifespan so app.state.proxy exists.
        async with app.router.lifespan_context(app):
            yield ac


def sse_events(text: str) -> list[tuple[str | None, str]]:
    """Parse an SSE body into (event_name, data) pairs."""
    out: list[tuple[str | None, str]] = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        name, data = None, []
        for line in block.split("\n"):
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data.append(line[6:])
        if data:
            out.append((name, "\n".join(data)))
    return out
