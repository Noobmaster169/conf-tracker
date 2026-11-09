#!/usr/bin/env bash
# Pull-based deploy. GitHub cannot reach the box, so cron runs this every three minutes:
# it fetches origin/main and, only when the commit changed, copies the stack files,
# rebuilds the api image when backend/ changed, the proxy image when proxy/ changed and the
# web image when frontend/ changed,
# and restarts speech when speech/ changed.
# It never writes ~/yt-stream/.env and never touches Postgres data.
#
# Install: crontab -e -> */3 * * * * /home/student/yt-stream/auto-deploy.sh
set -euo pipefail
CLONE="${CLONE:-$HOME/projects/yt-stream}"
STACK="${STACK:-$HOME/yt-stream}"
LOG="$STACK/deploy.log"

exec 9>"$STACK/.deploy.lock"
flock -n 9 || exit 0

cd "$CLONE"
git fetch -q origin main
before=$(git rev-parse HEAD)
after=$(git rev-parse origin/main)
if [ "$before" = "$after" ]; then exit 0; fi
if [ -n "$(git status --porcelain)" ]; then
  echo "[$(date -Is)] clone is dirty, refusing to deploy" >> "$LOG"
  exit 1
fi
git merge -q --ff-only origin/main
echo "[$(date -Is)] deploying $before -> $after" >> "$LOG"

# Written to a temporary name and renamed: this script is one of the files, and bash reads a
# script as it runs, so overwriting it in place hands the running copy the new bytes mid-line.
# A rename replaces the directory entry and the running copy keeps its old inode.
for f in compose.yaml run-ngrok.sh run-speech.sh auto-deploy.sh; do
  cp "deploy/$f" "$STACK/$f.new"
  [ "$f" = compose.yaml ] || chmod +x "$STACK/$f.new"
  mv -f "$STACK/$f.new" "$STACK/$f"
done

services=""
if ! git diff --quiet "$before" "$after" -- backend deploy/compose.yaml; then services="$services api"; fi
if ! git diff --quiet "$before" "$after" -- proxy; then services="$services llm-proxy"; fi
if ! git diff --quiet "$before" "$after" -- frontend deploy/compose.yaml; then services="$services web"; fi
if [ -n "$services" ]; then
  # shellcheck disable=SC2086
  (cd "$STACK" && docker compose build $services && docker compose up -d) >> "$LOG" 2>&1
  echo "[$(date -Is)] rebuilt and restarted:$services" >> "$LOG"
fi

if ! git diff --quiet "$before" "$after" -- speech; then
  (cd speech && source "$HOME/miniforge3/bin/activate" diarize && pip install -e . -q) >> "$LOG" 2>&1
  # run-speech.sh restarts it on the new code. The [p] keeps the pattern from matching this shell.
  pkill -f "[p]ython -m speech.server" || true
  echo "[$(date -Is)] speech restarted" >> "$LOG"
fi
