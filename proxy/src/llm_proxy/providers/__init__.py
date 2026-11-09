"""Provider adapters. Each speaks the canonical IR, never a wire dialect."""

from .base import BlockingOnly, Provider, StreamOnly

__all__ = ["Provider", "StreamOnly", "BlockingOnly"]
