"""Application state and the one request pipeline the endpoints share.

Order of operations:

    route -> capabilities -> provider -> cost
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import AsyncIterator

from .canon.request import CanonRequest
from .canon.response import CanonResponse
from .canon.stream import CanonEvent
from .capabilities import Capabilities
from .config import ProxyConfig
from .providers.registry import Registry
from .routing import Router


@dataclass
class AppState:
    config: ProxyConfig
    router: Router
    registry: Registry
    capabilities: Capabilities

    @classmethod
    def build(cls, config: ProxyConfig) -> "AppState":
        return cls(
            config=config,
            router=Router.from_config(config),
            registry=Registry.from_config(config),
            capabilities=Capabilities.from_config(config),
        )

    async def aclose(self) -> None:
        await self.registry.aclose()


def new_request_id() -> str:
    return f"req_{uuid.uuid4().hex[:24]}"


def _price(resp: CanonResponse) -> None:
    """A provider-reported figure is the only cost we know.

    claudecli reports one, and it is counterfactual — what the call would have cost
    via the API; no money leaves the account. Ollama and the mock report nothing and
    cost nothing.
    """
    resp.cost_usd = float(resp.usage.reported_cost_usd or 0.0)


class Pipeline:
    def __init__(self, state: AppState) -> None:
        self.state = state

    def prepare(self, req: CanonRequest) -> CanonRequest:
        """Bind the route and make the request legal for its model.

        Idempotent: the streaming endpoint calls this early so the response headers
        can name the resolved provider, and `stream()` calls it again defensively.
        Running capability normalisation twice would duplicate every warning.
        """
        if req.provider:
            return req
        if not req.request_id:
            req.request_id = new_request_id()
        self.state.router.apply(req)
        self.state.capabilities.normalize(req, self.state.config.on_unsupported_param)
        return req

    async def complete(self, req: CanonRequest) -> CanonResponse:
        self.prepare(req)
        provider = self.state.registry.get(req.provider)
        resp = await provider.complete(req)
        resp.alias = req.alias
        resp.warnings = list(req.warnings)
        if not resp.id:
            resp.id = req.request_id
        _price(resp)
        return resp

    async def stream(self, req: CanonRequest) -> AsyncIterator[CanonEvent]:
        self.prepare(req)
        provider = self.state.registry.get(req.provider)
        async for event in provider.stream(req):
            yield event
