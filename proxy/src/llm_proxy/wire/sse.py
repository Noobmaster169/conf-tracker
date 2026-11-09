"""Server-Sent Events framing.

Anthropic names every frame (`event: content_block_delta`); an Anthropic SDK ignores
unnamed frames outright.
"""

from __future__ import annotations

from typing import Any

import orjson


def frame(data: Any, event: str) -> str:
    return f"event: {event}\ndata: {orjson.dumps(data).decode()}\n\n"
