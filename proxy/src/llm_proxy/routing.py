"""Alias -> (provider, model_id, defaults, fallbacks)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .canon.request import CanonRequest
from .config import ModelParams, ProxyConfig
from .errors import UnknownModel


@dataclass(frozen=True)
class ModelRoute:
    alias: str
    provider: str
    model_id: str
    params: ModelParams
    fallbacks: tuple[str, ...] = ()

    def key(self) -> str:
        """The `provider/model_id` string used to look up capabilities."""
        return f"{self.provider}/{self.model_id}"


@dataclass
class Router:
    routes: dict[str, ModelRoute] = field(default_factory=dict)

    @classmethod
    def from_config(cls, cfg: ProxyConfig) -> "Router":
        routes: dict[str, ModelRoute] = {}
        for entry in cfg.model_list:
            params = entry.resolved()
            provider, model_id = params.model.split("/", 1)
            routes[entry.model_name] = ModelRoute(
                alias=entry.model_name,
                provider=provider,
                model_id=model_id,
                params=params,
                fallbacks=tuple(entry.fallbacks),
            )
        return cls(routes=routes)

    def resolve(self, alias: str) -> ModelRoute:
        route = self.routes.get(alias)
        if route is not None:
            return route
        # Accept a fully-qualified "provider/model" even when no alias defines it, so
        # a caller can reach a new model without a config edit.
        if "/" in alias:
            provider, model_id = alias.split("/", 1)
            return ModelRoute(
                alias=alias, provider=provider, model_id=model_id, params=ModelParams(model=alias)
            )
        raise UnknownModel(
            f"unknown model {alias!r}. Configured aliases: "
            f"{', '.join(sorted(self.routes)) or 'none'}. You can also pass a literal "
            f"'provider/model_id'.",
            detail={"available": sorted(self.routes)},
        )

    def apply(self, req: CanonRequest) -> ModelRoute:
        """Bind a request to its route, filling in the alias's configured defaults.

        Client-supplied values always win; config only fills gaps. An alias that pins
        `max_tokens` is stating a ceiling for callers who did not think about it, not
        overriding one who did.
        """
        route = self.resolve(req.alias)
        req.provider = route.provider
        req.model_id = route.model_id

        p = route.params
        if req.max_tokens is None and p.max_tokens is not None:
            req.max_tokens = p.max_tokens
        if req.reasoning.effort is None and p.effort is not None:
            req.reasoning.effort = p.effort
        if p.thinking is not None and req.reasoning.mode == "auto":
            req.reasoning.mode = "off" if p.thinking == "disabled" else "on"
        if req.reasoning.display is None and p.thinking_display is not None:
            req.reasoning.display = p.thinking_display

        # Forward any unmodelled alias params to the provider.
        extras: dict[str, Any] = {
            k: v
            for k, v in (p.model_extra or {}).items()
            if k not in req.extra
        }
        if extras:
            req.extra.update(extras)
        return route
