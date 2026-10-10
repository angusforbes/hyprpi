#!/usr/bin/env bash
# doorman.sh: the Doorman (J308, layer 3 of docker/README's sandboxed-world design): a talk-only agent for ONE
# sandbox, in its own tiny Docker Sandboxes sandbox. It knows only that sandbox's host card, answers its agents'
# questions about the host, and drafts requests for Angus (held: a toast + the review in the Thoughts it reports to).
#
#   docker/doorman/doorman.sh create NAME     make the Doorman's sandbox and install Pi + its config in it
#   docker/doorman/doorman.sh start NAME      run it (systemd user unit hyprpi-doorman-NAME, headless Pi in RPC mode)
#   docker/doorman/doorman.sh stop NAME | status NAME | rm NAME
#   docker/doorman/doorman.sh window NAME     (J327) open its live window now (developer / observer visibility only)
#   docker/doorman/doorman.sh raise NAME      (J363) bring its window to Angus's workspace and focus it (a toast's Review for a held item)
#
# "visibility" in its relay entry (J327; distinct from OpenRoute's "doorman": {"mode": ...} research key):
#   strict     headless, nothing recorded outside the journal (the DEFAULT)
#   safe       headless, plus state/status.json (state, last question and answer) for a status row
#   observer   safe + a read-only live window (kitty on "visibility_workspace", default 68)
#   developer  observer's window, where Angus can also DECIDE what is held (1 / 2 / e, J363 / J365). Nothing else can be typed there: since J365
#              there is no input path from the window to the Doorman at all (its stdin is never fed by a window)
# Files for all but strict: ~/.local/state/hyprpi/doormen/NAME/{events.jsonl,status.json,input.fifo (developer)}.
#
# NAME is its entry in ~/.config/hyprpi/sbx-relay.json, e.g.
#   { "name": "doorman-g", "doorman_for": "world-g", "reports_to": "Thoughts-A", "display": "Doorman-G",
#     "workspace": "~/.local/state/hyprpi/doormen/doorman-g/box", "inbox": "~/.local/state/hyprpi/doormen/doorman-g/inbox",
#     "card": "~/.local/state/hyprpi/sandboxes/world-g/card", "workspace_num": 61,
#     "model": "nv-claude/azure/anthropic/claude-opus-5-5", "key_file": "~/path/to/inference-key" }
# The relay (docker/sbx-relay.mjs) carries its messages: only its own sandbox reaches it and it reaches only that
# sandbox; anything else is a drafted request. Those limits, the read-only card and the network are enforced outside
# the model: the sandbox's only shares are its card (ro), its inbox (ro) and an empty drop-box folder, and it runs
# under the "external-plus-inference" policy profile (the model API only).
set -euo pipefail
H="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
CONF="${HYPRPI_RELAY_CONF:-${XDG_CONFIG_HOME:-$HOME/.config}/hyprpi/sbx-relay.json}"
cmd="${1:-}"; NAME="${2:-}"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{1,39}$ ]] || { echo "usage: doorman.sh create|start|stop|status|rm|window|raise NAME" >&2; exit 2; }
ENTRY="$(jq -c --arg n "$NAME" '.sandboxes[] | select(.name == $n)' "$CONF")"
[[ -n "$ENTRY" ]] || { echo "doorman: no sandbox '$NAME' in $CONF" >&2; exit 2; }
get() { jq -r --arg k "$1" '.[$k] // empty' <<<"$ENTRY" | sed "s#^~#$HOME#"; }
FOR="$(get doorman_for)"; [[ -n "$FOR" ]] || { echo "doorman: '$NAME' has no doorman_for in $CONF" >&2; exit 2; }
BOX="$(get workspace)"; INBOX="$(get inbox)"; CARD="$(get card)"; MODEL="$(get model)"; KEYF="$(get key_file)"
VIS="$(get visibility)"; VIS="${VIS:-strict}"
case "$VIS" in strict|safe|observer|developer) ;; *) echo "doorman: visibility '$VIS' must be strict, safe, observer or developer" >&2; exit 2 ;; esac
WS="$(get visibility_workspace)"; WS="${WS:-68}"; [[ "$WS" =~ ^[0-9]{1,3}$ ]] || { echo "doorman: bad visibility_workspace" >&2; exit 2; }
VSTATE="${HYPRPI_DOORMEN_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/hyprpi/doormen}/$NAME"
VIEW="$H/docker/doorman/doorman-view.mjs"
MODEL="${MODEL:-nv-claude/azure/anthropic/claude-opus-5-5}"
UNIT="hyprpi-doorman-$NAME"
# Its only shares besides the empty drop-box: the card (ro) and its inbox (ro). Mounts don't survive a sandbox restart,
# so they're (re)made on create and on every start.
mounts() {
  sbx exec "$NAME" true >/dev/null
  sbx exec "$NAME" mountpoint -q /home/agent/.sandbox || sbx mount "$NAME" "$CARD:/home/agent/.sandbox:ro" >/dev/null
  sbx exec "$NAME" mountpoint -q "$INBOX" || sbx mount "$NAME" "$INBOX:$INBOX:ro" >/dev/null
}
case "$cmd" in
create)
  [[ -n "$BOX" && -n "$INBOX" && -n "$CARD" ]] || { echo "doorman: set workspace, inbox and card for $NAME" >&2; exit 2; }
  [[ -n "$KEYF" && -r "$KEYF" ]] || { echo "doorman: key_file for $NAME is missing or unreadable" >&2; exit 2; }
  mkdir -p "$BOX" "$INBOX" "$CARD"; chmod 700 "$(dirname "$BOX")" "$INBOX"
  [[ -z "$(ls -A "$BOX" | grep -vx .hyprpi-dropbox)" ]] || { echo "doorman: $BOX must be empty (it's only the drop-box)" >&2; exit 2; }
  sbx ls 2>/dev/null | awk '{print $1}' | grep -qx "$NAME" || sbx create --name "$NAME" --profile external-plus-inference shell "$BOX"
  mounts
  # Pi: copied from the served sandbox (the Doorman's network reaches the model API only, not npm).
  if ! sbx exec "$NAME" test -x /home/agent/.local/bin/pi; then
    T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
    sbx exec "$FOR" sh -c 'cd /home/agent/.local && tar czf - lib/node_modules/@earendil-works' > "$T/pi.tgz"
    sbx cp "$T/pi.tgz" "$NAME:/tmp/pi.tgz" >/dev/null
    sbx exec "$NAME" sh -c 'mkdir -p ~/.local/bin && cd ~/.local && tar xzf /tmp/pi.tgz && rm /tmp/pi.tgz && ln -sf ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js ~/.local/bin/pi'
  fi
  # Its model provider (OpenAI-compatible, NVIDIA Inference Hub) and key; the key stays inside, as for the served sandbox.
  P="${MODEL%%/*}"; M="${MODEL#*/}"
  T2="$(mktemp -d)"
  jq -n --arg p "$P" --arg m "$M" '{providers: {($p): {baseUrl: "https://inference-api.nvidia.com/v1", api: "openai-completions", models: [{id: $m, name: ($m + " (Inference Hub)"), reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 32000}]}}}' > "$T2/models.json"
  jq -n --arg p "$P" --rawfile k "$KEYF" '{($p): {type: "api_key", key: ($k | gsub("[\r\n]"; ""))}}' > "$T2/auth.json"
  jq -n --arg p "$P" --arg m "$M" '{defaultProvider: $p, defaultModel: $m, compaction: {enabled: true, reserveTokens: 16384}}' > "$T2/settings.json"
  sbx exec "$NAME" sh -c 'mkdir -p ~/.pi/agent/extensions && chmod 700 ~/.pi ~/.pi/agent'
  for f in models.json auth.json settings.json; do sbx cp "$T2/$f" "$NAME:/home/agent/.pi/agent/$f" >/dev/null; done
  rm -rf "$T2"
  sbx exec "$NAME" sh -c 'chmod 600 ~/.pi/agent/auth.json'
  sbx cp "$H/docker/sbx-dropbox-ext.ts" "$NAME:/home/agent/.pi/agent/extensions/hyprpi-dropbox.ts" >/dev/null
  sbx cp "$H/docker/doorman/doorman-prompt.md" "$NAME:/home/agent/doorman-prompt.md" >/dev/null
  echo "doorman $NAME created for $FOR (model $MODEL). Next: add it to the relay (restart it with nothing held), then: $0 start $NAME"
  ;;
