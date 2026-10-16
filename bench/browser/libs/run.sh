#!/bin/bash
# J680 W4: a throwaway headless Brave (temp profile, port 9680) + the bench form, then libbench.mjs. Run under silent-test.
cd "$(dirname "$0")"; export NODE_PATH="${NODE_PATH:-$HOME/.cache/j680/libs/node_modules}"
/opt/brave-origin-bin/brave --headless=new --disable-gpu --disable-features=Vulkan --disable-vulkan-surface --no-first-run --user-data-dir="$SILENT_TEST_PROFILE" --remote-debugging-port=9680 about:blank >"${BRAVE_LOG:-/dev/null}" 2>&1 &
BP=$!
(cd ~/Harness/hyprpi/bench/browser && exec python3 -m http.server 8669 --bind 127.0.0.1 >/dev/null 2>&1) & HP=$!
trap 'kill $BP $HP 2>/dev/null' EXIT
for _ in $(seq 1 50); do curl -s 127.0.0.1:9680/json/version >/dev/null && curl -s 127.0.0.1:8669/ >/dev/null && break; sleep 0.1; done
node libbench.mjs 9680 "${1:-7}"
