#!/usr/bin/env bash
# Pull-based deploy, and the only way anything reaches the box once nobody can log in to it. GitHub cannot reach the
# box, so cron runs this every three minutes. Each pass:
#
#   1. brings the clone to origin/main;
#   2. runs the jobs queued through the api (box-ops.py jobs; POST /ops/jobs);
#   3. deploys, when origin/main differs from the last commit that deployed cleanly ($STACK/.deployed): copies the
#      stack files and rebuilds the api image when backend/ changed, the proxy image when proxy/ changed and the web
#      image when frontend/ changed;
#   4. runs each new deploy/ops.d/*.sh once (box-ops.py oneshots);
#   5. posts what the box looks like to the api (box-ops.py report; GET /ops/status).
#
# What keeps a bad push from cutting the line:
#   - a deploy that would restart the api is held back while a video is running, since a restart ends it. A
#     `deploy-now` job, or [deploy-now] in the commit message, lets it through;
#   - the marker moves only once the new api answers /health. If it does not, the image that was running is put back
#     and the commit is not tried again;
#   - a build that fails is tried three times, then left alone until main moves;
#   - a copy of this script or of run-ngrok.sh that does not parse is not installed.
#
# Speech is yt-stream's service, not part of this stack; this script never touches it.
# It never writes ~/conf-tracker/.env and never touches Postgres data.
#
# Install: crontab -e -> */3 * * * * /home/student/conf-tracker/auto-deploy.sh
# Test: bash deploy/test-auto-deploy.sh
set -euo pipefail
CLONE="${CLONE:-$HOME/projects/conf-tracker}"
STACK="${STACK:-$HOME/conf-tracker}"
API="${API:-http://127.0.0.1:8094}"
LOG="$STACK/deploy.log"
MARKER="$STACK/.deployed"
FAILED="$STACK/.failed"
HELD="$STACK/.deferred"
FORCE="$STACK/.force"

exec 9>"$STACK/.deploy.lock"
flock -n 9 || exit 0

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

