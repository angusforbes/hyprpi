#!/usr/bin/env bash
# Install (or re-install) the hourly research digest as a transient systemd user timer, from THIS checkout (J375).
# The unit is transient (gone at logout/reboot): run `docker/research/digest-timer.sh` again after a login. `stop` removes it.
set -euo pipefail
H="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
U=hyprpi-research-digest
systemctl --user stop "$U.timer" "$U.service" 2>/dev/null || true
systemctl --user reset-failed "$U.service" 2>/dev/null || true
[[ "${1:-}" == stop ]] && { echo "stopped $U"; exit 0; }
systemd-run --user --unit="$U" --on-calendar=hourly --collect "$(command -v node)" "$H/docker/research/research.mjs" digest --send
