# J333: sourced by the panel / summon shell launchers. An isolated hyprpi (a test's own socket or state
# dir, or HYPRPI_TEST; lib/paths.mjs isolatedReason) opens no windows on the real desktop. The cheap
# shell test skips node in the real session; HYPRPI_ALLOW_HYPR=1 lifts it.
if [ "${HYPRPI_ALLOW_HYPR:-}" != 1 ] && [ -z "${HYPRPI_SANDBOX_WORLD:-}" ] && { [ -n "${HYPRPI_SOCKET:-}${HYPRPI_STATE:-}" ] || { [ -n "${HYPRPI_TEST:-}" ] && [ "${HYPRPI_TEST:-}" != 0 ]; } || [ "${XDG_RUNTIME_DIR:-}" != "/run/user/$(id -u)" ] || [ "${XDG_STATE_HOME:-$HOME/.local/state}" != "$HOME/.local/state" ]; }; then
  # isolated-check exits 0 = isolated, 1 = the real session; anything else (no node, a broken
  # checkout) fails CLOSED: no window (GuardReview).
  _why=$(node "$(dirname "$(readlink -f "$0")")/../lib/isolated-check.mjs" 2>&1); _rc=$?
  if [ "$_rc" != 1 ]; then
    [ "$_rc" = 0 ] || _why="couldn't check (exit $_rc: $_why)"
    echo "$(basename "$0"): hypr actions disabled (isolated daemon: $_why); HYPRPI_ALLOW_HYPR=1 allows them" >&2
    exit 1
  fi
fi
