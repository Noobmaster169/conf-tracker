"""Build provider instances from config and hand them out by name."""

from __future__ import annotations

from ..config import ProxyConfig
from ..errors import UnknownProvider
from .base import Provider
from .claude_cli import ClaudeCliProvider
from .mock import MockProvider
from .openai_api import OpenAIProvider

_TYPES: dict[str, type[Provider]] = {
    "mock": MockProvider,
    "openai_compatible": OpenAIProvider,
    "claudecli": ClaudeCliProvider,
}


class Registry:
    def __init__(self, providers: dict[str, Provider]) -> None:
        self._providers = providers

    @classmethod
    def from_config(cls, cfg: ProxyConfig) -> "Registry":
        built: dict[str, Provider] = {}
        for name, pcfg in cfg.providers.items():
            impl = _TYPES.get(pcfg.type)
            if impl is None:
                raise UnknownProvider(
                    f"provider '{name}' has type '{pcfg.type}', which is not available "
                    f"(known: {', '.join(sorted(_TYPES))})"
                )
            built[name] = impl(name, pcfg)
        return cls(built)

    def get(self, name: str) -> Provider:
        provider = self._providers.get(name)
        if provider is None:
            raise UnknownProvider(
                f"provider '{name}' is not configured "
                f"(configured: {', '.join(sorted(self._providers)) or 'none'})"
            )
        return provider

    def names(self) -> list[str]:
        return sorted(self._providers)

    async def aclose(self) -> None:
        for provider in self._providers.values():
            await provider.aclose()
