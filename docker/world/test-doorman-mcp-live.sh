#!/usr/bin/env bash
# J462/J464 live test of the doorman MCP in world G (manual; real relay, real Doorman-G, real pi with world G's model).
#   docker/world/test-doorman-mcp-live.sh [STEPS=ask,message[,research]] [STAY_MIN=0] [NAME=J462Test]
# Copies this checkout's doorman-mcp.mjs and the driver into the sandbox (~/.hyprpi-g/j462-bin, so a job branch can be tested before it is
# merged), then runs the driver with world G's environment. STAY_MIN > 0: the test agent stays joined in the background (log:
# ~/.hyprpi-g/j464-live.log in the sandbox) until its research is decided, answering a pushed host message by replying to the talk.
# "research" creates a held item for Angus in modes strict/safe/open.
set -euo pipefail
H="$(cd "$(dirname "$0")/../.." && pwd)"; SB=world-g; STEPS="${1:-ask,message}"; STAY="${2:-0}"; NAME="${3:-J462Test}"
[[ "$STEPS" =~ ^[a-z,]+$ && "$STAY" =~ ^[0-9]+$ && "$NAME" =~ ^[A-Za-z][A-Za-z0-9]{0,30}$ ]] || { echo "bad arguments" >&2; exit 2; }
HOSTH="$(sbx exec "$SB" sh -c '. ~/.hyprpi-g/host.env 2>/dev/null; echo "$G_HOST_HYPRPI"')"
B=/home/agent/.hyprpi-g/j462-bin
sbx exec "$SB" mkdir -p "$B"
sbx cp "$H/docker/world/doorman-mcp.mjs" "$SB:$B/doorman-mcp.mjs"
sbx cp "$H/docker/world/test-doorman-mcp-live.mjs" "$SB:$B/test-doorman-mcp-live.mjs"
T="$(mktemp)"; trap 'rm -f "$T"' EXIT
printf '%s\n' '. ~/.hyprpi-g/host.env 2>/dev/null' '. "$G_HOST_HYPRPI/docker/world/g-env.sh"' "exec node $B/test-doorman-mcp-live.mjs $B/doorman-mcp.mjs '$HOSTH' '$STEPS' $STAY $NAME" > "$T"
sbx cp "$T" "$SB:$B/run.sh"
if [ "$STAY" -gt 0 ]; then
  sbx exec "$SB" sh -c "setsid -f sh $B/run.sh >> \$HOME/.hyprpi-g/j464-live.out 2>&1 < /dev/null"
  echo "running in world G in the background as $NAME; log: ~/.hyprpi-g/j464-live.log (and j464-live.out)"
else
  sbx exec "$SB" timeout 900 sh "$B/run.sh"
fi
