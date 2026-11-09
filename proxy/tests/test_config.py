from __future__ import annotations

from pathlib import Path

import pytest

from llm_proxy.config import expand_env, load
from llm_proxy.errors import ConfigError

SHIPPED = Path(__file__).resolve().parents[1] / "proxy.yaml"


def test_expand_env_reads_the_variable(monkeypatch):
    monkeypatch.setenv("LLM_PROXY_HOST", "0.0.0.0")
    assert expand_env("host: ${LLM_PROXY_HOST:-127.0.0.1}") == "host: 0.0.0.0"


def test_expand_env_falls_back_to_the_default(monkeypatch):
    monkeypatch.delenv("LLM_PROXY_HOST", raising=False)
    assert expand_env("host: ${LLM_PROXY_HOST:-127.0.0.1}") == "host: 127.0.0.1"


def test_expand_env_treats_an_empty_variable_as_unset(monkeypatch):
    monkeypatch.setenv("LLM_PROXY_HOST", "")
    assert expand_env("host: ${LLM_PROXY_HOST:-127.0.0.1}") == "host: 127.0.0.1"


def test_expand_env_refuses_a_variable_with_no_value_and_no_default(monkeypatch):
    monkeypatch.delenv("RETINA_NOT_SET", raising=False)
    with pytest.raises(ConfigError, match="RETINA_NOT_SET"):
        expand_env("x: ${RETINA_NOT_SET}")


def test_expand_env_leaves_other_dollar_signs_alone():
    assert expand_env("cost: $5 and $HOME") == "cost: $5 and $HOME"


def test_the_shipped_config_binds_loopback_by_default(monkeypatch):
    monkeypatch.delenv("LLM_PROXY_HOST", raising=False)
    monkeypatch.delenv("LLM_PROXY_EXPOSED", raising=False)
    cfg = load(SHIPPED)
    assert cfg.server.host == "127.0.0.1"
    assert cfg.server.i_know_this_is_exposed is False


def test_the_shipped_config_serves_the_container_when_told_to(monkeypatch):
    monkeypatch.setenv("LLM_PROXY_HOST", "0.0.0.0")
    monkeypatch.setenv("LLM_PROXY_EXPOSED", "true")
    cfg = load(SHIPPED)
    assert cfg.server.host == "0.0.0.0"
    assert cfg.server.i_know_this_is_exposed is True


def test_the_shipped_config_still_refuses_an_exposed_bind_nobody_chose(monkeypatch):
    monkeypatch.setenv("LLM_PROXY_HOST", "0.0.0.0")
    monkeypatch.delenv("LLM_PROXY_EXPOSED", raising=False)
    with pytest.raises(ConfigError, match="not loopback"):
        load(SHIPPED)


def test_the_shipped_config_offers_the_claude_aliases_and_the_mock_only(monkeypatch):
    monkeypatch.delenv("LLM_PROXY_HOST", raising=False)
    aliases = {entry.model_name for entry in load(SHIPPED).model_list}
    assert aliases == {"sonnet", "opus", "haiku", "test"}


def test_the_shipped_config_gives_claude_no_tools(monkeypatch):
    monkeypatch.delenv("LLM_PROXY_HOST", raising=False)
    assert load(SHIPPED).providers["claudecli"].tools == []

