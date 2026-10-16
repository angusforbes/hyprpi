#!/bin/bash
# J676: bin/brave-copy with a FAKE profile and a FAKE browser (a tiny server answering /json/version on the port):
# the copy is made from the source, its restore pref is set, the source is never written, and the copy is deleted on
# every exit path (success, CMD failure, SIGTERM to brave-copy, browser that never starts); port 9222 is refused.
# Run: node test/run.mjs test/brave-copy.sh   (no real Brave, no real profile)
set -u
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0 fail=0; ok() { if eval "$2"; then echo "ok   $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
SRC=$T/src; mkdir -p "$SRC/Default/Local Storage"; echo '{"profile":{"exit_type":"Crashed"}}' > "$SRC/Default/Preferences"; echo cookies > "$SRC/Default/Cookies"; echo ls > "$SRC/Default/Local Storage/x"; echo '{}' > "$SRC/Local State"; echo big > "$SRC/Default/Cache"
SUM=$(cd "$SRC" && find . -type f -exec sha256sum {} + | sort | sha256sum)
cat > "$T/fakebrave" <<'EOF'
#!/bin/bash
port=""; ud=""; for a in "$@"; do case "$a" in --remote-debugging-port=*) port=${a#*=};; --user-data-dir=*) ud=${a#*=};; esac; done
echo "$*" > "$ud/.args"; [[ -f "$FAKE_NOSTART" ]] && { sleep 30; exit 1; }
exec python3 -c "
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'{\"User-Agent\":\"x\"}')
http.server.HTTPServer(('127.0.0.1',$port),H).serve_forever()"
EOF
chmod +x "$T/fakebrave"
export BRAVE_COPY_SRC=$SRC BRAVE_COPY_BIN=$T/fakebrave BRAVE_COPY_NO_SILENT=1 BRAVE_COPY_UA_PORT=1 XDG_RUNTIME_DIR=$T/run FAKE_NOSTART=$T/nostart
mkdir -p "$T/run"; BC=$(dirname "$0")/../bin/brave-copy
copies() { ls -d "$T"/run/brave-copy-* 2>/dev/null | wc -l; }
out=$("$BC" --port 9871 -- bash -c 'd=$(ls -d $XDG_RUNTIME_DIR/brave-copy-*); echo "port=$BRAVE_COPY_PORT"; python3 -c "import json;print(\"restore=\",json.load(open(\"$d/Default/Preferences\"))[\"session\"][\"restore_on_startup\"])"; ls "$d/Default" | tr "\n" " "; echo; stat -c %a "$d"; cat "$d/.args"')
ok "CMD gets BRAVE_COPY_PORT" '[[ "$out" == *"port=9871"* ]]'
ok "the copy's Preferences restore the last session (session cookies kept)" '[[ "$out" == *"restore= 1"* ]]'
ok "login state copied (Cookies, Local Storage), caches not" '[[ "$out" == *Cookies* && "$out" == *"Local Storage"* && "$out" != *Cache* ]]'
ok "the copy folder is 700" '[[ "$out" == *$'"'"'\n700\n'"'"'* ]]'
ok "headless, keyring, DevTools on 127.0.0.1 only, the copy as profile" '[[ "$out" == *--headless=new* && "$out" == *--password-store=gnome-libsecret* && "$out" == *--remote-debugging-address=127.0.0.1* && "$out" == *--user-data-dir=$T/run/brave-copy-* ]]'
ok "copy deleted after success" '[[ $(copies) == 0 ]]'
"$BC" --port 9872 -- false; rc=$?
ok "CMD failure: its exit code passed through, copy deleted" '[[ $rc == 1 && $(copies) == 0 ]]'
"$BC" --port 9873 -- bash -c 'sleep 20; touch "$0"' "$T/term-done" & bp=$!; for _ in $(seq 1 50); do curl -s -m1 127.0.0.1:9873/json/version >/dev/null && break; sleep 0.1; done
t0=$SECONDS; kill -TERM $bp; wait $bp; rc=$?; took=$((SECONDS-t0)); sleep 0.5
ok "SIGTERM: brave-copy exits at once (143), CMD stopped, copy deleted, its browser stopped" '[[ $rc == 143 && $took -le 3 && ! -e "$T/term-done" && $(copies) == 0 ]] && ! curl -s -m1 127.0.0.1:9873/json/version >/dev/null'
touch "$T/nostart"; timeout 30 "$BC" --port 9874 -- true 2>/dev/null; rc=$?; rm -f "$T/nostart"
ok "browser never starts: exit 2, copy deleted" '[[ $rc == 2 && $(copies) == 0 ]]'
"$BC" --port 9222 -- true 2>/dev/null; rc=$?
ok "port 9222 (his Brave) refused" '[[ $rc == 2 && $(copies) == 0 ]]'
"$BC" --port 09222 -- true 2>/dev/null; rc=$?
ok "a zero-padded 09222 refused too" '[[ $rc == 2 ]]'
"$BC" --port abc -- true 2>/dev/null; rc=$?
ok "a non-numeric port refused" '[[ $rc == 2 ]]'
python3 -m http.server 9875 --bind 127.0.0.1 >/dev/null 2>&1 & sp=$!; for _ in $(seq 1 30); do curl -s -m1 127.0.0.1:9875/ >/dev/null && break; sleep 0.1; done
"$BC" --port 9875 -- touch "$T/ran" 2>/dev/null; rc=$?; kill $sp
ok "an occupied port refused, CMD not run" '[[ $rc == 2 && ! -e "$T/ran" && $(copies) == 0 ]]'
BRAVE_COPY_BIN=/bin/false "$BC" --port 9876 -- touch "$T/ran2" 2>/dev/null; rc=$?
ok "a browser that exits at once: CMD not run, exit 2" '[[ $rc == 2 && ! -e "$T/ran2" && $(copies) == 0 ]]'
# SIGINT as from a terminal Ctrl-C: started with SIGINT at its default (a `&` job of this script would inherit it ignored)
python3 -c 'import signal,subprocess,sys; signal.signal(signal.SIGINT, signal.SIG_DFL); sys.exit(subprocess.call(sys.argv[1:]))' "$BC" --port 9877 -- bash -c 'sleep 20; touch "$0"' "$T/int-done" & pp=$!
for _ in $(seq 1 50); do curl -s -m1 127.0.0.1:9877/json/version >/dev/null && break; sleep 0.1; done
bcpid=$(pgrep -P $pp | head -1); t0=$SECONDS; kill -INT "$bcpid"; wait $pp; rc=$?; took=$((SECONDS-t0)); sleep 0.5
ok "SIGINT: brave-copy exits at once (130), CMD stopped, copy deleted, its browser stopped" '[[ $rc == 130 && $took -le 3 && ! -e "$T/int-done" && $(copies) == 0 ]] && ! curl -s -m1 127.0.0.1:9877/json/version >/dev/null'
ok "the source profile was never written" '[[ "$(cd "$SRC" && find . -type f -exec sha256sum {} + | sort | sha256sum)" == "$SUM" ]]'
echo "$pass passed, $fail failed"; exit $(( fail > 0 ))
