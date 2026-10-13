#!/usr/bin/env bash
# J530: omnistation/remote.sh restart-daemon in a scratch HOME with a fake hyprpi (a node process with the daemon's exact argv),
# a fake client (answers when $T/up exists) and a fake tmux (records calls; new-session "starts" a daemon). Nothing real runs.
set -uo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"; mkdir -p "$HOME/.cache"; T="$(mktemp -d -p "$HOME/.cache" j530rd.XXXX)"; pass=0; fail=0 # (not under /tmp: remote.sh refuses a world folder below a folder others can write)
ok() { if eval "$2"; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }
cleanup() { pkill -f "$T/hyprpi/bin/hyprpi" 2>/dev/null; rm -rf "$T"; }; trap cleanup EXIT
mkdir -p "$T/.hyprpi-i/run" "$T/hyprpi/bin" "$T/hyprpi/lib" "$T/bin"; chmod 700 "$T/.hyprpi-i" "$T/.hyprpi-i/run"
cp "$R/omnistation/remote.sh" "$T/.hyprpi-i/remote.sh"
# the fake daemon: writes its pid to the lock, removes it on TERM (as the real one does)
cat > "$T/hyprpi/bin/hyprpi" <<EOS
process.on("SIGTERM", () => { try { require("fs").rmSync("$T/.hyprpi-i/run/daemon.lock"); require("fs").rmSync("$T/up"); } catch {} process.exit(0); });
require("fs").writeFileSync("$T/.hyprpi-i/run/daemon.lock", String(process.pid)); require("fs").writeFileSync("$T/up", ""); setInterval(() => {}, 1000);
EOS
printf 'export async function request() { if (!require("fs").existsSync("%s/up")) throw new Error("no"); return {}; }\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);\n' "$T" > "$T/hyprpi/lib/client.mjs"
cat > "$T/bin/tmux" <<EOS
#!/usr/bin/env bash
echo "tmux \$*" >> "$T/tmux.calls"
[[ "\$1" == new-session ]] && { cd "$T"; HYPRPI_STATE="$T/.hyprpi-i/state" setsid node "$T/hyprpi/bin/hyprpi" daemon >/dev/null 2>&1 & }
exit 0
EOS
chmod +x "$T/bin/tmux"
run() { HOME="$T" HYPRPI_DIR="$T/hyprpi" HYPRPI_REMOTE_WS=81 PATH="$T/bin:$PATH" bash "$T/.hyprpi-i/remote.sh" restart-daemon 2>&1; }
start_fake() { (cd "$T"; HYPRPI_STATE="$T/.hyprpi-i/state" setsid node "$T/hyprpi/bin/hyprpi" daemon >/dev/null 2>&1 &); for _ in $(seq 20); do [[ -f "$T/.hyprpi-i/run/daemon.lock" ]] && break; sleep 0.1; done; }
# 1: a running daemon is restarted
start_fake; old=$(cat "$T/.hyprpi-i/run/daemon.lock"); o=$(run); new=$(cat "$T/.hyprpi-i/run/daemon.lock" 2>/dev/null)
ok "a running daemon is stopped and a new one answers" '[[ "$o" == *"daemon restarted"* && -n "$new" && "$new" != "$old" ]] && ! kill -0 "$old" 2>/dev/null'
ok "tmux targets are exact (=name)" 'grep -q -- "kill-session -t =hyprpi-i-daemon" "$T/tmux.calls"'
# 2: the lock names another process (pid reuse): refused, nothing killed
pkill -f "$T/hyprpi/bin/hyprpi"; sleep 0.3; rm -f "$T/up"; sleep 300 & sp=$!; echo "$sp" > "$T/.hyprpi-i/run/daemon.lock"; : > "$T/tmux.calls"; o=$(run); rc=$?
ok "a lock pid that isn't this world's daemon is refused, and not killed" '[[ $rc == 3 && "$o" == *"not killing"* ]] && kill -0 $sp && [[ ! -s "$T/tmux.calls" ]]'
kill $sp
# 3: no lock (cleanly stopped): a daemon is started
rm -f "$T/.hyprpi-i/run/daemon.lock" "$T/up"; : > "$T/tmux.calls"; o=$(run); rc=$?
ok "no lock file: a daemon is started and answers" '[[ $rc == 0 && "$o" == *"daemon restarted"* ]] && grep -q new-session "$T/tmux.calls"'
# 4: another world's daemon (same argv, other HYPRPI_STATE) named in the lock: refused
pkill -f "$T/hyprpi/bin/hyprpi"; sleep 0.3; rm -f "$T/up"
(cd "$T"; HYPRPI_STATE="$T/other" setsid node "$T/hyprpi/bin/hyprpi" daemon >/dev/null 2>&1 &); sleep 0.5; op=$(cat "$T/.hyprpi-i/run/daemon.lock"); o=$(run); rc=$?
ok "another world's daemon is not killed" '[[ $rc == 3 ]] && kill -0 "$op"'
echo "$pass passed, $fail failed"; exit $(( fail > 0 ))
