#!/usr/bin/env bash
# Keeps the tunnel up. The university firewall blocks inbound connections, so the api
# is published through an OUTBOUND ngrok tunnel to this account's static domain; the
# frontend's BACKEND_URL points at it. This is the fourth tunnel on the box next to
# yt-engine's, retina's and yt-stream's, on its own account, config file and inspection port.
#
# Uses the official standalone binary at ~/bin/ngrok, NOT the snap: since 2026-09-30 AppArmor
# denies the snap's DNS lookups on this box (journalctl -k: profile="snap.ngrok.ngrok"
# denied="send" to 127.0.0.53:53), so snap tunnels drop and never reconnect.
#
# Install: curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar xz -C ~/bin ngrok
#          ~/bin/ngrok config add-authtoken <token> --config ~/conf-tracker/ngrok.yml
#          (then add "web_addr: 127.0.0.1:4044" under agent: in that file)
#          crontab -e -> @reboot setsid nohup /home/student/conf-tracker/run-ngrok.sh >/dev/null 2>&1 </dev/null &
set -u
# This tunnel's own domain, always named. Since 2026-11-12 it runs on the paid account it shares with yt-engine,
# whose agent serves that account's dev domain: a tunnel started here without --domain would claim yt-engine's
# address, so the default must never be empty. yt-stream's default is deliberately not copied either.
NGROK_DOMAIN="${NGROK_DOMAIN:-fiber-data.ngrok.app}"
PORT="${PORT:-8094}"
CONFIG="${CONFIG:-$HOME/conf-tracker/ngrok.yml}"
LOG="${LOG:-$HOME/conf-tracker/ngrok.log}"

while true; do
  echo "[$(date -Is)] starting ngrok: ${NGROK_DOMAIN:-this account dev domain} -> 127.0.0.1:$PORT" >> "$LOG"
  "$HOME/bin/ngrok" http --config "$CONFIG" ${NGROK_DOMAIN:+--domain="$NGROK_DOMAIN"} "$PORT" --log=stdout >> "$LOG" 2>&1
  echo "[$(date -Is)] ngrok exited ($?); restarting in 5s" >> "$LOG"
  sleep 5
done
