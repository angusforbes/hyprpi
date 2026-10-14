#!/usr/bin/env bash
# remote.sh: hyprpi headless on a remote Linux machine (J469, world H: "agents running on a remote server, seen here").
# Runs ON the remote machine. The laptop sends it over ssh (omnistation/world-h), so nothing has to be installed there first:
#   ssh HOST "mkdir -p ~/.hyprpi-x && cat > ~/.hyprpi-x/remote.sh" < omnistation/remote.sh; ssh HOST bash ~/.hyprpi-x/remote.sh install
# One folder per laptop world bound to this machine: ~/.hyprpi-<letter> (its daemon, agents, sessions); the folder this script
# sits in names the world, so two worlds can share a machine. HYPRPI_REMOTE_WS (sent by the laptop) is that world's first
# workspace; it is remembered in <folder>/ws.
#
#   remote.sh install            clone (or update) hyprpi into ~/hyprpi from its public repo; check node 22+ and pi (install pi
#                                into ~/.local with npm if it's missing, the version hyprpi is tested with)
#   remote.sh start [NAME]       start the headless daemon and one agent NAME (default alpha) in tmux; both outlive ssh. Its room is
#                                its world's (HYPRPI_REMOTE_WS): the laptop shows it on that world's workspaces
#                                The agent's pi runs in RPC mode behind omnistation/hbroker.mjs (J471): a laptop window draws pi's
#                                interface locally and sends only finished messages. HYPRPI_REMOTE_MIRROR=1 starts it the old way
#                                (pi's own terminal UI in tmux, for `attach`)
#   remote.sh connect NAME [nostart]  pipe this ssh's stdin/stdout to agent NAME's RPC socket (what a laptop window runs)
#   remote.sh attach [NAME]      attach this terminal to a mirror-mode agent's tmux (the old window); detach = close the window
#   remote.sh status             daemon and agents, as hyprpi sees them
#   remote.sh stop [NAME|all]    stop an agent (its session file stays, so `start NAME` resumes it), or everything
#
# Headless: no Hyprland, no panels, no windows. The daemon and each agent run in their own tmux session (hyprpi-<letter>-*), so an ssh
# disconnect (or the laptop sleeping) leaves them running; `attach` reconnects to the same pi and session. State lives in
# ~/.hyprpi-<letter> (daemon socket, registry), separate from any desktop hyprpi on that machine. Nothing here names a particular site.
set -euo pipefail
REPO_URL="${HYPRPI_REPO_URL:-https://github.com/angusforbes/hyprpi.git}"
DIR="${HYPRPI_DIR:-$HOME/hyprpi}"
ROOT="$(cd "$(dirname "$0")" && pwd)"  # J476: the logical path (no readlink -f): ~/.hyprpi-<x> may be a link into Brev's ~/workspace
W="${ROOT##*/.hyprpi-}"
[[ "$ROOT" == "$HOME/.hyprpi-$W" && "$W" =~ ^[a-i]$ ]] || { echo "remote.sh: run me as ~/.hyprpi-<world letter>/remote.sh (I'm in $ROOT)" >&2; exit 2; }
[[ -n "${HYPRPI_REMOTE_WS:-}" ]] || HYPRPI_REMOTE_WS=$(cat "$ROOT/ws" 2>/dev/null || true)
WORK="${HYPRPI_REMOTE_WORK:-$HOME/work}"
export HYPRPI_STATE="$ROOT/state" HYPRPI_SOCKET="$ROOT/run/daemon.sock" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$ROOT/run}" HYPRPI_NO_ADOPT=1
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
# J532 (Angus: "the hyprpi's should be kept on the same versions when possible"): the machine's own tooling may update a global pi
# under running agents (Omnistation's platform installs the latest pi into ~/.npm-global), so hyprpi runs ITS OWN pi, the version
# hyprpi pins (docker/PI_VERSION), from ~/.hyprpi-<x>/pi (install puts it there); it comes first on the PATH of everything here
[[ -x "$ROOT/pi/bin/pi" ]] && export PATH="$ROOT/pi/bin:$PATH"
# J543: bonk / ding for the agents here (install writes them): no sound or desktop on this machine, hyprpi carries them to the laptop
[[ -x "$ROOT/bin/bonk" ]] && export PATH="$ROOT/bin:$PATH"
# J532: the laptop's theme colours (world X's panels draw in world X's colour, as on the laptop); world X copies them here
[[ -f "$ROOT/theme/colors.toml" ]] && export HYPRPI_THEME_COLORS="$ROOT/theme/colors.toml"
unset HYPRLAND_INSTANCE_SIGNATURE WAYLAND_DISPLAY DISPLAY  # headless: never a desktop, even if one is around
# the laptop's terminal type may be unknown here (kitty's xterm-kitty): tmux needs one it knows
infocmp "${TERM:-dumb}" >/dev/null 2>&1 || export TERM=xterm-256color
# a machine whose outbound TLS is inspected by its own CA: node (pi, hyprpi) must trust the system bundle, as curl does
[[ -z "${NODE_EXTRA_CA_CERTS:-}" && -r /etc/ssl/certs/ca-certificates.crt ]] && export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
cmd="${1:-status}"; NAME="${2:-alpha}"
[[ "${HYPRPI_REMOTE_WS:-}" =~ ^[0-9]{1,3}$ ]] || { echo "remote.sh: HYPRPI_REMOTE_WS (the world's first workspace) isn't set" >&2; exit 2; }
[[ "$(cat "$ROOT/ws" 2>/dev/null)" == "$HYPRPI_REMOTE_WS" ]] || echo "$HYPRPI_REMOTE_WS" > "$ROOT/ws"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{0,30}$ || "$NAME" == all ]] || { echo "remote.sh: a name is lowercase letters, digits and -" >&2; exit 2; }
mkdir -p "$ROOT/state" "$ROOT/run" "$WORK"; chmod 700 "$ROOT" "$ROOT/run"
hp() { node "$DIR/bin/hyprpi" "$@"; }
# J476: prints the first folder on the way to $1 (links followed component by component) that isn't owned by you or root or is
# writable by group/others, and fails; succeeds silently when every folder on the way is safe
path_unsafe() {
  local me cur=/ rest="$1" comp next t hops=0; me=$(id -un)
  _pu_ok() { [[ $(( 8#$(stat -c %a "$1") & 022 )) -eq 0 && "$(stat -c %U "$1")" =~ ^($me|root)$ ]]; }
  _pu_ok / || { echo /; return 1; }
  while [[ -n "$rest" ]]; do
    comp="${rest%%/*}"; [[ "$rest" == */* ]] && rest="${rest#*/}" || rest=""
    case "$comp" in ""|.) continue ;; ..) cur=$(dirname "$cur"); continue ;; esac
    next="${cur%/}/$comp"
    if [[ -L "$next" ]]; then
      (( ++hops <= 40 )) || { echo "$next"; return 1; }
      t=$(readlink "$next"); [[ "$t" == /* ]] && cur=/; rest="$t${rest:+/$rest}"; continue
    fi
    [[ -d "$next" ]] || { echo "$next"; return 1; }
    cur="$next"; _pu_ok "$cur" || { echo "$cur"; return 1; }
  done
}
# Secrets must be private (Ledger, J469/J471): files 600 or tighter, their folders 700, else nothing starts
secrets_ok() {
  local bad=() f d r
  for f in "$HOME/.config/hyprpi-secrets"/* "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/models.json" "$HOME/.ai-pim-utils/tokens.toml"; do
    [[ -e "$f" ]] || continue
    [[ $(( 8#$(stat -c %a "$f") & 077 )) -eq 0 ]] || bad+=("chmod 600 $(printf %q "$f")")
  done
  for d in "$HOME/.config/hyprpi-secrets" "$HOME/.ai-pim-utils" "$HOME/.pi/agent"; do
    [[ -d "$d" ]] || continue
    [[ $(( 8#$(stat -c %a "$d") & 077 )) -eq 0 ]] || bad+=("chmod 700 $(printf %q "$d")")
  done
  # (review) their parent folders mustn't be writable by others either (someone could swap a file). J476: ~/.pi and
  # ~/.hyprpi-<x> may be links into Brev's ~/workspace, so the path is walked one component at a time, following every link
  # by hand: every folder entered (including those that only hold an intermediate link) must be owned by you or root and not
  # writable by group or others. A link's own mode means nothing; the folders it passes through do.
  for d in "$HOME" "$HOME/.config" "$HOME/.pi" "$ROOT"; do
    [[ -d "$d" ]] || continue
    r=$(path_unsafe "$d") || bad+=("chmod go-w $(printf %q "$r")  # and owned by you (on the way to $(printf %q "$d"))")
  done
  (( ${#bad[@]} == 0 )) && return 0
  echo "remote.sh: refusing to start: a secret is readable by others. Fix with:" >&2; printf '  %s\n' "${bad[@]}" >&2; return 1
}
need() { command -v "$1" >/dev/null || { echo "remote.sh: $1 isn't installed here ($2)" >&2; exit 3; }; }
case "$cmd" in
  install)
    need git "needed to fetch hyprpi"; need node "hyprpi needs node 22+"; need tmux "keeps the agents running when ssh drops"
    major=$(node -p 'process.versions.node.split(".")[0]'); (( major >= 22 )) || { echo "remote.sh: node $major is too old (22+)" >&2; exit 3; }
    if [[ -d "$DIR/.git" ]]; then git -C "$DIR" pull -q --ff-only
    elif [[ -f "$DIR/bin/hyprpi" ]]; then :  # copied from the laptop (world-h setup), e.g. where the git host isn't reachable
    else git clone -q "$REPO_URL" "$DIR"; fi
    want=$(cat "$DIR/docker/PI_VERSION" 2>/dev/null || echo latest)
    # J532: hyprpi's own pinned pi in ~/.hyprpi-<x>/pi (never the machine's global one, which its own tooling may update)
    have=$(node -p 'try { require(process.argv[1]).version } catch { "" }' "$ROOT/pi/lib/node_modules/@earendil-works/pi-coding-agent/package.json" 2>/dev/null || true)
    if [[ "$have" != "$want" ]]; then need npm "to install pi"; npm install -g --prefix "$ROOT/pi" "@earendil-works/pi-coding-agent@$want" >/dev/null; export PATH="$ROOT/pi/bin:$PATH"; fi
    # headless: agents run in tmux, never in a desktop terminal; hyprpi only needs a terminalCommand set to accept that
    c="${XDG_CONFIG_HOME:-$HOME/.config}/hyprpi/config.json"; mkdir -p "$(dirname "$c")"
    [[ -f "$c" ]] || printf '{\n  "//terminalCommand": "headless (omnistation/remote.sh): agents run in tmux; no desktop terminal is ever opened",\n  "terminalCommand": ["tmux"]\n}\n' > "$c"
    # J543: only the agent's own pi (remote.sh start exports HYPRPI_RPC_NAME, its slug, into its tmux command; agents started before
    # that go by HYPRPI_NAME; a one-shot `pi -p`, `--mode` or `--no-session` call is never one), so nothing else with an agent's env (a daemon an agent's ensure started) can take its socket
    # J559 / J561: every pi here (agents, Thoughts, windowless ones) runs pi-jot in relay mode (PI_JOT_RELAY=1): its /jot-* notes are
    # written on the laptop, never on this machine: through the laptop's relay socket ($ROOT/jot.sock, forwarded by its
    # hyprpi-jot-relay service), else through the agent's laptop window (pi-jot src/io.ts, hyprpi lib/jot-relay-host.mjs)
    # J471: hyprpi starts agents through pi-entry, which runs pi in RPC mode behind hbroker for an agent started by `start`
    # (HYPRPI_REMOTE_RPC=1) and is plain pi for everything else (the daemon's own pi calls)
    [[ -f "$ROOT/hbroker.mjs" ]] || { echo "remote.sh: $ROOT/hbroker.mjs is missing (world-h setup copies it)" >&2; exit 3; }
    printf '#!/usr/bin/env bash\n# hyprpi'"'"'s pi command on this machine (omnistation/remote.sh, J471)\nexport PI_JOT_RELAY=1 PI_JOT_RELAY_SOCKET=%q PI_JOT_RELAY_LINK=%q\nn="${HYPRPI_RPC_NAME:-${HYPRPI_NAME:-}}"\nif [[ "${HYPRPI_REMOTE_RPC:-}" == 1 && "$n" =~ ^[a-z][a-z0-9-]{0,30}$ && " $* " != *" -p "* && " $* " != *" --print "* && " $* " != *" --mode "* && " $* " != *" --no-session "* ]]; then exec node %q serve "$n" -- "$@"; fi\nexec pi "$@"\n' "$ROOT/jot.sock" "$ROOT/run/daemon.sock" "$ROOT/hbroker.mjs" > "$ROOT/pi-entry"; chmod 755 "$ROOT/pi-entry"
    node -e 'const fs=require("fs"),[c,e]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(c,"utf8"));j.pi=e;fs.writeFileSync(c,JSON.stringify(j,null,2)+"\n")' "$c" "$ROOT/pi-entry"
    # J543 (parity): `bonk` / `ding` (the skill every agent knows) for the agents here: they mark the agent blocked through hyprpi,
    # quietly, with the message; the daemon keeps it as a notice and the laptop plays the sound and shows the toast (world-status.mjs)
    mkdir -p "$ROOT/bin"
    # J553: the binding's name prefix ("omni-"), for agents the remote agents panel starts (/new DIR)
    [[ "${HYPRPI_REMOTE_PREFIX:-}" =~ ^[a-z][a-z0-9-]{0,11}$ ]] && echo "$HYPRPI_REMOTE_PREFIX" > "$ROOT/prefix"
    printf '#!/usr/bin/env bash\n# bonk on this machine (omnistation/remote.sh, J543): the laptop plays it (sound + toast; a click opens the agent)\nd=; [[ ${1:-} == --ding || ${1:-} == --decide ]] && { d=1; shift; }\n[[ -n ${HYPRPI_AGENT_ID:-} ]] || { echo "bonk: only a hyprpi agent can bonk from here" >&2; exit 0; }\nif [[ -n $d && -n ${*:-} ]]; then exec timeout 5 node %q status blocked --quiet --decision "$*"; elif [[ -n ${*:-} ]]; then exec timeout 5 node %q status blocked --quiet --note "$*"; else exec timeout 5 node %q status blocked --quiet; fi\n' "$DIR/bin/hyprpi" "$DIR/bin/hyprpi" "$DIR/bin/hyprpi" > "$ROOT/bin/bonk"
    printf '#!/usr/bin/env bash\nexec "$(dirname "$0")/bonk" --ding "$@"\n' > "$ROOT/bin/ding"; chmod 755 "$ROOT/bin/bonk" "$ROOT/bin/ding"
    # J480: the world's Thoughts model (the binding's "thoughtsModel", e.g. a model served on this machine) and the human's
    # name for the panels (the laptop's; else the panels here would say the remote login's name, e.g. "Ubuntu")
    if [[ "${HYPRPI_REMOTE_THOUGHTS_MODEL:-}" =~ ^[A-Za-z0-9._/:-]+$ ]]; then node -e 'const fs=require("fs"),[c,m]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(c,"utf8"));j.thoughtsModel=m;fs.writeFileSync(c,JSON.stringify(j,null,2)+"\n")' "$c" "$HYPRPI_REMOTE_THOUGHTS_MODEL"; fi
    p="$(dirname "$c")/hyprpi.jsonc"
    if [[ "${HYPRPI_REMOTE_USER_NAME:-}" =~ ^[A-Za-z][A-Za-z\ .\'-]{0,40}$ ]]; then
      if [[ ! -e "$p" ]]; then node -e 'const fs=require("fs"),[p,n]=process.argv.slice(1);fs.writeFileSync(p,JSON.stringify({user:{name:n}},null,2)+"\n")' "$p" "$HYPRPI_REMOTE_USER_NAME"
      else node -e 'const fs=require("fs"),[p,n]=process.argv.slice(1);const s=fs.readFileSync(p,"utf8");const t=s.replace(/"user"\s*:\s*\{\s*"name"\s*:\s*""\s*\}/,JSON.stringify({user:{name:n}}).slice(1,-1));if(t!==s)fs.writeFileSync(p,t)' "$p" "$HYPRPI_REMOTE_USER_NAME"; fi  # the default file the daemon wrote: only an EMPTY name is filled in
    fi
    # J528: the laptop's phone push settings (hyprpi.jsonc "phone.ntfy": topic, server, kinds …), so this world pushes its bonks and
    # decisions to the same topic (a hub box pushes even while the laptop sleeps). Replaces this machine's "phone" entry.
    if [[ -n "${HYPRPI_REMOTE_NTFY:-}" ]]; then
      node -e '
        const fs = require("fs"), [p, raw] = process.argv.slice(1); let n; try { n = JSON.parse(raw); } catch { process.exit(0); }
        if (!n || typeof n !== "object" || typeof n.topic !== "string") process.exit(0);
        const keep = { enabled: !!n.enabled, server: String(n.server || "https://ntfy.sh"), topic: n.topic, kinds: Array.isArray(n.kinds) ? n.kinds.map(String) : ["bonk", "decision"], maxPerHour: Number.isFinite(Number(n.maxPerHour)) && n.maxPerHour !== null && n.maxPerHour !== "" ? Math.max(0, Number(n.maxPerHour)) : 12, click: String(n.click || "") };
        const line = `"phone": ${JSON.stringify({ ntfy: keep })}`;
        let s = ""; try { s = fs.readFileSync(p, "utf8"); } catch { fs.writeFileSync(p, JSON.stringify({ phone: { ntfy: keep } }, null, 2) + "\n"); process.exit(0); }
        try { const j = JSON.parse(s); j.phone = { ...(j.phone || {}), ntfy: keep }; fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); process.exit(0); } catch { /* jsonc with comments */ }
        // A small scanner (strings with escapes, // and /* */ comments skipped): the top-level "phone" entry, key to the end of
        // its value, is replaced whole (whatever it holds); none: it becomes the first entry (no comma after a // comment).
        let i = 0, depth = 0, first = -1, keyAt = -1, end = -1;
        const skipStr = (j) => { j++; while (j < s.length && s[j] !== "\"") j += s[j] === "\\" ? 2 : 1; return j + 1; };
        const skipCom = (j) => s[j + 1] === "/" ? (s.indexOf("\n", j) < 0 ? s.length : s.indexOf("\n", j)) : (s.indexOf("*/", j + 2) < 0 ? s.length : s.indexOf("*/", j + 2) + 2);
        const skipWs = (j) => { for (;;) { while (j < s.length && /\s/.test(s[j])) j++; if (s[j] === "/" && (s[j + 1] === "/" || s[j + 1] === "*")) { j = skipCom(j); continue; } return j; } };
        // the end of the value that starts at v (an object/array to its match, a string, or a scalar up to , or })
        const valueEnd = (v) => {
          if (s[v] === "\"") return skipStr(v);
          if (s[v] !== "{" && s[v] !== "[") { let j = v; while (j < s.length && !/[,}\]\s]/.test(s[j]) && !(s[j] === "/" && (s[j + 1] === "/" || s[j + 1] === "*"))) j++; return j; }
          let d = 0, j = v;
          while (j < s.length) { const c = s[j]; if (c === "/" && (s[j + 1] === "/" || s[j + 1] === "*")) { j = skipCom(j); continue; } if (c === "\"") { j = skipStr(j); continue; } if (c === "{" || c === "[") d++; else if (c === "}" || c === "]") { d--; if (!d) return j + 1; } j++; }
          return -1;
        };
        while (i < s.length) {
          const c = s[i];
          if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) { i = skipCom(i); continue; }
          if (c === "\"") {
            const j = skipStr(i), k = skipWs(j);
            if (depth === 1 && s[k] === ":") { // a key at the top level (a string VALUE is never followed by ":")
              const v = skipWs(k + 1);
              if (s.slice(i, j) === "\"phone\"" && keyAt < 0) { keyAt = i; end = valueEnd(v); break; }
              i = v; const e = valueEnd(v); if (e < 0) break; i = e; continue; // skip the whole value
            }
            i = j; continue;
          }
          if (c === "{" || c === "[") { if (depth === 0 && first < 0) first = i; depth++; }
          else if (c === "}" || c === "]") depth--;
          i++;
        }
        let t;
        if (keyAt >= 0 && end > keyAt) t = s.slice(0, keyAt) + line + s.slice(end);
        else if (first >= 0) t = s.slice(0, first + 1) + "\n  " + line + "," + s.slice(first + 1);
        else process.exit(0);
        fs.writeFileSync(p, t);' "$p" "$HYPRPI_REMOTE_NTFY"
      echo "phone pushes: $(node -e 'try{const n=JSON.parse(process.argv[1]);console.log((n.enabled?"on":"off")+", topic "+n.topic)}catch{console.log("?")}' "$HYPRPI_REMOTE_NTFY")"
    fi
    # J547 (Angus: "a shared folder for the hub cpu instance, like ~/Brev/Hub"): when the laptop syncs a folder of this machine
    # (HYPRPI_REMOTE_SHARED="REMOTE|LAPTOP", from its brev-sync.conf), this machine's agents learn where hand-offs go: a marked
    # block in ~/.pi/agent/AGENTS.md (pi reads it in every session), replaced on each setup and removed when there's no pair.
    ag="$HOME/.pi/agent/AGENTS.md"; mkdir -p "$(dirname "$ag")"
    blk=""
    if [[ "${HYPRPI_REMOTE_SHARED:-}" =~ ^([A-Za-z0-9._/-]+)\|([A-Za-z0-9._/~-]+)$ && "${BASH_REMATCH[1]}" != *..* ]]; then
      rf="${BASH_REMATCH[1]}"; lf="${BASH_REMATCH[2]}"; mkdir -p "$HOME/$rf"
      blk="<!-- hyprpi:shared-folder (J547; written by omnistation/remote.sh install, replaced on every setup) -->
## Shared folder with Angus's laptop

\`~/$rf\` on this machine syncs both ways with \`$lf\` on Angus's laptop (brev-sync, about every 2 minutes while this machine runs). Put hand-offs for Angus or for laptop agents there (results, reports, images, files to review), and look there for files he or his agents leave for you.$([[ "$lf" == "~/Brev"* ]] && printf ' Angus can also open them on his phone (the phone app'"'"'s Files tab shows ~/Brev).' || true) If both sides change the same file, the newer one wins and the other is kept next to it as \"name (conflict_on_DATE).ext\". Keep secrets and keys out of it.
<!-- /hyprpi:shared-folder -->"
    fi
    if [[ -f "$ag" ]]; then sed -i '/^<!-- hyprpi:shared-folder /,/^<!-- \/hyprpi:shared-folder -->$/d' "$ag"; t="$(cat "$ag")"; if [[ -n "$t" ]]; then printf '%s\n' "$t" > "$ag"; else : > "$ag"; fi; fi # (and no blank lines left behind)
    if [[ -n "$blk" ]]; then { [[ -s "$ag" ]] && printf '\n'; printf '%s\n' "$blk"; } >> "$ag"; echo "shared folder: ~/$rf <-> laptop $lf (noted in $ag)"; fi
    echo "hyprpi $(git -C "$DIR" log -1 --format=%h 2>/dev/null || cat "$DIR/.version" 2>/dev/null) in $DIR; pi $(pi --version 2>/dev/null | head -1); node $(node -v)"
    echo "next: log pi in once (run \`pi\` here, /login), then: remote.sh start" ;;
  start)
    secrets_ok || exit 5
    # J480: the daemon (and the Thoughts it starts) must never look like an agent to pi-entry: a tmux server first started from an
    # agent's environment passed HYPRPI_REMOTE_RPC/HYPRPI_NAME on, and Thoughts-I then ran as "hbroker serve brev-alpha"
    # J543 (live: of four agents the daemon started at once, one never started: they raced to create this tmux session and `set -e`
    # ended the loser): a daemon that already listens (often one an agent's ensure started, outside tmux) needs none, and a lost race is fine
    [[ -S "$HYPRPI_SOCKET" ]] || tmux has-session -t "=hyprpi-$W-daemon" 2>/dev/null || tmux new-session -d -s hyprpi-$W-daemon "unset HYPRPI_REMOTE_RPC HYPRPI_NAME HYPRPI_AGENT_ID HYPRPI_REMOTE_WORLD; $(declare -p HYPRPI_STATE HYPRPI_SOCKET XDG_RUNTIME_DIR HYPRPI_NO_ADOPT PATH ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS} | sed 's/^declare -x /export /'); exec node $(printf %q "$DIR/bin/hyprpi") daemon" || true
    for _ in $(seq 30); do [[ -S "$HYPRPI_SOCKET" ]] && break; sleep 0.5; done
    [[ -S "$HYPRPI_SOCKET" ]] || { echo "remote.sh: the daemon didn't start (tmux attach -t hyprpi-$W-daemon shows why)" >&2; exit 4; }
    if [[ "${HYPRPI_START_NEW:-}" == 1 ]] && { tmux has-session -t "=hyprpi-$W-$NAME" 2>/dev/null || [[ -e "$ROOT/sessions/$NAME" ]]; }; then echo "remote.sh: $NAME is taken (a new agent needs a new name)" >&2; exit 3; fi
    # J543: the daemon restarting it (upkeep refresh, /restart): its old session ends first (its pi has exited); wait for that
    if [[ "${HYPRPI_START_RESTART:-}" == 1 ]]; then for _ in $(seq 40); do tmux has-session -t "=hyprpi-$W-$NAME" 2>/dev/null || break; sleep 0.5; done; fi
    if tmux has-session -t "hyprpi-$W-$NAME" 2>/dev/null; then echo "agent $NAME already runs"; exit 0; fi
    # its pi session is resumed when it ran before (the newest session of this agent id), else a new one starts
    sess=$(ls -t "$ROOT/sessions/$NAME"/*.jsonl 2>/dev/null | head -1 || true)
    # J543: a restart names its session (one of this agent's own), or asks for a fresh one (an upkeep refresh: the handoff is its welcome)
    if [[ "${HYPRPI_START_RESTART:-}" == 1 && "${HYPRPI_START_FRESH:-}" == 1 ]]; then sess=""
    elif [[ "${HYPRPI_START_RESTART:-}" == 1 && -f "${HYPRPI_START_SESSION:-}" && "$(dirname "$(readlink -f "$HYPRPI_START_SESSION")")" == "$(readlink -f "$ROOT/sessions/$NAME")" ]]; then sess="$HYPRPI_START_SESSION"; fi
    # its icon: a normal agent icon, steady for its name (the world's 📡 goes after the name, like 🐳 for a sandbox: J471 v2)
    icon=$(node -e 'import(process.argv[1]).then((m) => console.log(m.sbxIcon(undefined, process.argv[2])))' "$DIR/lib/sandbox-icon.mjs" "$NAME" 2>/dev/null || true)
    # J543 (parity: open_agent / spawn_agent on this machine): the daemon starts its new agents through here, with their own name,
    # icon, folder, model, thinking, fork and workspace (HYPRPI_START_*, each checked; anything else falls back to the defaults).
    # NAME stays the slug: tmux session, RPC socket (HYPRPI_RPC_NAME) and the laptop's window (world X open NAME) go by it.
    disp="$NAME"; [[ "${HYPRPI_START_DISPLAY:-}" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,59}$ ]] && disp="$HYPRPI_START_DISPLAY"
    ic="${HYPRPI_START_ICON:-}"; [[ -n "$ic" && ${#ic} -le 32 && ! "$ic" =~ [[:alnum:][:space:][:cntrl:]\'\"\\\$\`] ]] && icon="$ic"
    [[ -n "${HYPRPI_START_CWD:-}" && -d "${HYPRPI_START_CWD}" ]] && WORK="$HYPRPI_START_CWD"
    pa=()
    [[ "${HYPRPI_START_MODEL:-}" =~ ^[A-Za-z0-9._:@~/-]{1,120}$ ]] && pa+=(--model "$HYPRPI_START_MODEL")
    [[ "${HYPRPI_START_THINKING:-}" =~ ^(off|minimal|low|medium|high|xhigh|max)$ ]] && pa+=(--thinking "$HYPRPI_START_THINKING")
    [[ -z "$sess" && -n "${HYPRPI_START_FORK:-}" && -f "${HYPRPI_START_FORK}" ]] && pa+=(--fork "$HYPRPI_START_FORK")
    sws="$HYPRPI_REMOTE_WS"; [[ "${HYPRPI_START_WS:-}" =~ ^[0-9]{1,3}$ ]] && (( HYPRPI_START_WS >= HYPRPI_REMOTE_WS && HYPRPI_START_WS < HYPRPI_REMOTE_WS + 10 )) && sws="$HYPRPI_START_WS"
    pas=""; (( ${#pa[@]} )) && pas="$(printf '%q ' "${pa[@]}")"
    export HYPRPI_RPC_NAME="$NAME"
    export HYPRPI_REMOTE_WORLD="${W^^}"
    if [[ "${HYPRPI_REMOTE_MIRROR:-}" == 1 ]]; then export HYPRPI_REMOTE_RPC=0; else export HYPRPI_REMOTE_RPC=1; fi
    tmux new-session -d -s "hyprpi-$W-$NAME" -c "$WORK" "$(declare -p HYPRPI_STATE HYPRPI_SOCKET XDG_RUNTIME_DIR HYPRPI_NO_ADOPT HYPRPI_REMOTE_RPC HYPRPI_REMOTE_WORLD HYPRPI_RPC_NAME PATH ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS} | sed 's/^declare -x /export /'); exec node $(printf %q "$DIR/bin/hyprpi") new --id $W-$NAME --name $(printf %q "$disp") --icon $(printf %q "$icon") --cwd $(printf %q "$WORK") --workspace $(printf %q "$sws") -- $pas--session-dir $(printf %q "$ROOT/sessions/$NAME") ${sess:+--session $(printf %q "$sess")}"  # (Ledger: every path quoted for the tmux command string)
    tmux set-option -t "hyprpi-$W-$NAME" status off >/dev/null 2>&1 || true  # the window looks like any hyprpi agent: no tmux bar
    sleep 2; tmux has-session -t "hyprpi-$W-$NAME" 2>/dev/null && echo "agent $NAME started (tmux session hyprpi-$W-$NAME)" || { echo "remote.sh: agent $NAME exited at once" >&2; exit 4; } ;;
  connect)
    # (no output of our own on stdout: it carries the RPC stream)
    # a window's reconnect passes "nostart": an agent stopped on purpose stays stopped
    [[ "${3:-}" == nostart ]] || tmux has-session -t "hyprpi-$W-$NAME" 2>/dev/null || bash "$ROOT/remote.sh" start "$NAME" >/dev/null 2>&1 || true
    for _ in $(seq 20); do [[ -S "$ROOT/run/$NAME.rpc.sock" ]] && break; sleep 0.5; done
    exec node "$ROOT/hbroker.mjs" connect "$NAME" ;;
  restart-daemon)
    # J530 (a slip on Omnistation): restarts THIS world's daemon only. Never `pgrep -f "bin/hyprpi daemon"`: the tmux SERVER's command
    # line contains that text too (it is the first session's command), and killing it ends every agent's session.
    # (review) The pid comes from the lock file and must be exactly this world's daemon: argv node $DIR/bin/hyprpi daemon, and its
    # HYPRPI_STATE this world's state. It is signalled through a pidfd opened before its identity is checked again, so a reused pid is never signalled. Sockets and
    # tmux sessions are left to the daemon's own lock-protected start; tmux targets are exact (=name). Success = the daemon answers.
    lockf="$ROOT/run/daemon.lock"
    isdaemon() { local cl; [[ -r /proc/$1/cmdline ]] || return 1; mapfile -d '' -t cl < /proc/$1/cmdline
      [[ "${#cl[@]}" -eq 3 && "${cl[0]##*/}" == node && "${cl[1]}" == "$DIR/bin/hyprpi" && "${cl[2]}" == daemon ]] || return 1
      tr '\0' '\n' < /proc/$1/environ 2>/dev/null | grep -qxF "HYPRPI_STATE=$HYPRPI_STATE"; }
    answers() { timeout 8 node -e 'import(process.argv[1]).then(async (c) => { await c.request("list", {}, { timeout: 2000, timeoutMs: 4000 }); process.exit(0); }).catch(() => process.exit(1))' "$DIR/lib/client.mjs" >/dev/null 2>&1; }
    secrets_ok || exit 5 # (before anything is stopped: a refusal must leave the old daemon running)
    pid=""; [[ -f "$lockf" ]] && pid=$(tr -cd '0-9' 2>/dev/null < "$lockf" || true)
    if [[ -n "$pid" ]] && isdaemon "$pid"; then
      # (review) signalled through a pidfd opened BEFORE the identity is checked again: a pid reused in between can't be hit
      python3 - "$pid" "$DIR/bin/hyprpi" "HYPRPI_STATE=$HYPRPI_STATE" <<'PYK' || { echo "remote.sh: the daemon (pid $pid) wasn't stopped: nothing else changed" >&2; exit 3; }
import os, select, signal, sys
pid, bin_, st = int(sys.argv[1]), sys.argv[2], sys.argv[3]
try: fd = os.pidfd_open(pid)
except ProcessLookupError: sys.exit(0)  # (review) already gone: fine
def same():
    try:
        a = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")[:-1]
        e = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    except OSError: return False
    return len(a) == 3 and os.path.basename(a[0]) == b"node" and a[1] == bin_.encode() and a[2] == b"daemon" and st.encode() in e
if not same(): sys.exit(0 if select.select([fd], [], [], 0)[0] else 3)  # gone already: fine; another process now: refuse
def wait(t): return bool(select.select([fd], [], [], t)[0])  # readable = it exited
def send(sig):
    try: signal.pidfd_send_signal(fd, sig)
    except ProcessLookupError: pass  # exited meanwhile
send(signal.SIGTERM)
if not wait(10):
    send(signal.SIGKILL)  # (live) it can ignore TERM; the pidfd still names the same process
    if not wait(5): sys.exit(3)
PYK
    elif [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "remote.sh: pid $pid in daemon.lock isn't world ${W^^}'s daemon: not killing it" >&2; exit 3; fi
    # an agent's own `hyprpi ensure` often starts the new one within a second or two; else one is started here, in tmux
    for _ in $(seq 6); do answers && break; sleep 0.5; done
    if ! answers; then
      tmux kill-session -t "=hyprpi-$W-daemon" 2>/dev/null || true
      tmux new-session -d -s hyprpi-$W-daemon "unset HYPRPI_REMOTE_RPC HYPRPI_NAME HYPRPI_AGENT_ID HYPRPI_REMOTE_WORLD; $(declare -p HYPRPI_STATE HYPRPI_SOCKET XDG_RUNTIME_DIR HYPRPI_NO_ADOPT PATH ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS} | sed 's/^declare -x /export /'); exec node $(printf %q "$DIR/bin/hyprpi") daemon"
      for _ in $(seq 30); do answers && break; sleep 0.5; done
    fi
    answers && echo "daemon restarted (world ${W^^}, pid $(tr -cd '0-9' 2>/dev/null < "$lockf" || true))" || { echo "remote.sh: the daemon didn't come back (tmux attach -t hyprpi-$W-daemon)" >&2; exit 4; } ;;
  thoughts-relay)
    # J530: a message for this world's Thoughts from the laptop (JSON on stdin); prints its answer (lib/remote-thoughts.mjs)
    secrets_ok || exit 3
    [[ -S "$HYPRPI_SOCKET" ]] || { echo '{"error":"the daemon on this machine is not running"}'; exit 0; }
    exec env HYPRPI_REMOTE_WORLD="${W^^}" node "$DIR/lib/remote-thoughts.mjs" "${W^^}" ;;
  link)
    # J555: the world's panel link: the laptop's omnistation/rlink.mjs runs this over one ssh and carries every laptop panel's
    # connection to this daemon through it (omnistation/rlink-remote.mjs; stdout carries the frames, nothing else may print)
    secrets_ok >&2 || exit 3
    exec node "$DIR/omnistation/rlink-remote.mjs" ;;
  panel)
    # J480: one of the world's panels (room = Stream, board = Projects, search = Thoughts, agents), run HERE against this
    # machine's daemon, in the ssh terminal the laptop's panel window opened (omnistation/world X panel KIND)
    kind="${NAME}"; [[ "$kind" =~ ^(room|board|search|agents)$ ]] || { echo "remote.sh: panel room|board|search|agents" >&2; exit 2; }
    secrets_ok || exit 3
    [[ -S "$HYPRPI_SOCKET" ]] || { echo "remote.sh: world ${W^^}'s daemon isn't running here (start an agent: world ${W^^} new)" >&2; exit 4; }
    export HYPRPI_REMOTE_PANEL=1 TERM="${TERM:-xterm-256color}"
    # J543: the laptop's pty relay (omnistation/pty-relay.py) does what the panel asks of the desktop; its nonce for this run.
    # J553 (10): never on a command line (other users here see those in ps): HYPRPI_LAPTOP_RELAY=ask means the relay types it in.
    # With the terminal's echo off, a private request goes to the relay, which answers once, before the panel draws, with one line
    # "hyprpi-nonce:<nonce>"; it ends up only in the panel's environment (readable by this user alone). (A laptop from before J553
    # still passes the nonce itself, which works as before.)
    if [[ "${HYPRPI_LAPTOP_RELAY:-}" == ask ]]; then
      unset HYPRPI_LAPTOP_RELAY
      if [[ -t 0 && -t 1 ]]; then
        sv=$(stty -g 2>/dev/null || true); stty -echo 2>/dev/null || true
        printf '\033]5379;hyprpi-nonce\007'
        end=$(( SECONDS + 15 ))
        while (( SECONDS < end )); do
          IFS= read -r -t $(( end - SECONDS )) l || break
          if [[ "${l%$'\r'}" =~ hyprpi-nonce:([A-Za-z0-9]{16,64})$ ]]; then export HYPRPI_LAPTOP_RELAY="${BASH_REMATCH[1]}"; break; fi
        done
        [[ -z "$sv" ]] || stty "$sv" 2>/dev/null || true
      fi
    fi
    [[ "${HYPRPI_LAPTOP_RELAY:-}" =~ ^[A-Za-z0-9]{16,64}$ ]] || unset HYPRPI_LAPTOP_RELAY
    exec node "$DIR/mockups/$kind-tui.mjs" "${W^^}" ;;
  attach)
    tmux has-session -t "hyprpi-$W-$NAME" 2>/dev/null || bash "$ROOT/remote.sh" start "$NAME" >/dev/null
    tmux set-option -t "hyprpi-$W-$NAME" status off >/dev/null 2>&1 || true
    exec tmux attach -t "hyprpi-$W-$NAME" ;;
  rename)
    # J471 v2 (Angus: "maybe they can start with 'omni-'"): agent NAME becomes NEW, keeping its session (stop, move the session
    # folder, start under the new name); the old id is forgotten by the daemon so lists don't show it twice
    NEW="${3:-}"; [[ "$NEW" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || { echo "remote.sh: rename NAME NEW (lowercase letters, digits and -)" >&2; exit 2; }
    [[ -d "$ROOT/sessions/$NAME" ]] || { echo "remote.sh: $NAME has no session here" >&2; exit 3; }
    [[ ! -e "$ROOT/sessions/$NEW" ]] || { echo "remote.sh: $NEW already exists" >&2; exit 3; }
    tmux kill-session -t "hyprpi-$W-$NAME" 2>/dev/null || true; sleep 2
    mv "$ROOT/sessions/$NAME" "$ROOT/sessions/$NEW"
    [[ -S "$HYPRPI_SOCKET" ]] && node -e 'import(process.argv[1]).then(async (c) => { try { await c.request("agent.forget", { agent: process.argv[2] }); } catch {} process.exit(0); })' "$DIR/lib/client.mjs" "$W-$NAME" >/dev/null 2>&1 || true
    bash "$ROOT/remote.sh" start "$NEW" ;;
  status)
    tmux ls 2>/dev/null | grep "^hyprpi-$W-" || echo "nothing running"
    [[ -S "$HYPRPI_SOCKET" ]] && hp list 2>/dev/null | head -20 || true ;;
  stop)
    if [[ "$NAME" == all ]]; then for s in $(tmux ls -F '#S' 2>/dev/null | grep "^hyprpi-$W-"); do tmux kill-session -t "$s"; done; echo "stopped all"
    else tmux kill-session -t "hyprpi-$W-$NAME" 2>/dev/null && echo "stopped $NAME (its session stays: start $NAME resumes it)" || echo "$NAME wasn't running"; fi ;;
  *) echo "usage: remote.sh install | start [NAME] | connect [NAME] | attach [NAME] | panel room|board|search|agents | rename NAME NEW | status | stop [NAME|all]" >&2; exit 2 ;;
esac
