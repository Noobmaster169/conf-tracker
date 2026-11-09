"""Shared endpoint plumbing: state access, response headers, streaming helper."""

from __future__ import annotations

from typing import Any, AsyncIterator, Callable

import orjson
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from ..canon.request import CanonRequest
from ..canon.response import CanonResponse
from ..errors import InvalidRequest
from ..service import AppState, Pipeline


def state(request: Request) -> AppState:
    return request.app.state.proxy


def pipeline(request: Request) -> Pipeline:
    return Pipeline(state(request))


async def read_json(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if not raw:
        raise InvalidRequest("request body is empty")
    try:
        parsed = orjson.loads(raw)
    except orjson.JSONDecodeError as e:
        raise InvalidRequest(f"request body is not valid JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise InvalidRequest("request body must be a JSON object")
    return parsed


def proxy_headers(req: CanonRequest, resp: CanonResponse | None = None) -> dict[str, str]:
    """`X-LLM-Proxy-*` diagnostics on every response.

    Cheap, and it means a misbehaving caller is diagnosed from `curl -i`.
    """
    headers = {
        "X-LLM-Proxy-Request-Id": req.request_id,
        "X-LLM-Proxy-Project": req.project,
        "X-LLM-Proxy-Provider": req.provider,
        "X-LLM-Proxy-Model": req.model_id,
    }
    if resp is not None:
        headers["X-LLM-Proxy-Cost-USD"] = f"{resp.cost_usd:.6f}"
        headers["X-LLM-Proxy-Stop-Reason"] = resp.stop_reason.value
    warnings = list(req.warnings) + list(resp.warnings if resp else [])
    if warnings:
        # Header-safe: newlines and non-latin-1 would break the response.
        joined = "; ".join(w.replace("\n", " ") for w in dict.fromkeys(warnings))
        headers["X-LLM-Proxy-Warnings"] = joined.encode("ascii", "replace").decode()[:900]
    return headers


def json_response(body: dict[str, Any], req: CanonRequest, resp: CanonResponse) -> JSONResponse:
    return JSONResponse(content=body, headers=proxy_headers(req, resp))


def sse_response(frames: Callable[[], AsyncIterator[str]], req: CanonRequest) -> StreamingResponse:
    """Stream an SSE body.

    Only request-scoped headers are sent: cost and stop reason are not known until
    the body finishes, and headers flush first.
    """
    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={
            **proxy_headers(req),
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Stops nginx buffering the stream into one lump if anyone fronts this.
            "X-Accel-Buffering": "no",
        },
    )
