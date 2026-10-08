# The environment of a sandboxed hyprpi world, inside its sandbox (J262). Sourced by everything that runs
# there: the inner daemon, the gate, and (through bin/kitty's launch files) every window's command.
# Host paths (the sandbox sees them at the same place), written by docker/world/world.sh: G_HOST_HYPRPI,
# G_WORLD_DIR, G_HYPR_INBOX, G_MSG_INBOX.
[ -f "$HOME/.hyprpi-g/host.env" ] && . "$HOME/.hyprpi-g/host.env"
W="$G_HOST_HYPRPI/docker/world"
export HYPRPI_G_WORLD=world-g
export HYPRLAND_INSTANCE_SIGNATURE=world-g
export XDG_RUNTIME_DIR="$HOME/.hyprpi-g/run"
export HYPRPI_SOCKET="$HOME/.hyprpi-g/run/daemon.sock"
export HYPRPI_STATE="$HOME/.hyprpi-g/state"
export HYPRPI_NO_ADOPT=1
export HYPRPI_G_OUT=$G_WORLD_DIR/.hyprpi-g/hypr-out
export HYPRPI_G_IN=$G_HYPR_INBOX
export HYPRPI_DROPBOX=$G_WORLD_DIR/.hyprpi-dropbox
export HYPRPI_INBOX=$G_MSG_INBOX
export PATH="$W/bin:$HOME/.local/bin:$G_HOST_HYPRPI/bin:$PATH"
mkdir -p "$XDG_RUNTIME_DIR" "$HYPRPI_STATE" && chmod 700 "$XDG_RUNTIME_DIR"
