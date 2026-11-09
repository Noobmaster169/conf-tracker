"""Proxy error hierarchy and wire-format rendering.

Every failure the proxy generates itself (as opposed to relaying from a provider)
becomes a `ProxyError`. Each carries an HTTP status and a stable machine-readable
`code`, and renders into the Anthropic error envelope — a caller that gets the wrong
shape sees an SDK parse failure instead of the real message.
"""

from __future__ import annotations

from typing import Any


class ProxyError(Exception):
    """Base for every error the proxy raises on its own behalf."""

    status: int = 500
    code: str = "proxy_error"
    # Anthropic's error envelope has a small closed set of `type` values; map onto
    # the nearest one so client SDKs classify our errors the same way they classify
    # the upstream's.
    anthropic_type: str = "api_error"
    retryable: bool = False

    def __init__(self, message: str, *, detail: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail or {}


class ConfigError(ProxyError):
    """proxy.yaml is malformed or internally inconsistent. Raised at startup."""

    status = 500
    code = "config_error"


class UnknownModel(ProxyError):
    status = 404
    code = "unknown_model"
    anthropic_type = "not_found_error"


class UnknownProvider(ConfigError):
    code = "unknown_provider"


class InvalidRequest(ProxyError):
    status = 400
    code = "invalid_request"
    anthropic_type = "invalid_request_error"


class UnsupportedFeature(InvalidRequest):
    """The route is valid but the target provider cannot serve this request.

    Deliberately an error rather than a silent degrade: a caller who sends tools to
    `claudecli` and gets a toolless answer back has a much worse day than one who
    gets told to use a different alias.
    """

    code = "unsupported_feature"


class ProviderError(ProxyError):
    """An upstream provider failed and we exhausted retries."""

    status = 502
    code = "provider_error"
    retryable = True

    def __init__(
        self,
        message: str,
        *,
        provider: str = "",
        upstream_status: int | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, detail=detail)
        self.provider = provider
        self.upstream_status = upstream_status


class RateLimited(ProviderError):
    """Upstream said 429/overloaded and backoff was exhausted.

    Kept distinct from ProviderError so batch callers can react by dropping
    concurrency or checkpointing rather than treating it as fatal.
    """

    status = 429
    code = "rate_limited"
    anthropic_type = "rate_limit_error"



class ProviderNotLoggedIn(ProviderError):
    """The provider refused the proxy's own credentials: `claude` is not logged in.

    Not retryable, unlike ProviderError. No attempt succeeds until someone logs it
    in, and a caller that reads `retryable` to decide between pausing and failing
    would otherwise wait out an outage that is really a missing secret.
    """

    code = "provider_not_logged_in"
    retryable = False

class ProviderTimeout(ProviderError):
    status = 504
    code = "provider_timeout"


class ClientGone(ProxyError):
    """The caller hung up before the answer was ready, so the work was abandoned.

    Nobody reads this body. It exists so the event is logged as itself rather
    than as a mystery, and marked retryable because nothing about the request
    was wrong.
    """

    status = 499
    code = "client_gone"
    retryable = True


def render_error(err: ProxyError) -> tuple[int, dict[str, Any]]:
    """Render a ProxyError into the Anthropic error envelope.

    `code` and `retryable` are additive fields alongside Anthropic's own closed
    set, because the status cannot carry the difference a caller most needs: an
    unknown provider and a dead upstream are both 500, but only one of them is
    worth trying again. A caller that retries on status alone retries a
    misconfiguration until someone notices.
    """
    body: dict[str, Any] = {
        "type": "error",
        "error": {
            "type": err.anthropic_type,
            "message": err.message,
            "code": err.code,
            "retryable": err.retryable,
        },
    }
    if err.detail:
        body["error"]["detail"] = err.detail
    return err.status, body
