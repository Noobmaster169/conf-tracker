"""Work out which project a request belongs to.

The proxy has no authentication — it binds loopback and rejects nothing. Every
request is still attributed, so `X-LLM-Proxy-Project` says *who* made it.

The sources are happy accidents worth exploiting: SDKs refuse to construct a client
without an API key, so every caller already sends one — `x-api-key` from the
Anthropic SDK, `Authorization: Bearer` from the OpenAI one. Treating a non-placeholder
token as a project name gives per-project attribution for free, with no key store
and no auth code. Nothing is ever rejected for presenting the "wrong" token.
"""

from __future__ import annotations

from typing import Mapping

UNATTRIBUTED = "unattributed"

# Values callers pass purely to satisfy an SDK constructor. Not project names.
_PLACEHOLDERS = {
    "", "unused", "dummy", "none", "null", "na", "n/a", "placeholder", "test",
    "sk-none", "sk-unused", "sk-dummy", "no-key", "nokey", "xxx", "-",
}


def _clean(value: str | None) -> str | None:
    if not value:
        return None
    token = value.strip()
    if token.lower() in _PLACEHOLDERS:
        return None
    # A real provider key pasted by mistake must never become a project label — it
    # would be echoed back in a response header and land in every log line.
    if token.startswith(("sk-ant-", "sk-proj-", "sk-or-", "nvapi-")) or len(token) > 64:
        return None
    return token


def resolve(headers: Mapping[str, str], metadata_user: str | None = None) -> str:
    auth = headers.get("authorization") or headers.get("Authorization")
    if auth:
        scheme, _, token = auth.partition(" ")
        candidate = _clean(token if scheme.lower() == "bearer" else auth)
        if candidate:
            return candidate

    for header in ("x-api-key", "x-llm-proxy-project"):
        candidate = _clean(headers.get(header))
        if candidate:
            return candidate

    return _clean(metadata_user) or UNATTRIBUTED
