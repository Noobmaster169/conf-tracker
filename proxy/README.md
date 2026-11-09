# proxy

A small HTTP gateway. It speaks the Anthropic Messages API and routes each
request, by alias, to `claude -p` (the Claude subscription) or an offline echo.
The backend is its only client. It has no auth, so it is reachable only on the
compose network (and on host loopback 4003 in `backend/compose.local.yaml`).

## Run

It runs as the `llm-proxy` container of the backend's compose stack, built from
this directory with `Dockerfile`. The image carries the Claude Code CLI, pinned by
`CLAUDE_CODE_VERSION`, and logs in with `CLAUDE_CODE_OAUTH_TOKEN` (make one with
`claude setup-token`; compose reads it from `backend/.env`, or `~/conf-tracker/.env`
on the box).

```sh
cd ../backend && docker compose -f compose.local.yaml up -d --build llm-proxy   # :4003 on the host
```

To work on the proxy itself, it still runs outside a container:

```sh
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
./start.sh                      # 127.0.0.1:4000, config from ./proxy.yaml, your own claude login
.venv/bin/pytest -q             # tests, all offline
```

Env overrides: `LLM_PROXY_HOST`, `LLM_PROXY_PORT`, `LLM_PROXY_CONFIG`.
`proxy.yaml` reads `${NAME:-default}` from the env; the image sets
`LLM_PROXY_HOST=0.0.0.0` and `LLM_PROXY_EXPOSED=true`, and nothing else in the
file differs between a laptop and the container.

A `claude` with no login answers 502 `provider_not_logged_in` with
`retryable: false`: no attempt succeeds until someone logs it in, so a caller
must not wait it out as an outage.

## Aliases

Set in `proxy.yaml`. The alias is the model name.

| Alias | Goes to | Needs |
| --- | --- | --- |
| `sonnet`, `opus`, `haiku` | `claude -p --model <alias>` | a login: the token in the container, `claude` itself outside |
| `test` | echo | nothing |

You can also send `provider/model` directly, e.g. `claudecli/sonnet`. Ollama and
the Qwen aliases were dropped when the proxy moved into the stack; the
`openai_compatible` provider type is still in the code if a local model returns.

## Endpoints

```sh
curl -s 127.0.0.1:4000/healthz
curl -s 127.0.0.1:4000/v1/models
curl -si 127.0.0.1:4000/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: dev' \
  -d '{"model":"test","max_tokens":20,"messages":[{"role":"user","content":"ping"}]}'
```

`/v1/messages` takes and returns the Anthropic Messages shape. `"stream": true`
gives SSE. `x-api-key` is a label, not a key; it comes back as
`X-LLM-Proxy-Project`. Other headers: `X-LLM-Proxy-Model`, `-Cost-USD`,
`-Provider`, `-Request-Id`, and `-Warnings` when a parameter was dropped.

Errors use the Anthropic error shape: 404 unknown alias, 400 unsupported
request, 502/503/504 upstream failure.

## Streaming

`"stream": true` streams token by token: the provider runs `claude -p --output-format
stream-json --verbose --include-partial-messages` and forwards each text delta as an
Anthropic `content_block_delta`. Verified live: the first delta at about 2.4 s, then
deltas as the model writes. A request with a schema streams too: its deltas are the JSON as
the model writes it (the CLI's StructuredOutput call), a preview, and the validated answer
arrives on the final `message_delta` as `structured_output`, with `usage.cost_usd` (headers
go out before a stream's cost is known). Each attempt at a schema answer is its own content
block: the model sometimes writes a malformed attempt that the CLI rejects before a valid one.
A failed session ends in an `error` event carrying `code` and `retryable`, never in text.

## Tools

A `claude -p` session gets exactly the built-in tools its provider lists in
`proxy.yaml` (`tools:`), and none by default. Without a `--tools` flag the CLI would
load its whole default set (Bash, Edit, Write, WebFetch, WebSearch and twenty more)
into every call. The listed tools are also pre-approved with `--allowedTools`, since
nobody answers a permission prompt in `-p` mode.

To give a model web search, uncomment the `claudecli_web` provider, its `sonnet-web`
alias and its capabilities entry in `proxy.yaml`, then rebuild the container. The
pipeline's `sonnet` keeps no tools. This is the CLI's own tool use; the Messages API's
client-defined `tools` field is still refused for `claudecli`.

## Structured output

`output_config: { format: { type: "json_schema", schema } }` on a request makes the
schema a constraint on the provider, not a request in the prompt:

- `claudecli` passes it to `claude -p --json-schema` and reads the answer from the
  envelope's `structured_output`. This needs Claude Code **2.1.274 or newer** (that is
  where `--json-schema` was checked; 2.1.276 was used for the phase 2 live run). An older
  CLI returns no `structured_output`, and the provider answers 502 rather than pass prose
  on as if it were JSON. Streamed, the JSON is a preview and the validated object comes last.
- An `openai_compatible` provider, where one is configured, gets
  `response_format: { type: "json_schema", json_schema: { name, schema, strict } }`.

The schema subset does not carry numeric or string bounds (`minimum`, `maxLength`);
those are advisory and the caller still validates the answer.

## What the config does

- `capabilities` strips parameters a model rejects. `temperature` never reaches
  Claude.
- A request without `max_tokens` is fine: `claude -p` has no cap of its own.
