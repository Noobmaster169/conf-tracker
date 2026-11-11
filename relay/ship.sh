#!/usr/bin/env bash
# Builds the relay here, imports the image into the VPS's k3s and rolls it out. No registry: the image travels
# over SSH. Secrets come from frontend/.env.prod and relay/.env.ship and go straight into a k8s Secret; nothing
# is printed.
#
#   relay/ship.sh                 build, import, apply, wait for the rollout
#   RELAY_HOST=x.y relay/ship.sh  another hostname (default live.pintar.app)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
ssh_vps="${SSH_VPS:-$repo/../vps/yt-engine.sh}"
RELAY_HOST="${RELAY_HOST:-live.pintar.app}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://conf-tracker-six.vercel.app}"
ship_env="$here/.env.ship"
env_prod="${ENV_PROD:-$repo/frontend/.env.prod}"

# The secret the Vercel frontend signs tickets with. Made once; copy it to Vercel as RELAY_SECRET.
if [ ! -s "$ship_env" ]; then
  umask 077
  echo "RELAY_SECRET=$(openssl rand -hex 32)" > "$ship_env"
  echo "made $ship_env (set the same RELAY_SECRET on Vercel)"
fi

value() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2-; }
upstream="$(value BACKEND_URL "$env_prod")"
api_secret="$(value API_SHARED_SECRET "$env_prod")"
relay_secret="$(value RELAY_SECRET "$ship_env")"
[ -n "$upstream" ] && [ -n "$api_secret" ] && [ -n "$relay_secret" ] || { echo "missing BACKEND_URL, API_SHARED_SECRET or RELAY_SECRET" >&2; exit 1; }

sha="$(git -C "$repo" rev-parse --short HEAD)$(git -C "$repo" diff --quiet -- relay || echo -dirty)"
image="conf-relay:$sha"

echo "build $image"
docker build -q -t "$image" "$here" >/dev/null

echo "import into k3s"
docker save "$image" | "$ssh_vps" -o BatchMode=yes 'k3s ctr images import - >/dev/null'

echo "secret and manifest"
"$ssh_vps" -o BatchMode=yes 'kubectl get ns conf-relay >/dev/null 2>&1 || kubectl create ns conf-relay >/dev/null'
printf 'UPSTREAM_URL=%s\nAPI_SHARED_SECRET=%s\nRELAY_SECRET=%s\nALLOWED_ORIGINS=%s\n' "$upstream" "$api_secret" "$relay_secret" "$ALLOWED_ORIGINS" |
  "$ssh_vps" -o BatchMode=yes 'kubectl -n conf-relay create secret generic conf-relay-env --from-env-file=/dev/stdin --dry-run=client -o yaml | kubectl apply -f - >/dev/null'
IMAGE="$image" RELAY_HOST="$RELAY_HOST" envsubst '${IMAGE} ${RELAY_HOST}' < "$here/k8s/relay.yaml" |
  "$ssh_vps" -o BatchMode=yes 'kubectl apply -f -'

# A changed Secret alone does not restart the pod; this does, so the env is always the one just written.
"$ssh_vps" -o BatchMode=yes 'kubectl -n conf-relay rollout restart deploy/relay >/dev/null && kubectl -n conf-relay rollout status deploy/relay --timeout=120s'
echo "check: curl https://$RELAY_HOST/healthz"
