#!/usr/bin/env bash
# Exercises auto-deploy.sh against a throwaway origin, clone and stack, with a fake docker and a fake curl.
#   bash deploy/test-auto-deploy.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
# Everything below writes under $TMP; with it empty the fakes would land in /bin.
[ -n "$TMP" ] && [ -d "$TMP" ] || { echo "no temporary directory"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }

# A fake docker: logs its arguments, fails a build when FAIL_BUILD=1.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_LOG"
if [ "${FAIL_BUILD:-0}" = 1 ] && [ "$2" = build ]; then exit 1; fi
# Putting the previous image back is what makes a sick api healthy again.
if [ "$1" = tag ] && [ "$2" = conf-tracker-api:prev ]; then rm -f "$SICK"; fi
exit 0
FAKE
# A fake curl, which auto-deploy.sh asks only for /health: down while $SICK exists, and listing a video while $LIVE does.
cat > "$TMP/bin/curl" <<'FAKE'
#!/usr/bin/env bash
[ -e "$SICK" ] && exit 22
if [ -e "$LIVE" ]; then echo '{"status":"ok","live":["6f1c9a52-0b1e-4c57-9d0a-3c1d2e4f5a6b"]}'; else echo '{"status":"ok","live":[]}'; fi
FAKE
chmod +x "$TMP/bin/docker" "$TMP/bin/curl"
export PATH="$TMP/bin:$PATH" DOCKER_LOG="$TMP/docker.log" SICK="$TMP/sick" LIVE="$TMP/live"
# Nothing answers on this port, so box-ops.py finds no api, as on a box whose api is down. test-box-ops.sh tests it with one.
export API="http://127.0.0.1:1" HEALTH_TRIES=2 HEALTH_SLEEP=0

# The origin holds the deploy files and one file per service.
git init -q -b main "$TMP/work"
cd "$TMP/work"
git config user.email t@t && git config user.name t
mkdir -p deploy backend proxy frontend
cp "$HERE/auto-deploy.sh" "$HERE/compose.yaml" "$HERE/run-ngrok.sh" "$HERE/box-ops.py" deploy/
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

# A force-push rewrites main; the deploy-only clone follows it instead of wedging on --ff-only.
cd "$TMP/work" && git reset -q --hard HEAD~1 && echo forced > backend/x && git commit -qam forced && git push -qf origin main
: > "$DOCKER_LOG"
run; rc=$?
check "a force-push deploys" '[ "$rc" -eq 0 ]'
check "a force-push moves the marker to the new main" '[ "$(cat "$STACK/.deployed")" = "$(head_of_origin)" ]'
check "the clone follows the forced main" '[ "$(git -C "$CLONE" rev-parse HEAD)" = "$(head_of_origin)" ]'
check "a force-push rebuilt the api" 'grep -q "build api" "$DOCKER_LOG"'

# A build that keeps failing is tried three times, then left alone until main moves.
push_backend_change broken
for _ in 1 2 3; do FAIL_BUILD=1 run; done
: > "$DOCKER_LOG"
FAIL_BUILD=1 run
check "a commit whose build failed three times is not built a fourth" '! grep -q "build" "$DOCKER_LOG"'
push_backend_change mended
run
check "a new commit is tried again after a give-up" '[ "$(cat "$STACK/.deployed")" = "$(head_of_origin)" ] && [ ! -e "$STACK/.failed" ]'

# An api that does not come up healthy: the image that was running is put back and the marker stays.
old=$(cat "$STACK/.deployed")
push_backend_change crashes
: > "$DOCKER_LOG"
touch "$SICK"; run; rc=$?
check "an unhealthy api exits non-zero and keeps the old marker" '[ "$rc" -ne 0 ] && [ "$(cat "$STACK/.deployed")" = "$old" ]'
check "the previous image is kept before the build and put back after" 'grep -q "tag conf-tracker-api:local conf-tracker-api:prev" "$DOCKER_LOG" && grep -q "tag conf-tracker-api:prev conf-tracker-api:local" "$DOCKER_LOG"'
check "the roll back is logged as healthy" 'grep -q "put the previous api image back; it is healthy" "$STACK/deploy.log"'
: > "$DOCKER_LOG"
run
check "a commit that crashed on start is not tried again" '! grep -q "build" "$DOCKER_LOG"'

# A deploy that restarts the api waits while a video runs; a frontend-only one does not.
push_backend_change fixed
touch "$LIVE"; : > "$DOCKER_LOG"
run; run
check "a backend deploy is held back while a video runs" '! grep -q "build" "$DOCKER_LOG" && [ "$(cat "$STACK/.deferred")" = "$(head_of_origin)" ]'
check "being held back is logged once, not on every pass" '[ "$(grep -c "holding $(head_of_origin) back" "$STACK/deploy.log")" = 1 ]'
check "the clone still follows main while a deploy is held back" '[ "$(git -C "$CLONE" rev-parse HEAD)" = "$(head_of_origin)" ]'
touch "$STACK/.force"
run
check "a deploy-now lets it through and is used up" '[ "$(cat "$STACK/.deployed")" = "$(head_of_origin)" ] && [ ! -e "$STACK/.force" ] && [ ! -e "$STACK/.deferred" ]'
cd "$TMP/work" && echo 2 > frontend/x && git commit -qam web && git push -q origin main
: > "$DOCKER_LOG"
run
check "a frontend-only deploy goes out while a video runs" 'grep -q "build web" "$DOCKER_LOG" && [ "$(cat "$STACK/.deployed")" = "$(head_of_origin)" ]'
cd "$TMP/work" && echo 3 > backend/x && git commit -qam "urgent [deploy-now]" && git push -q origin main
run
check "[deploy-now] in the commit message deploys while a video runs" '[ "$(cat "$STACK/.deployed")" = "$(head_of_origin)" ]'
rm -f "$LIVE"

# A script that does not parse is not installed over the one that works.
cp "$STACK/auto-deploy.sh" "$TMP/good.sh"
cd "$TMP/work" && echo 'if then fi (' > deploy/auto-deploy.sh && git commit -qam "broken script" && git push -q origin main
run
check "an auto-deploy.sh that does not parse is not installed" 'cmp -s "$STACK/auto-deploy.sh" "$TMP/good.sh" && grep -q "does not parse" "$STACK/deploy.log"'
cd "$TMP/work" && cp "$HERE/auto-deploy.sh" deploy/ && git commit -qam "script back" && git push -q origin main
run

# A one-shot script runs once, ever, and its output is kept.
cd "$TMP/work" && mkdir -p deploy/ops.d && echo 'echo "hello from $(basename "$PWD")"' > deploy/ops.d/001-hello.sh && git add -A && git commit -qm oneshot && git push -q origin main
run; run
check "a one-shot script runs in the stack directory and its output is kept" 'grep -q "hello from stack" "$STACK/ops-out/001-hello.sh.log"'
check "a one-shot script runs once" '[ "$(grep -c 001-hello.sh "$STACK/.ops-done")" = 1 ]'

# The installed copy is what cron runs, so it is the one that must work: run it instead of the repo's.
bash "$STACK/auto-deploy.sh"; rc=$?
check "the installed copy runs clean" '[ "$rc" -eq 0 ]'
check "the helper does not keep the deploy lock" 'flock -n "$STACK/.deploy.lock" true'
check "the clone is left clean" '[ -z "$(git -C "$CLONE" status --porcelain)" ]'

[ "$failures" = 0 ] && echo "all passed" || { echo "$failures failed"; exit 1; }