# The helper is read from the clone, so it is as new as main. It can never stop a deploy: it is bounded, its failure
# is ignored, and it does not inherit the lock.
box_ops() {
  [ -f "$CLONE/deploy/box-ops.py" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  CLONE="$CLONE" STACK="$STACK" API="$API" timeout 1200 python3 "$CLONE/deploy/box-ops.py" "$1" >> "$STACK/box-ops.log" 2>&1 9>&- || true
}

healthy() {
  local i
  for i in $(seq 1 "${HEALTH_TRIES:-36}"); do
    if curl -fs -m 5 "$API/health" >/dev/null 2>&1; then return 0; fi
    sleep "${HEALTH_SLEEP:-5}"
  done
  return 1
}

# A video is running: /health lists it. An api that does not answer has nothing to protect.
busy() { curl -fs -m 5 "$API/health" 2>/dev/null | grep -q '"live":\["'; }

give_up() { echo "$1 $2" > "$FAILED.new" && mv -f "$FAILED.new" "$FAILED"; }

# Called as `deploy || rc=$?`, where bash ignores `set -e`: every step that can fail says what happens then.
deploy() {
  local after deployed f services="" tries=0 failed_sha=""
  after=$(git rev-parse origin/main) || return 1
  deployed=$(cat "$MARKER" 2>/dev/null || echo none)
  if [ "$deployed" = "$after" ]; then
    rm -f "$HELD"
    return 0
  fi
  if [ -f "$FAILED" ]; then read -r failed_sha tries < "$FAILED" || true; fi
  [ "$failed_sha" = "$after" ] || tries=0
  # This commit has had its tries. Main moving, or a `redeploy` job, starts again.
  if [ "${tries:-0}" -ge 3 ]; then return 0; fi

  changed() {
    [ "$deployed" = none ] && return 0
    ! git cat-file -e "$deployed^{commit}" 2>/dev/null && return 0
    ! git diff --quiet "$deployed" "$after" -- "$@"
  }
  if changed backend deploy/compose.yaml; then services="$services api"; fi
  if changed proxy; then services="$services llm-proxy"; fi
  if changed frontend deploy/compose.yaml; then services="$services web"; fi

  if [[ " $services " == *" api "* ]] && [ ! -e "$FORCE" ] && ! git log -1 --format=%B "$after" | grep -qF '[deploy-now]' && busy; then
    if [ "$(cat "$HELD" 2>/dev/null)" != "$after" ]; then
      log "holding $after back: it restarts the api and a video is running. It deploys when none is, or after a deploy-now job"
      echo "$after" > "$HELD"
    fi
    return 0
  fi
  log "deploying $deployed -> $after"

  # Written to a temporary name and renamed: this script is one of the files, and bash reads a
  # script as it runs, so overwriting it in place hands the running copy the new bytes mid-line.
  # A rename replaces the directory entry and the running copy keeps its old inode.
  for f in compose.yaml run-ngrok.sh auto-deploy.sh; do
    if [ "$f" != compose.yaml ] && ! bash -n "deploy/$f" 2>/dev/null; then
      log "deploy/$f at $after does not parse; keeping the installed one"
      continue
    fi
    cp "deploy/$f" "$STACK/$f.new" || return 1
    [ "$f" = compose.yaml ] || chmod +x "$STACK/$f.new"
    mv -f "$STACK/$f.new" "$STACK/$f" || return 1
  done

  if [ -n "$services" ]; then
    # What is running now, kept under another name so it can be put back.
    if [[ " $services " == *" api "* ]]; then docker tag conf-tracker-api:local conf-tracker-api:prev >/dev/null 2>&1 || true; fi
    # shellcheck disable=SC2086
    if ! (cd "$STACK" && docker compose build $services) >> "$LOG" 2>&1; then
      give_up "$after" $((tries + 1))
      log "build failed at $after (try $((tries + 1)) of 3); what was running is untouched"
      return 1
    fi
    local started=1
    (cd "$STACK" && docker compose up -d) >> "$LOG" 2>&1 || started=0
    if [ "$started" = 0 ] || ! healthy; then
      log "the api did not come up healthy at $after; its last lines:"
      (cd "$STACK" && docker compose logs --no-color --tail 40 api) >> "$LOG" 2>&1 || true
      # Not tried again: a crash on start is the same crash three minutes later.
      give_up "$after" 3
      if [[ " $services " == *" api "* ]] && docker tag conf-tracker-api:prev conf-tracker-api:local >/dev/null 2>&1; then
        (cd "$STACK" && docker compose up -d --no-build) >> "$LOG" 2>&1 || true
        if healthy; then log "put the previous api image back; it is healthy. Push a fix to try again"; else log "put the previous api image back, and it is NOT healthy either"; fi
      else
        log "no previous api image to put back"
      fi
      return 1
    fi
    log "rebuilt and restarted:$services"
    docker image prune -f --filter label=com.docker.compose.project=conf-tracker >/dev/null 2>&1 || true
  fi

  echo "$after" > "$MARKER.new" && mv -f "$MARKER.new" "$MARKER" || return 1
  rm -f "$FAILED" "$HELD" "$FORCE"
}

cd "$CLONE"
synced=1
if ! git fetch -q origin main 2>/dev/null; then
  synced=0
elif [ -n "$(git status --porcelain)" ]; then
  log "clone is dirty, refusing to deploy"
  synced=0
else
  # The clone is deploy-only and the dirty check guards it, so it follows origin/main even
  # after a force-push (an --ff-only merge would fail there on every run, logging nothing).
  git reset -q --hard origin/main
fi

rc=0
box_ops jobs
if [ "$synced" = 1 ]; then
  deploy || rc=$?
  box_ops oneshots
else
  rc=1
fi
box_ops report
exit "$rc"
