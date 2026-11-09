"""Per-model parameter stripping — the difference between 'works' and '400s'."""

from __future__ import annotations

import pytest

from llm_proxy.canon.request import (
    CanonMessage, CanonRequest, CanonTool, ImageBlock, Reasoning, Sampling, TextBlock,
)
from llm_proxy.capabilities import Capabilities
from llm_proxy.config import Capability
from llm_proxy.errors import InvalidRequest, UnsupportedFeature


def req(provider="claudecli", model_id="sonnet", **kw) -> CanonRequest:
    base = dict(alias="a", provider=provider, model_id=model_id, messages=[])
    base.update(kw)
    return CanonRequest(**base)


@pytest.fixture
def caps():
    return Capabilities()


# The shipped proxy.yaml entry for Ollama, reproduced so the tests pin its meaning.
OLLAMA = {"ollama/*": Capability(sampling="allow", thinking="none", images="deny")}


# ------------------------------------------------------------------ claudecli


def test_claudecli_strips_temperature_from_the_baseline(caps):
    """`claude -p` has no sampling knobs, and the Anthropic SDK path may send them."""
    r = req(sampling=Sampling(temperature=0.7, top_p=0.9))
    caps.normalize(r)
    assert r.sampling.temperature is None and r.sampling.top_p is None
    assert any("temperature" in w for w in r.warnings)


def test_claudecli_strips_thinking_and_effort(caps):
    r = req(reasoning=Reasoning(mode="on", effort="high", budget_tokens=1000))
    caps.normalize(r)
    assert r.reasoning.mode == "auto"
    assert r.reasoning.effort is None and r.reasoning.budget_tokens is None
    assert any("thinking" in w for w in r.warnings)


def test_claudecli_rejects_tools_with_an_actionable_message(caps):
    r = req(tools=[CanonTool(name="w")])
    with pytest.raises(UnsupportedFeature) as exc:
        caps.normalize(r)
    assert "cannot serve tool_use" in str(exc.value)


def test_claudecli_takes_images(caps):
    """The CLI has no image block, but its Read tool opens a file, so the provider
    writes each image to disk rather than the capability refusing it. What Read
    cannot open is refused in claude_cli.py, where the media type is known."""
    r = req(
        messages=[
            CanonMessage(
                role="user",
                content=[ImageBlock(source_kind="base64", media_type="image/png", data="AAAA")],
            )
        ],
    )
    caps.normalize(r)
    assert r.warnings == []


def test_untouched_request_produces_no_warnings(caps):
    """The common case — retina sends model, max_tokens, messages, system — is silent."""
    r = req(max_tokens=2048, messages=[CanonMessage(role="user", content=[TextBlock(text="q")])])
    caps.normalize(r)
    assert r.warnings == []


# --------------------------------------------------------------------- ollama


def test_ollama_keeps_sampling_but_drops_thinking():
    caps = Capabilities(OLLAMA)
    r = req(provider="ollama", model_id="qwen3:14b",
            sampling=Sampling(temperature=0.2), reasoning=Reasoning(mode="off", effort="low"))
    caps.normalize(r)
    assert r.sampling.temperature == 0.2
    assert r.reasoning.mode == "auto" and r.reasoning.effort is None
    assert any("no thinking controls" in w for w in r.warnings)


def test_glob_matches_any_ollama_tag():
    caps = Capabilities(OLLAMA)
    assert caps.lookup("ollama/qwen3:4b-ctx16k").thinking == "none"
    assert caps.lookup("ollama/anything").thinking == "none"
    assert caps.lookup("mock/echo").thinking == "budget_ok", "the generic default"


# ------------------------------------------------------------- generic rules


def test_unknown_routes_get_the_permissive_default(caps):
    r = req(provider="mock", model_id="echo", sampling=Sampling(temperature=0.7))
    caps.normalize(r)
    assert r.sampling.temperature == 0.7
    assert r.warnings == []


def test_config_overrides_beat_the_baseline():
    caps = Capabilities({"claudecli/*": Capability(sampling="allow")})
    r = req(sampling=Sampling(temperature=0.7))
    caps.normalize(r)
    assert r.sampling.temperature == 0.7, "config override should win over baseline"


def test_exact_key_beats_glob():
    caps = Capabilities({
        "ollama/*": Capability(sampling="deny"),
        "ollama/qwen3:4b": Capability(sampling="allow"),
    })
    assert caps.lookup("ollama/qwen3:4b").sampling == "allow"
    assert caps.lookup("ollama/qwen3:14b").sampling == "deny"


def test_reject_mode_raises_instead_of_stripping(caps):
    r = req(sampling=Sampling(temperature=0.7))
    with pytest.raises(InvalidRequest):
        caps.normalize(r, mode="reject")


def test_strip_silent_mode_strips_without_warning(caps):
    r = req(sampling=Sampling(temperature=0.7))
    caps.normalize(r, mode="strip_silent")
    assert r.sampling.temperature is None
    assert r.warnings == []


def test_sampling_allow_list():
    caps = Capabilities({"ollama/*": Capability(sampling=["temperature"])})
    r = req(provider="ollama", model_id="q", sampling=Sampling(temperature=0.5, top_p=0.9))
    caps.normalize(r)
    assert r.sampling.temperature == 0.5 and r.sampling.top_p is None


def test_max_tokens_clamped_to_model_ceiling():
    caps = Capabilities({"ollama/*": Capability(max_output_tokens=8000)})
    r = req(provider="ollama", model_id="q", max_tokens=200000)
    caps.normalize(r)
    assert r.max_tokens == 8000


def test_thinking_default_on_raises_tiny_max_tokens():
    """max_tokens caps thinking AND text together; 500 would yield an empty answer."""
    caps = Capabilities({"x/*": Capability(thinking_default="on", min_effective_max_tokens=4096)})
    r = req(provider="x", model_id="m", max_tokens=500)
    caps.normalize(r)
    assert r.max_tokens == 4096
    assert any("thinking counts against max_tokens" in w for w in r.warnings)
    off = req(provider="x", model_id="m", max_tokens=500, reasoning=Reasoning(mode="off"))
    caps.normalize(off)
    assert off.max_tokens == 500


def test_always_on_cannot_disable_thinking():
    caps = Capabilities({"x/*": Capability(thinking="always_on")})
    r = req(provider="x", model_id="m", reasoning=Reasoning(mode="off", budget_tokens=10))
    caps.normalize(r)
    assert r.reasoning.mode == "auto" and r.reasoning.budget_tokens is None


def test_adaptive_only_caps_effort_rather_than_failing():
    """thinking:disabled above the effort limit is a 400 upstream. The caller's intent
    (cheap and fast) is still servable, so cap the effort instead of rejecting."""
    caps = Capabilities({"x/*": Capability(
        thinking="adaptive_only", disable_thinking_max_effort="high")})
    r = req(provider="x", model_id="m", reasoning=Reasoning(mode="off", effort="max", budget_tokens=8))
    caps.normalize(r)
    assert r.reasoning.mode == "off"
    assert r.reasoning.effort == "high"
    assert r.reasoning.budget_tokens is None


def test_trailing_assistant_prefill_is_converted_not_rejected():
    caps = Capabilities({"x/*": Capability(prefill="deny")})
    r = req(
        provider="x", model_id="m", max_tokens=8000,
        messages=[
            CanonMessage(role="user", content=[TextBlock(text="q")]),
            CanonMessage(role="assistant", content=[TextBlock(text='{"name": "')]),
        ],
    )
    caps.normalize(r)
    assert r.messages[-1].role == "user"
    assert any("prefill" in w for w in r.warnings)
