"""App factory and lifespan."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import config as config_mod
from .api import messages, models
from .config import ProxyConfig
from .errors import ProxyError, render_error
from .service import AppState
from .settings import Settings

log = logging.getLogger("llm_proxy")


def create_app(cfg: ProxyConfig | None = None, settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    cfg = cfg if cfg is not None else config_mod.load(settings.config_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.build(cfg)
        app.state.proxy = state
        log.info(
            "retina-proxy ready: %d models across %d providers",
            len(state.router.routes), len(cfg.providers),
        )
        try:
            yield
        finally:
            await state.aclose()

    app = FastAPI(
        title="retina-proxy",
        version="0.1.0",
        description="Local LLM gateway speaking the Anthropic Messages API.",
        lifespan=lifespan,
    )

    # No CORS middleware is installed, deliberately. 127.0.0.1 is not a closed door:
    # any page in the user's browser can POST here. Without CORS headers the browser
    # blocks *reading* the response; this guard additionally refuses to do the work.
    allowed_origins = set(cfg.server.cors_origins)

    @app.middleware("http")
    async def origin_guard(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and origin not in allowed_origins:
            return JSONResponse(
                status_code=403,
                content={
                    "error": {
                        "message": (
                            f"cross-origin request from {origin} refused. This proxy has "
                            "no authentication and is meant for local processes only. Add "
                            "the origin to server.cors_origins if you genuinely need it."
                        ),
                        "type": "origin_not_allowed",
                    }
                },
            )
        return await call_next(request)

    @app.exception_handler(ProxyError)
    async def proxy_error_handler(request: Request, exc: ProxyError):
        status, body = render_error(exc)
        return JSONResponse(status_code=status, content=body)

    app.include_router(models.router)
    app.include_router(messages.router)
    return app


# Served via uvicorn's --factory flag (see start.sh) so that importing this module
# for tests does not require a config file to exist on disk.
