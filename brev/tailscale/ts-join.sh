#!/usr/bin/env bash
# brev/tailscale/ts-join.sh HOSTNAME [ssh]: runs ON a remote machine (J525), sent by `omnistation/world X setup` when the world's
# binding has "tailscale". Installs Tailscale if it's missing and joins Angus's tailnet as HOSTNAME, with Tailscale SSH when "ssh"
# is given. The auth key comes on stdin (never on a command line, never printed); it is written to a 600 file only for `tailscale
# up --auth-key=file:…` and removed at once. Already in the tailnet: it says so and reads nothing (idempotent).
# Prints one last line: "tailnet NAME" (the MagicDNS name) or "tailscale: …" when it couldn't.
set -uo pipefail
HN="${1:-}"; WANT_SSH="${2:-}"
[[ "$HN" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "tailscale: bad hostname"; exit 2; }
running() { tailscale status --json 2>/dev/null | python3 -c 'import json,sys; j=json.load(sys.stdin); sys.exit(0 if j.get("BackendState")=="Running" else 1)' 2>/dev/null; }
name() { tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null; }
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sudo sh >/dev/null 2>&1 || { echo "tailscale: install failed (curl https://tailscale.com/install.sh)"; exit 3; }
fi
sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
if running; then
  cat >/dev/null  # already joined: the key (if any was sent) is ignored
  # (review) Tailscale SSH follows the binding both ways, and a failure says so
  if [[ "$WANT_SSH" == ssh ]]; then sudo tailscale set --ssh --accept-risk=lose-ssh >/dev/null 2>&1 || { echo "tailscale: in the tailnet as $(name), but turning on Tailscale SSH failed"; exit 7; }
  else sudo tailscale set --ssh=false --accept-risk=lose-ssh >/dev/null 2>&1 || { echo "tailscale: in the tailnet as $(name), but turning off Tailscale SSH failed"; exit 7; }; fi
  echo "tailnet $(name)"; exit 0
fi
umask 077; kf="$(mktemp)"; trap 'rm -f "$kf"' EXIT
tr -d '\r\n' > "$kf"
[[ -s "$kf" ]] || { echo "tailscale: no auth key was sent"; exit 4; }
args=(up --auth-key="file:$kf" --hostname="$HN"); [[ "$WANT_SSH" == ssh ]] && args+=(--ssh --accept-risk=lose-ssh)  # (J525 live) setup's own ssh comes through Brev, not the tailnet, but tailscale asks anyway
if ! out="$(sudo tailscale "${args[@]}" 2>&1)"; then echo "tailscale: up failed: $(tr '\n' ' ' <<<"$out" | sed 's/tskey-[A-Za-z0-9-]*/tskey-…/g' | cut -c1-200)"; exit 5; fi
rm -f "$kf"
running && echo "tailnet $(name)" || { echo "tailscale: joined but not running"; exit 6; }