start)
  systemctl --user is-active --quiet hyprpi-sbx-relay || { echo "doorman: the relay isn't running" >&2; exit 3; }
  systemctl --user is-active --quiet "$UNIT" && { echo "doorman: $UNIT already runs"; exit 0; }
  sbx exec "$NAME" pkill -x pi >/dev/null 2>&1 || true # a Pi left from an earlier run would answer too (its process is named "pi")
  mounts
  # Refresh the extension and prompt from this checkout (fixes reach it), then a headless Pi under doorman-rpc.mjs (J373: a fresh session per message).
  sbx cp "$H/docker/sbx-dropbox-ext.ts" "$NAME:/home/agent/.pi/agent/extensions/hyprpi-dropbox.ts" >/dev/null
  sbx cp "$H/docker/doorman/doorman-prompt.md" "$NAME:/home/agent/doorman-prompt.md" >/dev/null
  PIRUN="sbx exec -i -w /home/agent -e HYPRPI_DROPBOX=$BOX/.hyprpi-dropbox -e HYPRPI_INBOX=$INBOX -e HYPRPI_DOORMAN=1 $NAME sh -c 'exec /home/agent/.local/bin/pi --mode rpc --no-skills --no-context-files --no-prompt-templates --tools read,hyprpi_reply,hyprpi_talk,hyprpi_draft_request,hyprpi_gpu_lease,hyprpi_task_change,hyprpi_request --system-prompt \"\$(cat /home/agent/doorman-prompt.md)\"'"
  OUT=""
  if [[ "$VIS" != strict ]]; then
    mkdir -p "$VSTATE"; chmod 700 "$VSTATE"
    OUT=" | $(command -v node) $VIEW log $NAME"
    rm -f "$VSTATE/input.fifo" # J365: no input path from the window to the Doorman (a fifo left from before is removed)
  fi
  # J373 (stateless Doorman): doorman-rpc.mjs runs pi and starts a fresh session after every turn (it also keeps pi's stdin open, as the
  # idle tail did); the drop-box extension gives each session one message plus the relay's bounded context for that asker.
  RUN="set -o pipefail; DOORMAN_PIRUN=$(printf %q "$PIRUN") $(command -v node) $(printf %q "$H/docker/doorman/doorman-rpc.mjs")$OUT" # when pi, sbx or the logger ends, the unit ends (and restarts)
  systemd-run --user --unit="$UNIT" --collect --property=Restart=on-failure --property=RestartSec=10 --property=MemoryMax=512M bash -c "$RUN"
  echo "started $UNIT (visibility $VIS)"
  [[ "$VIS" == developer || "$VIS" == observer ]] && [[ -z "${DOORMAN_NO_WINDOW:-}" ]] && "$0" window "$NAME" || true
  ;;
