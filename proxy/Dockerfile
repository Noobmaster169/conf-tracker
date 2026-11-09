# syntax=docker/dockerfile:1
#
# The llm-proxy, as a service of the compose stack (backend/compose.local.yaml
# on a laptop, deploy/compose.yaml on the box). Built from this directory:
#   docker build -t yt-stream-llm-proxy proxy
#
# It carries the Claude Code CLI, because the `claudecli` provider shells out to
# `claude -p`. The login is CLAUDE_CODE_OAUTH_TOKEN, passed in by compose from .env
# (make one with `claude setup-token`); nothing from the host's ~/.claude is mounted.

FROM python:3.12-slim

# 2.1.274 is the first CLI with --json-schema, which every pipeline step relies on.
# Pinned so a rebuild never changes the model's behaviour under a running phase.
ARG CLAUDE_CODE_VERSION=2.1.278

# Node only for the CLI. curl stays: the healthcheck and deploy/smoke-test.sh use it.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .
COPY proxy.yaml ./

# Unprivileged, with a home the CLI can write its state to. Not named `proxy`:
# debian-slim already has a system user by that name.
RUN useradd --create-home --uid 10001 llmproxy
USER llmproxy

# The container's own interface, which compose reaches as http://llm-proxy:4000.
# proxy.yaml refuses a non-loopback bind unless LLM_PROXY_EXPOSED says it is meant.
ENV LLM_PROXY_CONFIG=/app/proxy.yaml \
    LLM_PROXY_HOST=0.0.0.0 \
    LLM_PROXY_EXPOSED=true \
    LLM_PROXY_PORT=4000 \
    PYTHONUNBUFFERED=1

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD curl -fsS --max-time 2 http://127.0.0.1:4000/healthz >/dev/null || exit 1

# What start.sh runs, without its host port check, which means nothing in here.
CMD ["sh", "-c", "exec python -m uvicorn llm_proxy.main:create_app --factory --host \"$LLM_PROXY_HOST\" --port \"$LLM_PROXY_PORT\" --log-level \"${LLM_PROXY_LOG_LEVEL:-info}\""]
