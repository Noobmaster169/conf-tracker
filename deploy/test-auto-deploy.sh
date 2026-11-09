#!/usr/bin/env bash
# Exercises auto-deploy.sh against a throwaway origin, clone and stack, with a fake docker.
#   bash deploy/test-auto-deploy.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }

# A fake docker: logs its arguments, fails a build when FAIL_BUILD=1.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_LOG"
if [ "${FAIL_BUILD:-0}" = 1 ] && [ "$2" = build ]; then exit 1; fi
exit 0
EOF
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" DOCKER_LOG="$TMP/docker.log"

# The origin holds the deploy files and one file per service.
git init -q -b main "$TMP/work"
cd "$TMP/work"
git config user.email t@t && git config user.name t
mkdir -p deploy backend proxy frontend
cp "$HERE/auto-deploy.sh" "$HERE/compose.yaml" "$HERE/run-ngrok.sh" deploy/
echo 1 > backend/x && echo 1 > proxy/x && echo 1 > frontend/x
git add -A && git commit -q -m one
git clone -q --bare "$TMP/work" "$TMP/origin.git"
git remote add origin "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/clone"
mkdir -p "$TMP/stack"
export CLONE="$TMP/clone" STACK="$TMP/stack"
run() { bash "$HERE/auto-deploy.sh"; }
push_backend_change() { cd "$TMP/work" && echo "$1" > backend/x && git commit -qam "$1" && git push -q origin main; }
head_of_origin() { git --git-dir="$TMP/origin.git" rev-parse main; }

run
check "first run deploys everything and writes the marker" '[ "$(cat "$STACK/.deployed")" = "$(head_of_origin)" ]'
check "first run rebuilt the api" 'grep -q "rebuilt and restarted:.* api" "$STACK/deploy.log"'

lines=$(wc -l < "$STACK/deploy.log")
run
check "a run with nothing new does nothing" '[ "$(wc -l < "$STACK/deploy.log")" = "$lines" ]'

old=$(cat "$STACK/.deployed")
push_backend_change two
FAIL_BUILD=1 run; rc=$?
check "a failed build exits non-zero" '[ "$rc" -ne 0 ]'
check "a failed build keeps the old marker" '[ "$(cat "$STACK/.deployed")" = "$old" ]'
check "a failed build is logged" 'grep -q "build failed at" "$STACK/deploy.log"'

: > "$DOCKER_LOG"
run
check "the next run retries the failed commit and moves the marker" '[ "$(cat "$STACK/.deployed")" = "$(head_of_origin)" ]'
check "the retry rebuilt the api" 'grep -q "build api" "$DOCKER_LOG"'

[ "$failures" = 0 ] && echo "all passed" || { echo "$failures failed"; exit 1; }
