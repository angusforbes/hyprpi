# omnistation/: remote worlds, headless hyprpi on another machine

Any world (A to I) can be bound to a remote Linux machine: its agents run there and the laptop shows them. On the remote machine a headless hyprpi daemon and each agent run in their own tmux session under `~/.hyprpi-<letter>` (no Hyprland, panels or windows), so they keep running when ssh drops or the laptop sleeps. Two worlds can share one machine.

On the laptop an agent is a window on its world's workspaces, drawn locally (J471): pi's own editor, message and tool components run on the laptop, so typing and editing never cross the link. A finished message goes to the remote pi, which runs in RPC mode behind a small broker, and its events (streamed text, tool calls and results) come back and render locally. The window loads the session's history when it connects, and reconnects by itself after a dropped ssh or a new login.

- `world`: the laptop side: `world X setup|new NAME|open NAME|status|stop NAME|binding` (X = the world letter). `world-h` is the J469 alias for `world H`.
- `remote-client.mjs`: the window `world X open NAME` starts (kitty, silently, on the world's first workspace). Keys: Enter sends (a steer while the agent works), Alt+Enter queues a follow-up, Esc interrupts, /model or Ctrl+L picks the model (type to filter), Ctrl+O expands tool output, Ctrl+C twice or /quit closes the window (the agent keeps running).
- `remote.sh`: runs ON the remote machine (copied by `world X setup`): install, start NAME, connect NAME, status, stop; attach NAME for the mirror fallback. It refuses to start while a secret (hyprpi-secrets, pi's auth.json and models.json, the search tool's token) is readable by others.
- `hbroker.mjs`: on the remote machine, keeps one agent's `pi --mode rpc` running with the hyprpi extension, serves it on `~/.hyprpi-<letter>/run/NAME.rpc.sock` for several clients at once, and answers pings so dead connections end.
- The fallback, J469's mirror (pi's terminal UI in remote tmux, every key over ssh): `world X start-mirror NAME` then `world X open-mirror NAME`.

The binding is private (never in this repo): `~/.config/hyprpi/remote/<letter>.json`, e.g. `{ "ssh": ["ssh", "me@my-server"], "label": "My server" }`. "ssh" is the argv that reaches the machine (plain ssh, or a Teleport `tsh ssh user@host`); "label" is optional; "workspace" overrides the world's first workspace, which otherwise comes from hyprpi's world layout (worldSize 10: H = 71). `world X binding` prints it as JSON for other tools (the phone app).

Learned on the first machine (J469): its git host was unreachable (setup copies the laptop's hyprpi instead), its outbound TLS is inspected by a local CA (remote.sh makes node trust the system bundle), and kitty's terminal type is unknown there (remote.sh falls back to xterm-256color for tmux). The model provider, its key and the allowed-model list are set on the remote machine's pi, privately.

Next: the world's panels (agents, room, board) as windows reading the remote daemon over ssh; the room and talk between a remote world and the laptop's; the phone app (J472); links and file paths printed by a remote agent; restarting after the remote machine reboots; `hyprpi new` / SUPER+A on a remote world's workspaces opening a remote agent; in the window, pi's other slash commands (/tree, /resume, /settings) and image paste.
