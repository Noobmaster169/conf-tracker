"""POST /v1/messages — the Anthropic Messages API surface."""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

from fastapi import APIRouter, Request

from .. import attribution
from ..canon.response import CanonResponse
from ..errors import ClientGone
from ..service import Pipeline
from ..wire import anthropic_in, anthropic_out, sse
from .common import json_response, pipeline, read_json, sse_response

router = APIRouter()

# Long enough to cost nothing on a normal call, short enough that an abandoned
# slot is released in seconds rather than at the provider's own timeout.
DISCONNECT_POLL_S = 1.0


async def _until_gone(request: Request) -> None:
    while not await request.is_disconnected():
        await asyncio.sleep(DISCONNECT_POLL_S)


async def _complete(pipe: Pipeline, req, request: Request) -> CanonResponse:
    """Run the call, and stop it if the caller stops waiting.

    `claude -p` holds one of very few concurrency slots for as long as it runs,
    and a caller whose own timeout has fired has already requeued its job. Left
    running, the abandoned call keeps its slot and everything else queues behind
    an answer nobody will read. The providers already reap their child on
    cancellation; until now nothing ever cancelled them.
    """
    work = asyncio.ensure_future(pipe.complete(req))
    gone = asyncio.ensure_future(_until_gone(request))
    try:
        done, _ = await asyncio.wait({work, gone}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        gone.cancel()
    if work in done:
        return work.result()
    work.cancel()
    raise ClientGone(f"caller disconnected before {req.model_id or req.model} answered")


@router.post("/v1/messages")
async def messages(request: Request):
    body = await read_json(request)
    req = anthropic_in.parse(body)
    req.project = attribution.resolve(
        request.headers, metadata_user=(body.get("metadata") or {}).get("user_id")
    )

    pipe = pipeline(request)

    if not req.stream:
        resp = await _complete(pipe, req, request)
        return json_response(anthropic_out.render(resp), req, resp)

    # Bound before the body starts so the headers can name the resolved provider.
    pipe.prepare(req)

    async def frames() -> AsyncIterator[str]:
        async for event in pipe.stream(req):
            for name, data in anthropic_out.event_frames(event, req.request_id, req.model_id):
                # Anthropic SSE names every frame; an unnamed one is ignored by the SDK.
                yield sse.frame(data, event=name)

    return sse_response(frames, req)
