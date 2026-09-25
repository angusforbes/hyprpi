# hyprpi

Pi agents in **their own windows**, anywhere in any workspace of any
[hyprwrld](../hyprwrlds-vimarchy), grouped into **rooms** (one per world by
default). Meant to replace Herdr eventually; for now the two are separate.

| Key | Does |
|---|---|
| SUPER+A | New Pi agent in its own foot window on the current workspace; it joins that world's room |
| SUPER+ALT+A | Open/raise the room window for the current world |
| SUPER+SHIFT+A | Claude (moved here from SUPER+A) |

## Room window

A normal window (put it anywhere). Top: the room's agents with status
(● grey idle · pulsing blue working · green done), workspace, model and folder.
Click an agent to jump to its window; `@` fills in `@Name ` to prompt just that
agent. Below: the room's shared conversation. Typing without `@` posts to the
whole room: every agent in it receives the message plus the room history it
hasn't seen yet, and answers in the room (`room_reply`). `＋ agent` opens a new
agent.

## Agents

`hyprpi new` runs `foot … pi -e ~/Work/hyprpi/pi-extension/index.ts` with
`HYPRPI_AGENT_ID` set. The extension gives the agent the same tools it has
under Herdr — `room_read`, `room_post`, `room_reply`, `talk`, `demand` — plus
`talk_reply` for answering `talk`/`demand`. Herdr's own room/peer-chat
extensions stay out of the way when `HYPRPI_AGENT_ID` is set.

- `/name` and `rename_self` work as before (name-sync calls `hyprpi name`).
- `/twin-split` (pi-twin) opens the twin in a new window beside the original,
  same room, with the parent's icon and colour.
- `bonk` toasts say "Agent <icon> <Name> needs you".
- Voice: hyprpi agents (`hp:<id>`) and rooms (`room:hp-<room>`) appear in the
  voice picker, the bar widget and `voice-agent set/add`; "room" / "me" inside
  a hyprpi agent resolve to its own room / itself.

## CLI

`hyprpi help` — `new`, `room`, `list`, `post`, `send`, `focus`, `name`,
`whoami`, `daemon`, `ensure`, `stop`.

## Pieces

- `lib/daemon.mjs` — the daemon: one per Hyprland instance (socket
  `$XDG_RUNTIME_DIR/hyprpi/<hash>.sock`), started on demand. Maps each agent's
  pid to its window via `hyprctl clients` + Hyprland's event socket, assigns
  rooms, stores room conversations in `~/.local/state/hyprpi/rooms/<room>.jsonl`
  and remembers agents in `~/.local/state/hyprpi/agents.json` (for restarts,
  later).
- `pi-extension/index.ts` — the agent side (tools, status, delivery).
- `ui/` — Quickshell room windows (`qs -p ~/Work/hyprpi/ui`, one process per
  Hyprland instance, started by `hyprpi room`).
- `bin/hyprpi` — CLI (symlinked into `~/.local/bin`).

## Config — `~/.config/hyprpi/config.json`

```json
{
  "rooms": "world",
  "groups": {},
  "follow": true,
  "cwd": "~/Work",
  "terminal": "foot",
  "pi": "pi",
  "piArgs": []
}
```

- `rooms`: `"world"` (A = ws 1-10, B = 11-20, …), `"workspace"`, or `"single"`.
- `groups`: named rooms that override the mode, e.g. `{"Research": [1, 2, 13]}`.
- `follow`: `true` = an agent moved to another world moves to that room;
  `false` = it stays in the room it was born in.
- `piArgs`: extra `pi` flags for new agents (e.g. `["--model", "…"]`).

## Testing without touching the desktop

Everything was tested in a nested Hyprland on a headless output (see the
hyprcu notes): set `HYPRLAND_INSTANCE_SIGNATURE`/`WAYLAND_DISPLAY` to the
nested instance and `HYPRPI_STATE=/tmp/…` so test rooms stay out of the real
state directory.

## Later

Search panel · restarting agents (crash / after reboot) · master list of all
rooms · pop-up picker version · flagging an agent's window when it needs you.
