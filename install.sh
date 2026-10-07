#!/usr/bin/env bash
# hyprpi installer: a thin wrapper around `hyprpi integration`, which wires each piece into your home
# folder reversibly (see README.md, "Install"). Run it from the checkout, wherever you cloned it:
#   ./install.sh                 the recommended pieces: hypr, path, bar, kitty
#   ./install.sh all             also gateway, remote, hyprwrlds, hyprwrlds-vimarchy
#   ./install.sh hypr path       only these
# Undo any piece with `hyprpi integration uninstall NAME`; see what's in with `hyprpi integration status`.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
command -v node >/dev/null || { echo "install.sh: node (22 or newer) is needed first; see docs/requirements.md" >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
(( major >= 22 )) || { echo "install.sh: node $major is too old; hyprpi needs node 22+ (docs/requirements.md)" >&2; exit 1; }
command -v pi >/dev/null || echo "note: pi isn't installed yet (npm i -g @earendil-works/pi-coding-agent; see docs/requirements.md)"
pieces=("$@"); (( ${#pieces[@]} )) || pieces=(recommended)
# Omarchy's bar plugins only where the Omarchy shell exists.
if [[ " ${pieces[*]} " == *" recommended "* ]] && ! command -v omarchy-shell >/dev/null; then
  pieces=(hypr path kitty); echo "note: no Omarchy shell found, so the bar piece is skipped"
fi
node "$here/bin/hyprpi" integration install "${pieces[@]}"
echo
node "$here/bin/hyprpi" integration status
echo
echo "Next: log in to pi (run \`pi\`, then /login), then press SUPER+A for your first agent. Optional: ./install.sh gateway remote hyprwrlds hyprwrlds-vimarchy"