window)
  [[ "$VIS" == developer || "$VIS" == observer ]] || { echo "doorman: $NAME's visibility is $VIS: no window"; exit 0; }
  CLS="hyprpi-doorman-$NAME"
  # focus guard: if Angus is looking at that workspace right now a new window could take his focus, so don't (J327 review)
  [[ -z "${DOORMAN_FORCE_WINDOW:-}" && "$(hyprctl -j activeworkspace | jq -r .id)" == "$WS" ]] && { echo "doorman: you are on workspace $WS; not opening a window under your hands (DOORMAN_FORCE_WINDOW=1 to override)"; exit 0; }
  hyprctl -j clients | jq -e --arg c "$CLS" '.[] | select(.class == $c)' >/dev/null && { echo "doorman: window already open"; exit 0; }
  ARG=""; MODETXT="ARCHIVE (read-only)"; [[ "$VIS" == developer ]] && { ARG=" --write"; MODETXT="ARCHIVE + DECISIONS"; }
  LABEL="$(get display)"; LABEL="${LABEL:-$NAME}"
  # on its workspace, silently: Angus's focus never moves
  hyprctl dispatch "hl.dsp.exec_cmd(\"env DOORMAN_LABEL='$LABEL' kitty --class $CLS --title '$LABEL · $MODETXT' $(command -v node) $VIEW view $NAME$ARG\", { workspace = \"$WS silent\" })" >/dev/null
  echo "opened $CLS on workspace $WS"
  ;;
raise)
  # J363: a toast's Review for a held item of this Doorman's sandbox: bring its window to where Angus is (his workspace stays; the
  # window comes to him) and focus it so he can type his choice. The window is opened first if it isn't there.
  [[ "$VIS" == developer || "$VIS" == observer ]] || { echo "doorman: $NAME's visibility is $VIS: no window"; exit 0; }
  CLS="hyprpi-doorman-$NAME"
  addr="$(hyprctl -j clients | jq -r --arg c "$CLS" '[.[] | select(.class == $c)][0].address // empty')"
  if [[ -z "$addr" ]]; then
    DOORMAN_FORCE_WINDOW=1 "$0" window "$NAME" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do addr="$(hyprctl -j clients | jq -r --arg c "$CLS" '[.[] | select(.class == $c)][0].address // empty')"; [[ -n "$addr" ]] && break; sleep 0.3; done
  fi
  [[ -n "$addr" ]] || { echo "doorman: no window for $NAME"; exit 1; }
  here="$(hyprctl -j activeworkspace | jq -r .id)"
  hyprctl dispatch "hl.dsp.window.move({ window = \"address:$addr\", workspace = \"$here\", follow = false })" >/dev/null
  hyprctl dispatch "hl.dsp.focus({ window = \"address:$addr\" })" >/dev/null
  echo "raised $CLS to workspace $here"
  ;;
stop) systemctl --user stop "$UNIT"; sbx exec "$NAME" pkill -x pi >/dev/null 2>&1 || true ;;
status) systemctl --user --no-pager status "$UNIT" || true ;;
rm) systemctl --user stop "$UNIT" 2>/dev/null || true; sbx rm -f "$NAME" ;;
*) echo "usage: doorman.sh create|start|stop|status|rm|window|raise NAME" >&2; exit 2 ;;
esac
