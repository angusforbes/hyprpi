#!/usr/bin/env bash
# brev/tailscale/ts-join.sh HOSTNAME [ssh|-] [brev]: runs ON a remote machine (J525), sent by `omnistation/world X setup` when the world's
# binding has "tailscale". Installs Tailscale if it's missing and joins Angus's tailnet as HOSTNAME, with Tailscale SSH when "ssh"
# is given. The auth key comes on stdin (never on a command line, never printed); it is written to a 600 file only for `tailscale
# up --auth-key=file:…` and removed at once. Already in the tailnet: it says so and reads nothing (idempotent).
# Prints one last line: "tailnet NAME" (the MagicDNS name) or "tailscale: …" when it couldn't.
set -uo pipefail
HN="${1:-}"; WANT_SSH="${2:-}"; MODE="${3:-}"
# J525 v2 (Tscheck2): only a Brev box ("brev") gets Tailscale's firewall rules off and --accept-risk=lose-ssh; elsewhere Tailscale's
# defaults are kept. On a Brev box, Tailscale's default rule drops 100.64.0.0/10 traffic that doesn't come in on tailscale0, which is
# where Brev's own ssh proxy comes from, so with it on, `ssh BOX` through Brev stops working.
risk=(); [[ "$MODE" == brev ]] && risk=(--accept-risk=lose-ssh)
[[ "$HN" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "tailscale: bad hostname"; exit 2; }
running() { tailscale status --json 2>/dev/null | python3 -c 'import json,sys; j=json.load(sys.stdin); sys.exit(0 if j.get("BackendState")=="Running" else 1)' 2>/dev/null; }
name() { tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null; }
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sudo sh >/dev/null 2>&1 || { echo "tailscale: install failed (curl https://tailscale.com/install.sh)"; exit 3; }
fi
if [[ "$MODE" == brev ]]; then
  # (Tscheck2) no window with the rules on: the daemon is (re)started and its pref set off by a detached systemd unit, so it finishes
  # even if this very ssh session (which comes through Brev) is cut by rules restored from an old on-mode pref at start
  sudo systemd-run --quiet --collect --unit="hyprpi-ts-nf-$$" /bin/bash -c 'systemctl enable --now tailscaled; for i in $(seq 30); do tailscale set --netfilter-mode=off && exit 0; sleep 1; done; exit 1' >/dev/null 2>&1 \
    || { echo "tailscale: starting the daemon with its firewall rules off failed"; exit 3; }
  for _ in $(seq 40); do tailscale debug prefs 2>/dev/null | grep -q '"NetfilterMode": 0' && break; sleep 1; done
  tailscale debug prefs 2>/dev/null | grep -q '"NetfilterMode": 0' || { echo "tailscale: its firewall rules are still on (Brev's ssh may be blocked)"; exit 7; }
else sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true; fi
if running; then
  cat >/dev/null  # already joined: the key (if any was sent) is ignored
  # (review) Tailscale SSH follows the binding both ways, and a failure says so
  if [[ "$WANT_SSH" == ssh ]]; then sudo tailscale set --ssh "${risk[@]}" >/dev/null 2>&1 || { echo "tailscale: in the tailnet as $(name), but turning on Tailscale SSH failed"; exit 7; }
  else sudo tailscale set --ssh=false "${risk[@]}" >/dev/null 2>&1 || { echo "tailscale: in the tailnet as $(name), but turning off Tailscale SSH failed"; exit 7; }; fi
  echo "tailnet $(name)"; exit 0
fi
umask 077; kf="$(mktemp)"; trap 'rm -f "$kf"' EXIT
tr -d '\r\n' > "$kf"
[[ -s "$kf" ]] || { echo "tailscale: no auth key was sent"; exit 4; }
args=(up --auth-key="file:$kf" --hostname="$HN"); [[ "$MODE" == brev ]] && args+=(--netfilter-mode=off); [[ "$WANT_SSH" == ssh ]] && args+=(--ssh "${risk[@]}")  # (J525 live) setup's own ssh comes through Brev, not the tailnet, but tailscale asks anyway
if ! out="$(sudo tailscale "${args[@]}" 2>&1)"; then echo "tailscale: up failed: $(tr '\n' ' ' <<<"$out" | sed 's/tskey-[A-Za-z0-9-]*/tskey-…/g' | cut -c1-200)"; exit 5; fi
rm -f "$kf"
running && echo "tailnet $(name)" || { echo "tailscale: joined but not running"; exit 6; }
