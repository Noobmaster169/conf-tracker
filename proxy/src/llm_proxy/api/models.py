"""GET /v1/models — the alias catalogue — and GET /healthz."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from .common import state

router = APIRouter()


@router.get("/v1/models")
async def list_models(request: Request):
    app_state = state(request)
    created = int(time.time())
    data = []
    for alias, route in sorted(app_state.router.routes.items()):
        data.append(
            {
                "id": alias,
                "object": "model",
                "created": created,
                "owned_by": route.provider,
                # Non-standard extras: harmless to SDKs, and they save a trip to the
                # config file when you are wondering where an alias points.
                "display_name": alias,
                "provider": route.provider,
                "model_id": route.model_id,
                "fallbacks": list(route.fallbacks),
            }
        )
    return {"object": "list", "data": data, "has_more": False, "first_id": None, "last_id": None}


@router.get("/healthz")
async def healthz(request: Request):
    app_state = state(request)
    return {
        "status": "ok",
        "providers": app_state.registry.names(),
        "models": sorted(app_state.router.routes),
    }
