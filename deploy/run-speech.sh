#!/usr/bin/env bash
# Keeps the speech service up on the host. It is not a container because it needs the
# GPU and the diarize conda env. It binds to the docker bridge address, so the api
# container reaches it as host.docker.internal and nothing off the box can; from a dev
# machine, tunnel it with: ../vps/monash.sh -N -L 8100:172.17.0.1:8100
#
# Install: crontab -e -> @reboot setsid nohup /home/student/yt-stream/run-speech.sh >/dev/null 2>&1 </dev/null &
set -u
CLONE="${CLONE:-$HOME/projects/yt-stream}"
LOG="${LOG:-$HOME/yt-stream/speech.log}"
export SPEECH_HOST="${SPEECH_HOST:-172.17.0.1}"
export SPEECH_PORT="${SPEECH_PORT:-8100}"
export SPEECH_DATA="${SPEECH_DATA:-$HOME/yt-stream/data}"
export SPEECH_MODEL="${SPEECH_MODEL:-large-v3}"
export SPEECH_DIAR_MODEL="${SPEECH_DIAR_MODEL:-pyannote/speaker-diarization-community-1}"
# The pyannote model is gated; it is in this user's Hugging Face cache, so load it offline and need no token.
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
mkdir -p "$SPEECH_DATA"

while true; do
  echo "[$(date -Is)] starting speech on $SPEECH_HOST:$SPEECH_PORT from $CLONE" >> "$LOG"
  (cd "$CLONE/speech" && source "$HOME/miniforge3/bin/activate" diarize && exec python -m speech.server) >> "$LOG" 2>&1
  echo "[$(date -Is)] speech exited ($?); restarting in 5s" >> "$LOG"
  sleep 5
done
