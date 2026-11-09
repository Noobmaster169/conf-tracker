"""Process-level settings. Everything else lives in proxy.yaml."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    config_path: Path

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(config_path=Path(os.getenv("LLM_PROXY_CONFIG", _ROOT / "proxy.yaml")))
