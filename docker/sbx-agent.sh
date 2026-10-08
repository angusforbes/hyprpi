#!/usr/bin/env bash
# sbx-agent.sh: open a resident Pi agent that runs INSIDE a pi-sbx sandbox, in its own kitty window on a
# hyprpi workspace (J259, @pidocker). The sandbox can't reach hyprpi; the host relay (docker/sbx-relay.mjs)
# carries its messages through the drop-box in its workspace, and the in-sandbox extension
# (docker/sbx-dropbox-ext.ts) turns incoming messages into prompts and gives Pi the hyprpi_* tools.
#
# Usage: docker/sbx-agent.sh [SANDBOX]        (default: the first sandbox in ~/.config/hyprpi/sbx-relay.json)
# The sandbox must exist (sbx create … shell <workspace>) and have Pi + its key set up (see docker/README.md).
# Start the relay first: docker/sbx-relay.mjs start (this script checks).
#
# How hyprpi finds the window: kitty (class hyprpi.agent) runs `sbx exec` with HYPRPI_AGENT_ID=sbx-<name>
# in its environment; the daemon's windowViaHost finds that process under the window. The agent itself
# is registered by the relay (same id), so the agents panel shows it with its 🐳 pi-sbx marker.
set -euo pipefail
H="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/hyprpi/sbx-relay.json"
SB="${1:-$(jq -r '.sandboxes[0].name' "$CONF")}"
ENTRY="$(jq -c --arg n "$SB" '.sandboxes[] | select(.name == $n)' "$CONF")"
[[ -n "$ENTRY" ]] || { echo "sbx-agent: no sandbox '$SB' in $CONF" >&2; exit 2; }
WSDIR="$(jq -r '.workspace' <<<"$ENTRY" | sed "s#^~#$HOME#")"
WSNUM="$(jq -r '.workspace_num // empty' <<<"$ENTRY")"
ID="$(jq -r --arg n "$SB" '.agent_id // ("sbx-" + $n)' <<<"$ENTRY")"
INBOX="$(jq -r '.inbox // empty' <<<"$ENTRY" | sed "s#^~#$HOME#")"
BOX="$WSDIR/.hyprpi-dropbox"
[[ "$SB" =~ ^[A-Za-z0-9._-]+$ && "$ID" =~ ^sbx-[A-Za-z0-9._-]+$ ]] || { echo "sbx-agent: bad sandbox name or id" >&2; exit 2; }
[[ -z "$WSNUM" || "$WSNUM" =~ ^[0-9]{1,4}$ ]] || { echo "sbx-agent: workspace_num must be a number" >&2; exit 2; }
[[ -n "$INBOX" ]] || { echo "sbx-agent: set \"inbox\" for $SB in $CONF (a host folder, mounted read-only into the sandbox)" >&2; exit 2; }

systemctl --user is-active --quiet hyprpi-sbx-relay || { echo "sbx-agent: the relay isn't running; start it: $H/docker/sbx-relay.mjs start" >&2; exit 3; }
sbx exec "$SB" true >/dev/null 2>&1 || { echo "sbx-agent: sandbox '$SB' doesn't start (sbx ls)" >&2; exit 4; }

# The inbox: a host-only folder, mounted read-only into the sandbox (so nothing there can forge messages).
mkdir -p "$INBOX"; chmod 700 "$(dirname "$INBOX")" "$INBOX"
sbx mount "$SB" "$INBOX:$INBOX:ro" >/dev/null

# Refresh the in-sandbox extension from this checkout every launch (so fixes reach it).
sbx exec "$SB" sh -c 'mkdir -p ~/.pi/agent/extensions' >/dev/null
sbx cp "$H/docker/sbx-dropbox-ext.ts" "$SB:/home/agent/.pi/agent/extensions/hyprpi-dropbox.ts" >/dev/null

# The window: kitty with hyprpi's agent class and settings, on the sandbox's workspace, not focused.
KCONF=()
[[ -f "$HOME/.config/kitty/kitty.conf" ]] && KCONF+=(--config "$HOME/.config/kitty/kitty.conf")
KCONF+=(--config "$H/terminal-helpers/kitty/pi.conf")
# The command goes into a small generated script (each word quoted for bash), so the only thing handed to
# Hyprland's Lua exec_cmd is that script's path, checked to be plain characters (review J259 #5).
RUN="${XDG_STATE_HOME:-$HOME/.local/state}/hyprpi/sbx-agent-$SB.sh"
mkdir -p "$(dirname "$RUN")"
{
  echo "#!/usr/bin/env bash"
  printf 'exec env HYPRPI_AGENT_ID=%q kitty --class=hyprpi.agent' "$ID"
  printf ' %q' "${KCONF[@]}" "--directory=$WSDIR" -- sbx exec -it -w "$WSDIR" -e "HYPRPI_DROPBOX=$BOX" -e "HYPRPI_INBOX=$INBOX" "$SB" /home/agent/.local/bin/pi
  echo
} > "$RUN"
chmod 700 "$RUN"
[[ "$RUN" =~ ^[A-Za-z0-9/._-]+$ ]] || { echo "sbx-agent: unexpected characters in $RUN" >&2; exit 2; }
if [[ -n "$WSNUM" ]]; then
  hyprctl dispatch "hl.dsp.exec_cmd('$RUN', { workspace = '$WSNUM silent' })" >/dev/null
else
  setsid -f "$RUN" >/dev/null 2>&1
fi
echo "sbx-agent: opened $SB ($ID) on workspace ${WSNUM:-current}; stop it with /quit in its window or close the window"
