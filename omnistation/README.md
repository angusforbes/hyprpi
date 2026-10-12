# omnistation/: a remote world (world H), headless hyprpi on another machine

World H's agents run on a remote Linux machine; the laptop only shows them. On the remote machine a headless hyprpi daemon
and each agent run in their own tmux session (no Hyprland, panels or windows), so they keep running when ssh drops or the
laptop sleeps. On the laptop an agent of world H is a kitty window on world H's workspace (71 by default), attached over ssh.

- `remote.sh`: runs ON the remote machine (copied there by `world-h setup`): install, start NAME, attach NAME, status, stop.
- `world-h`: the laptop side: setup, start NAME, open NAME (a window, silently), status, stop.

Private settings (never in this repo): `~/.config/hyprpi/remote/world-h.json`, e.g.
`{ "ssh": ["ssh", "-t", "me@my-server"], "workspace": 71 }`. "ssh" is the argv that reaches the machine with a terminal
(plain ssh, or a Teleport `tsh ssh -t user@host`).

What the first version does (J469): one agent's window on the laptop, attached to a pi that runs under a headless hyprpi
daemon on the remote machine, with its session kept across disconnects. Learned on the first machine: its git host was
unreachable (setup copies the laptop's hyprpi instead), its outbound TLS is inspected by a local CA (remote.sh makes node
trust the system bundle), and kitty's terminal type is unknown there (remote.sh falls back to xterm-256color for tmux).
The model provider, its key and the allowed-model list are set on the remote machine's pi, privately.

Next (not in J469): the world's panels (agents, room, board) as windows reading the remote daemon over ssh; the room and
talk between world H and the laptop's worlds; the phone app seeing world H; links and file paths printed by a remote agent
(fetch over ssh); restarting the daemon and agents after the remote machine reboots (a user systemd unit with linger, if
the machine allows it); the remote login's expiry (a Teleport login lasts hours: windows drop when it ends, the agents don't);
`hyprpi new` / SUPER+A on world H's workspaces opening a remote agent.
