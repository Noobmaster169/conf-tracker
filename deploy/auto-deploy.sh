#!/usr/bin/env bash
# Pull-based deploy. GitHub cannot reach the box, so cron runs this every three minutes:
# when origin/main differs from the last commit that deployed cleanly ($STACK/.deployed),
# it copies the stack files and rebuilds the api image when backend/ changed, the proxy
# image when proxy/ changed and the web image when frontend/ changed. The marker moves only
# after a successful build and start, so a failed deploy is retried on the next run.
# `rm ~/conf-tracker/.deployed` forces a full redeploy.
# Speech is yt-stream's service, not part of this stack; this script never touches it.
# It never writes ~/conf-tracker/.env and never touches Postgres data.
#
# Install: crontab -e -> */3 * * * * /home/student/conf-tracker/auto-deploy.sh
# Test: bash deploy/test-auto-deploy.sh
set -euo pipefail
CLONE="${CLONE:-$HOME/projects/conf-tracker}"
STACK="${STACK:-$HOME/conf-tracker}"
LOG="$STACK/deploy.log"
MARKER="$STACK/.deployed"

exec 9>"$STACK/.deploy.lock"
flock -n 9 || exit 0

cd "$CLONE"
git fetch -q origin main
after=$(git rev-parse origin/main)
deployed=$(cat "$MARKER" 2>/dev/null || echo none)
if [ "$deployed" = "$after" ]; then exit 0; fi
if [ -n "$(git status --porcelain)" ]; then
  echo "[$(date -Is)] clone is dirty, refusing to deploy" >> "$LOG"
  exit 1
fi
# The clone is deploy-only and the dirty check guards it, so it follows origin/main even
# after a force-push (an --ff-only merge would fail there on every run, logging nothing).
git reset -q --hard origin/main
echo "[$(date -Is)] deploying $deployed -> $after" >> "$LOG"

# Written to a temporary name and renamed: this script is one of the files, and bash reads a
# script as it runs, so overwriting it in place hands the running copy the new bytes mid-line.
# A rename replaces the directory entry and the running copy keeps its old inode.
for f in compose.yaml run-ngrok.sh auto-deploy.sh; do
  cp "deploy/$f" "$STACK/$f.new"
  [ "$f" = compose.yaml ] || chmod +x "$STACK/$f.new"
  mv -f "$STACK/$f.new" "$STACK/$f"
done

changed() {
  [ "$deployed" = none ] && return 0
  ! git cat-file -e "$deployed^{commit}" 2>/dev/null && return 0
  ! git diff --quiet "$deployed" "$after" -- "$@"
}
services=""
if changed backend deploy/compose.yaml; then services="$services api"; fi
if changed proxy; then services="$services llm-proxy"; fi
if changed frontend deploy/compose.yaml; then services="$services web"; fi
if [ -n "$services" ]; then
  # shellcheck disable=SC2086
  if ! (cd "$STACK" && docker compose build $services && docker compose up -d) >> "$LOG" 2>&1; then
    echo "[$(date -Is)] build failed at $after; will retry on the next run" >> "$LOG"
    exit 1
  fi
  echo "[$(date -Is)] rebuilt and restarted:$services" >> "$LOG"
fi

echo "$after" > "$MARKER.new"
mv -f "$MARKER.new" "$MARKER"
