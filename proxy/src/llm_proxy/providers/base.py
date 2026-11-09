"""The provider contract.

Every provider speaks canonical, never wire. Two mixins mean each adapter implements
only the direction it is natively good at:

  * `StreamOnly` — implement `stream()`; `complete()` falls out of `aggregate()`.
  * `BlockingOnly` — implement `complete()`; `stream()` falls out of `explode()`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator

from ..canon.request import CanonRequest
from ..canon.response import CanonResponse
from ..canon.stream import CanonEvent, StreamError, aggregate, explode
from ..config import ProviderConfig
from ..errors import InvalidRequest, ProviderError, ProviderTimeout, ProxyError, RateLimited


class Provider(ABC):
    """Base class. `name` is the key under `providers:` in proxy.yaml."""

    type: str = "base"

    def __init__(self, name: str, cfg: ProviderConfig) -> None:
        self.name = name
        self.cfg = cfg

    @abstractmethod
    async def complete(self, req: CanonRequest) -> CanonResponse: ...

    @abstractmethod
    def stream(self, req: CanonRequest) -> AsyncIterator[CanonEvent]: ...

    async def aclose(self) -> None:
        return None


# StreamError.code -> the exception a blocking caller should see, so an unreachable
# upstream is a 502 and a rate limit a 429 rather than a generic 500.
_STREAM_ERRORS: dict[str, type[ProxyError]] = {
    "rate_limited": RateLimited,
    "provider_timeout": ProviderTimeout,
    "invalid_request": InvalidRequest,
}


class StreamOnly(Provider):
    """Native streaming; blocking responses are aggregated from the event list."""

    async def complete(self, req: CanonRequest) -> CanonResponse:
        events: list[CanonEvent] = []
        async for ev in self.stream(req):
            if ev.type == "error":
                raise _STREAM_ERRORS.get(ev.code, ProviderError)(ev.message)
            events.append(ev)
        return aggregate(events)


class BlockingOnly(Provider):
    """Native blocking; streams are synthesised so clients still get SSE framing."""

    async def stream(self, req: CanonRequest) -> AsyncIterator[CanonEvent]:
        try:
            resp = await self.complete(req)
        except ProxyError as e:
            # Yielded, not raised: by the time a stream body is being produced the
            # HTTP status is already sent, so raising would truncate with no message.
            yield StreamError(code=e.code, message=e.message, retryable=e.retryable)
            return
        for ev in explode(resp):
            yield ev
