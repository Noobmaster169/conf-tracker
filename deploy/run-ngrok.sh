#!/usr/bin/env bash
# Keeps the tunnel up. The university firewall blocks inbound connections, so the api
# is published through an OUTBOUND ngrok tunnel to this account's static domain; the
# frontend's BACKEND_URL points at it. This is the third tunnel on the box next to
# yt-engine's and retina's, on its own account, config file and inspection port.
#
# Uses the official standalone binary at ~/bin/ngrok, NOT the snap: since 2026-09-30 AppArmor
# denies the snap's DNS lookups on this box (journalctl -k: profile="snap.ngrok.ngrok"
# denied="send" to 127.0.0.53:53), so snap tunnels drop and never reconnect.
#
# Install: curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar xz -C ~/bin ngrok
#          ~/bin/ngrok config add-authtoken <token> --config ~/yt-stream/ngrok.yml
#          (then add "web_addr: 127.0.0.1:4042" under agent: in that file)
#          crontab -e -> @reboot setsid nohup /home/student/yt-stream/run-ngrok.sh >/dev/null 2>&1 </dev/null &
set -u
NGROK_DOMAIN="${NGROK_DOMAIN:-antiques-hazelnut-footman.ngrok-free.dev}"
PORT="${PORT:-8092}"
CONFIG="${CONFIG:-$HOME/yt-stream/ngrok.yml}"
LOG="${LOG:-$HOME/yt-stream/ngrok.log}"

while true; do
  echo "[$(date -Is)] starting ngrok: $NGROK_DOMAIN -> 127.0.0.1:$PORT" >> "$LOG"
  "$HOME/bin/ngrok" http --config "$CONFIG" --domain="$NGROK_DOMAIN" "$PORT" --log=stdout >> "$LOG" 2>&1
  echo "[$(date -Is)] ngrok exited ($?); restarting in 5s" >> "$LOG"
  sleep 5
done
