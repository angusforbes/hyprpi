#!/usr/bin/env bash
# Install the hourly research digest as a permanent systemd user timer + service (J382), pointing at THIS checkout.
# `digest-timer.sh` installs/refreshes and enables it (replacing any older transient unit); `digest-timer.sh stop` removes it.
set -euo pipefail
H="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
U=hyprpi-research-digest
D="$HOME/.config/systemd/user"
systemctl --user disable --now "$U.timer" 2>/dev/null || true
systemctl --user stop "$U.service" 2>/dev/null || true
rm -f "$D/$U.timer" "$D/$U.service"
UD=hyprpi-research-daily # J412: the one-line daily digest of what went through without a human decision
systemctl --user disable --now "$UD.timer" 2>/dev/null || true; systemctl --user stop "$UD.service" 2>/dev/null || true; rm -f "$D/$UD.timer" "$D/$UD.service"
if [[ "${1:-}" == stop ]]; then systemctl --user daemon-reload; systemctl --user reset-failed "$U.service" 2>/dev/null || true; echo "removed $U and $UD"; exit 0; fi
mkdir -p "$D"
NODE="$(command -v node)"
cat > "$D/$U.service" <<EOF
[Unit]
Description=hyprpi hourly research digest (sent to the reporting Thoughts)

[Service]
Type=oneshot
ExecStart=$NODE $H/docker/research/research.mjs digest --send
EOF
cat > "$D/$U.timer" <<EOF
[Unit]
Description=hyprpi hourly research digest

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
EOF
cat > "$D/$UD.service" <<EOF
[Unit]
Description=hyprpi daily digest of auto-approved items (J412, sent to the reporting Thoughts)

[Service]
Type=oneshot
ExecStart=$NODE $H/docker/research/research.mjs digest --daily --send
EOF
cat > "$D/$UD.timer" <<EOF
[Unit]
Description=hyprpi daily digest (J412)

[Timer]
OnCalendar=*-*-* 08:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user reset-failed "$U.service" 2>/dev/null || true
systemctl --user enable --now "$U.timer" "$UD.timer"
echo "installed $D/$U.{service,timer} (node $NODE, checkout $H)"
