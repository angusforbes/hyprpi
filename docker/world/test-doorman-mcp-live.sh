#!/usr/bin/env bash
# J462 live test of the doorman MCP in world G (manual; real relay, real Doorman-G, real pi with world G's model).
#   docker/world/test-doorman-mcp-live.sh [ask,message,research]
# Copies this checkout's doorman-mcp.mjs and the test driver into the sandbox (~/.hyprpi-g/j462-bin, so a job branch can be tested before it
# is merged), then runs the driver with world G's environment. "research" creates a held item for Angus in modes strict/safe/open.
set -euo pipefail
H="$(cd "$(dirname "$0")/../.." && pwd)"; SB=world-g; STEPS="${1:-ask,message}"
HOSTH="$(sbx exec "$SB" sh -c '. ~/.hyprpi-g/host.env 2>/dev/null; echo "$G_HOST_HYPRPI"')"
sbx exec "$SB" mkdir -p /home/agent/.hyprpi-g/j462-bin
sbx cp "$H/docker/world/doorman-mcp.mjs" "$SB:/home/agent/.hyprpi-g/j462-bin/doorman-mcp.mjs"
sbx cp "$H/docker/world/test-doorman-mcp-live.mjs" "$SB:/home/agent/.hyprpi-g/j462-bin/test-doorman-mcp-live.mjs"
sbx exec "$SB" sh -c ". ~/.hyprpi-g/host.env 2>/dev/null; . \"\$G_HOST_HYPRPI/docker/world/g-env.sh\"; timeout 900 node /home/agent/.hyprpi-g/j462-bin/test-doorman-mcp-live.mjs /home/agent/.hyprpi-g/j462-bin/doorman-mcp.mjs \"$HOSTH\" '$STEPS'"
