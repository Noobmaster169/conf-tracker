"""Concurrency gating and retry classification.

Two properties are load-bearing and easy to lose in a rewrite:

  1. The semaphore lives at the PROVIDER, not at each call site, so a new call site
     cannot accidentally bypass the concurrency budget.
  2. Retryable-vs-fatal is decided by substring match on the error text, including
     some non-obvious entries (transient CLI startup noise) that are not rate limits
     but are equally not a reason to discard a long-running batch.

Backoff sleeps must happen OUTSIDE the semaphore: a rate limit is global, and
holding a slot while waiting would idle every other worker for no reason.
"""

from __future__ import annotations

import asyncio

# stdout/stderr fragments meaning "retry later" rather than "this call is broken".
RETRYABLE = (
    "rate limit", "rate_limit", "429", "overloaded", "overloaded_error",
    "usage limit", "capacity", "503", "502", "529", "timed out", "timeout",
    "connection error", "econnreset", "connection reset", "server error",
    # Transient Claude CLI startup noise. Not a rate limit, but killing an
    # unattended batch over it once cost an 11-minute run in the source project.
    "connectors are disabled", "takes precedence over your claude.ai login",
)
BACKOFF_S = (30, 90, 300, 900)

# Fragments meaning the CLI has no usable login. Checked before RETRYABLE: waiting
# does not log anyone in.
NOT_LOGGED_IN = (
    "not logged in", "please run /login", "invalid api key", "oauth token has expired",
    "token has been revoked", "authentication_error",
)


def is_login_failure(detail: str) -> bool:
    low = (detail or "").lower()
    return any(p in low for p in NOT_LOGGED_IN)


def is_retryable(detail: str) -> bool:
    low = (detail or "").lower()
    return any(p in low for p in RETRYABLE)


class ConcurrencyGate:
    """One semaphore per provider, created lazily on the running loop."""

    def __init__(self, limit: int) -> None:
        self.limit = max(1, limit)
        self._sem: asyncio.Semaphore | None = None

    def semaphore(self) -> asyncio.Semaphore:
        if self._sem is None:
            self._sem = asyncio.Semaphore(self.limit)
        return self._sem
