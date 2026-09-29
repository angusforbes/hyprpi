#!/usr/bin/env bash
# Run a Pi agent inside the pi-sandbox container, wired to the host hyprpi daemon (docs: docker/README.md).
# Run it from the folder the agent may work in: that folder (and only it) is mounted read-write.
# Usage: run-hyprpi-agent.sh [pi args...]   (env: AGENT_ID, WS; PIDMODE=host is no longer needed)
# TOOLS=web,nim (comma list, default none): also load web search/fetch (pi-web-access) and the
#   NVIDIA NIM tools; mounts their code read-only and passes their config/key IN (the container can read them).
# BROWSER=1: use the pi-browser image (headless Chromium + Playwright; build it: see docker/README.md)
#   with --shm-size=1g (Chromium needs shared memory) and --init (reaps browser processes).
# HYPRPI_AGENT_ID is exported to the docker client too: the hyprpi daemon finds the window through it.
set -euo pipefail
TOOLS="${TOOLS:-}"
S="$XDG_RUNTIME_DIR/hyprpi"; H="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"; W="$PWD"   # H = this hyprpi checkout
export HYPRPI_AGENT_ID="${AGENT_ID:-hp-dockertest}"
TOKEN=$(node -e 'process.stdout.write(require(process.env.HOME+"/.pi/agent/auth.json").anthropic.access)')
EXTRA=()
IMAGE=pi-sandbox
if [[ "${BROWSER:-}" == 1 ]]; then IMAGE=pi-browser; EXTRA+=(--shm-size=1g --init); fi
NPM="$HOME/.pi/agent/npm/node_modules"
for t in ${TOOLS//,/ }; do
  case "$t" in
    web) EXTRA+=(-v "$NPM:$NPM:ro" -v "$HOME/.config/pi/web-search.json:/tmp/xdg/pi/web-search.json:ro" -e XDG_CONFIG_HOME=/tmp/xdg) ;;
    nim) EXTRA+=(-v "$HOME/.pi/agent/extensions/nvidia-nim:$HOME/.pi/agent/extensions/nvidia-nim:ro" -e NVIDIA_API_KEY) ;;
    *) echo "unknown tool set: $t (known: web, nim)" >&2; exit 2 ;;
  esac
done
export HYPRPI_CONTAINER="docker:$IMAGE${TOOLS:+ +$TOOLS}"   # agents panel: 🐳 docker
EXTS=(-e "$H/pi-extension/index.ts")
[[ ",$TOOLS," == *,web,* ]] && EXTS+=(-e "$NPM/pi-web-access")
[[ ",$TOOLS," == *,nim,* ]] && EXTS+=(-e "$HOME/.pi/agent/extensions/nvidia-nim/index.ts")
exec docker run --rm $( [ -t 0 ] && echo -it || echo -i ) --name "pi-${AGENT_ID:-dockertest}" \
  ${PIDMODE:+--pid=$PIDMODE} \
  --user "$(id -u):$(id -g)" -e HOME=/tmp/home \
  -e ANTHROPIC_OAUTH_TOKEN="$TOKEN" \
  -e XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" -e HYPRLAND_INSTANCE_SIGNATURE="$HYPRLAND_INSTANCE_SIGNATURE" \
  -e HYPRPI_AGENT_ID -e HYPRPI_CONTAINER -e HYPRPI_NO_ENSURE=1 -e HYPRPI_WORKSPACE="${WS:-11}" \
  -e TERM="${TERM:-xterm-256color}" \
  -v "$S:$S" -v "$H:$H:ro" -v "$W:$W" -w "$W" \
  "${EXTRA[@]}" \
  "$IMAGE" "${EXTS[@]}" "$@"
