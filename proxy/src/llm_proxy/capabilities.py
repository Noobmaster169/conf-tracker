"""Per-model parameter normalisation.

This module is the difference between "works" and "400s". Current Claude models
reject `temperature`, `top_p`, `top_k` and `budget_tokens` outright, Ollama has no
thinking controls at all, and clients send these by habit — so without stripping
here, a request fails with an error the caller cannot act on.

Two layers, most specific wins:

  1. the baseline table below (in code),
  2. glob-keyed `capabilities:` overrides in proxy.yaml.
"""

from __future__ import annotations

import fnmatch

from .config import Capability, ProxyConfig
from .errors import InvalidRequest, UnsupportedFeature
from .canon.request import CanonRequest

# Ordered most-specific-first; the first glob that matches wins.
_BASELINE: tuple[tuple[str, Capability], ...] = (
    # `claude -p` spawns a whole agent session: no tool-use API and no separate system
    # prompt. Rejecting is kinder than silently degrading.
    #
    # Images are allowed, though the CLI takes no image block: the provider writes each
    # one to a temporary file and lets the session's own Read tool open it. That is a
    # translation, not a degrade, so the capability says allow and claude_cli.py does
    # the work. A media type Read cannot open is still refused, there.
    ("claudecli/*", Capability(
        sampling="deny", thinking="none", tools="deny", images="allow",
        system="merge_into_first_user")),
    ("*", Capability()),
)

_EFFORT_ORDER = ("low", "medium", "high", "xhigh", "max")
_SAMPLING_FIELDS = (
    "temperature", "top_p", "top_k", "seed", "frequency_penalty", "presence_penalty",
)


class Capabilities:
    def __init__(self, overrides: dict[str, Capability] | None = None) -> None:
        self.overrides = overrides or {}

    @classmethod
    def from_config(cls, cfg: ProxyConfig) -> "Capabilities":
        return cls(cfg.capabilities)

    def lookup(self, route_key: str) -> Capability:
        # Exact config key first, then config globs, then the baseline.
        if route_key in self.overrides:
            return self.overrides[route_key]
        for pattern, cap in self.overrides.items():
            if fnmatch.fnmatch(route_key, pattern):
                return cap
        for pattern, cap in _BASELINE:
            if fnmatch.fnmatch(route_key, pattern):
                return cap
        return Capability()

    @staticmethod
    def _sampling_allowed(cap: Capability) -> set[str]:
        rule = cap.sampling
        if rule == "deny":
            return set()
        if isinstance(rule, (list, tuple)):
            return set(rule)
        return set(_SAMPLING_FIELDS)

    def normalize(
        self, req: CanonRequest, mode: str = "strip_and_warn"
    ) -> CanonRequest:
        """Make `req` legal for its target model, recording what changed."""
        key = req.route()
        cap = self.lookup(key)
        warn = req.warnings.append
        reject = mode == "reject"
        silent = mode == "strip_silent"

        def drop(field: str, why: str) -> None:
            if reject:
                raise InvalidRequest(
                    f"{field} is not supported by {key}: {why}", detail={"param": field}
                )
            if not silent:
                warn(f"dropped {field} ({why})")

        # --- sampling ---------------------------------------------------------
        allowed = self._sampling_allowed(cap)
        for field in _SAMPLING_FIELDS:
            if getattr(req.sampling, field, None) is None:
                continue
            if field not in allowed:
                setattr(req.sampling, field, None)
                drop(
                    field,
                    f"{req.model_id} rejects it with a 400; steer with prompting instead",
                )

        # --- thinking / effort ------------------------------------------------
        r = req.reasoning
        if cap.thinking == "none":
            if r.mode != "auto" or r.effort or r.budget_tokens:
                r.mode, r.effort, r.budget_tokens = "auto", None, None
                drop("thinking", f"{key} has no thinking controls")
        elif cap.thinking == "always_on":
            if r.mode == "off":
                r.mode = "auto"
                drop("thinking.disabled", f"{req.model_id} cannot disable thinking")
            if r.budget_tokens is not None:
                r.budget_tokens = None
                drop("budget_tokens", "removed on this model; use effort")
        elif cap.thinking == "adaptive_only":
            if r.budget_tokens is not None:
                r.budget_tokens = None
                drop("budget_tokens", "removed on this model; use effort")
            # `disabled` above a threshold is a 400 — cap the effort rather than
            # failing, since the caller's intent (cheap and fast) is still servable.
            limit = cap.disable_thinking_max_effort
            if r.mode == "off" and limit and r.effort:
                if _EFFORT_ORDER.index(r.effort) > _EFFORT_ORDER.index(limit):
                    old = r.effort
                    r.effort = limit
                    drop(
                        "effort",
                        f"{req.model_id} rejects thinking:disabled above effort "
                        f"'{limit}' (was '{old}')",
                    )

        # --- tools / images ---------------------------------------------------
        if cap.tools == "deny" and req.tools:
            raise UnsupportedFeature(
                f"alias '{req.alias}' routes to {key}, which cannot serve tool_use. "
                f"Point it at a provider that can, or drop `tools` from the request.",
                detail={"alias": req.alias, "route": key},
            )
        if cap.images == "deny":
            if any(b.type == "image" for m in req.messages for b in m.content):
                raise UnsupportedFeature(
                    f"alias '{req.alias}' routes to {key}, which cannot accept images.",
                    detail={"alias": req.alias, "route": key},
                )

        # --- prefill ----------------------------------------------------------
        if cap.prefill == "deny" and req.messages and req.messages[-1].role == "assistant":
            # A trailing assistant turn is a 400 on every current Anthropic model.
            # Common OpenAI idiom ("continue this"), so convert rather than reject.
            req.messages[-1].role = "user"
            drop(
                "assistant prefill",
                f"{req.model_id} rejects a trailing assistant turn; converted to a "
                "user turn. Use response_format for structured output instead",
            )

        # --- max_tokens -------------------------------------------------------
        if cap.max_output_tokens and req.max_tokens:
            if req.max_tokens > cap.max_output_tokens:
                old = req.max_tokens
                req.max_tokens = cap.max_output_tokens
                drop("max_tokens", f"clamped {old} -> {cap.max_output_tokens} (model ceiling)")

        thinking_on = r.mode == "on" or (r.mode == "auto" and cap.thinking_default == "on")
        floor = cap.min_effective_max_tokens
        if thinking_on and floor and req.max_tokens is not None and req.max_tokens < floor:
            # max_tokens caps thinking AND visible text together. A client's habitual
            # max_tokens=500 against a thinking-by-default model yields an empty
            # answer plus an uninterpretable finish_reason:"length".
            old = req.max_tokens
            req.max_tokens = floor
            if not silent:
                warn(
                    f"raised max_tokens {old} -> {floor}: thinking counts against "
                    f"max_tokens on {req.model_id}, and {old} would truncate before "
                    "any visible text is produced"
                )
        return req
