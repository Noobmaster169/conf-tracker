"""proxy.yaml schema, loading and validation.

Shaped after LiteLLM's `model_list` so that migrating to (or from) LiteLLM later is
close to a rename rather than a rewrite.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .errors import ConfigError

ProviderType = Literal["openai_compatible", "claudecli", "mock"]


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 4000
    request_timeout_s: int = 1800
    # Deliberately empty. `127.0.0.1` is NOT a closed door: any page in the user's
    # browser can POST here. Permissive CORS would hand it the responses too.
    cors_origins: list[str] = Field(default_factory=list)
    # Required to bind anything other than loopback. Makes exposure a decision.
    i_know_this_is_exposed: bool = False


class ProviderConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: ProviderType
    api_key_env: str | None = None
    base_url: str | None = None
    max_concurrency: int = 8
    timeout_s: int = 600
    extra_headers: dict[str, str] = Field(default_factory=dict)

    # openai_compatible only. Some compatible endpoints reject the field; set false
    # for those rather than losing usage on every call.
    supports_stream_options: bool = True

    # openai_compatible only. OpenAI renamed the output cap to
    # `max_completion_tokens`, and most compatible servers never followed:
    # Ollama 0.32 parses the request, ignores the field, and generates to the
    # context wall with no error anywhere. Set `max_tokens` for those.
    max_tokens_field: Literal["max_completion_tokens", "max_tokens"] = (
        "max_completion_tokens"
    )

    # openai_compatible only. Merged into every chat request body, for
    # server-specific switches the canonical request has no room for. Ollama's
    # `reasoning_effort: none` is the one that matters here: it is the only
    # thing that actually turns Qwen 3's thinking off (the documented
    # `/no_think` prefix does not, on 0.32), and without it a reply arrives with
    # its reasoning in `message.reasoning` and `content` empty.
    extra_body: dict[str, Any] = Field(default_factory=dict)

    # claudecli only
    binary: str = "claude"
    stream_mode: Literal["native", "synthetic"] = "native"
    neutralise_anthropic_key: bool = True
    # claudecli only. The CLI's built-in tools this provider's sessions may use,
    # and may use without a permission prompt (e.g. ["WebSearch"]). Empty, the
    # default, means none: without `--tools` a `claude -p` session loads Bash,
    # Edit, Write, WebFetch and twenty more, which a completion never needs and
    # which a crafted input could try to steer.
    tools: list[str] = Field(default_factory=list)

    def api_key(self) -> str | None:
        return os.getenv(self.api_key_env) if self.api_key_env else None


class ModelParams(BaseModel):
    model_config = ConfigDict(extra="allow", protected_namespaces=())

    # "provider/model_id", as in LiteLLM.
    model: str
    max_tokens: int | None = None
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    thinking: Literal["adaptive", "disabled"] | None = None
    thinking_display: Literal["omitted", "summarized"] | None = None


class ModelEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    model_name: str
    params: ModelParams | None = None
    litellm_params: ModelParams | None = None  # accepted alias for drop-in configs
    fallbacks: list[str] = Field(default_factory=list)

    def resolved(self) -> ModelParams:
        p = self.params or self.litellm_params
        if p is None:
            raise ConfigError(f"model '{self.model_name}' has no params block")
        return p


class Capability(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # "allow" | "deny" | an explicit list of permitted parameter names
    sampling: Any = "allow"
    thinking: Literal["adaptive_only", "budget_ok", "always_on", "none"] = "budget_ok"
    thinking_default: Literal["on", "off"] = "off"
    disable_thinking_max_effort: str | None = None
    prefill: Literal["allow", "deny"] = "allow"
    tools: Literal["allow", "deny"] = "allow"
    images: Literal["allow", "deny"] = "allow"
    # Documents how the provider delivers `system`. Not consulted at runtime: each
    # provider adapter already knows (claudecli folds it into the prompt body).
    system: Literal["native", "merge_into_first_user"] = "native"
    max_output_tokens: int | None = None
    context_window: int | None = None
    # Guards the "thinking eats max_tokens" trap: a client's max_tokens=500 against
    # a thinking-by-default model yields an empty answer.
    min_effective_max_tokens: int | None = None


class ProxyConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = 1
    server: ServerConfig = Field(default_factory=ServerConfig)
    providers: dict[str, ProviderConfig] = Field(default_factory=dict)
    model_list: list[ModelEntry] = Field(default_factory=list)
    capabilities: dict[str, Capability] = Field(default_factory=dict)
    on_unsupported_param: Literal["strip_and_warn", "strip_silent", "reject"] = "strip_and_warn"

    @field_validator("model_list")
    @classmethod
    def _unique_aliases(cls, v: list[ModelEntry]) -> list[ModelEntry]:
        seen: set[str] = set()
        for entry in v:
            if entry.model_name in seen:
                raise ValueError(f"duplicate model_name '{entry.model_name}'")
            seen.add(entry.model_name)
        return v

    def validate_wiring(self) -> None:
        """Cross-checks that a per-field validator cannot express."""
        for entry in self.model_list:
            params = entry.resolved()
            if "/" not in params.model:
                raise ConfigError(
                    f"model '{entry.model_name}': params.model must be "
                    f"'provider/model_id', got {params.model!r}"
                )
            provider, _ = params.model.split("/", 1)
            if provider not in self.providers:
                raise ConfigError(
                    f"model '{entry.model_name}' references provider '{provider}', "
                    f"which is not defined under `providers` "
                    f"(have: {', '.join(sorted(self.providers)) or 'none'})"
                )
        aliases = {e.model_name for e in self.model_list}
        for entry in self.model_list:
            for fb in entry.fallbacks:
                if fb not in aliases:
                    raise ConfigError(
                        f"model '{entry.model_name}' falls back to unknown alias '{fb}'"
                    )
        if self.server.host not in ("127.0.0.1", "localhost", "::1") and not (
            self.server.i_know_this_is_exposed
        ):
            raise ConfigError(
                f"server.host is {self.server.host!r}, which is not loopback. This "
                "proxy has no authentication: binding it beyond localhost exposes "
                "your Claude subscription and local models to the network. Set "
                "server.i_know_this_is_exposed: true if that is genuinely intended."
            )


_ENV_REF = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}")


def expand_env(text: str) -> str:
    """`${NAME}` and `${NAME:-default}` from the environment, before YAML parsing.

    One file serves a proxy on a laptop and one in a container: only what differs
    between them (the bind address, the exposure flag) is read from the env. A
    reference with no default and no value is an error, not an empty string, so a
    missing variable never silently becomes a blank setting.
    """

    def value(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        found = os.environ.get(name)
        if found:
            return found
        if default is not None:
            return default
        raise ConfigError(f"proxy config reads ${{{name}}}, which is not set and has no default")

    return _ENV_REF.sub(value, text)


def load(path: str | Path) -> ProxyConfig:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"config file not found: {p}")
    try:
        raw = yaml.safe_load(expand_env(p.read_text())) or {}
    except yaml.YAMLError as e:
        raise ConfigError(f"{p} is not valid YAML: {e}") from e
    try:
        cfg = ProxyConfig.model_validate(raw)
    except Exception as e:
        raise ConfigError(f"{p} failed validation: {e}") from e
    cfg.validate_wiring()
    return cfg
