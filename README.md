# hyprpi

Pi agents in **their own windows**, anywhere in any workspace of any
[hyprwrld](../hyprwrlds-vimarchy), grouped into **rooms** (one per world by
default). Meant to replace Herdr eventually; for now the two are separate.

| Key | Does |
|---|---|
| SUPER+A | New Pi agent in its own terminal window (Omarchy's default terminal) on the current workspace; it joins that world's room |
| SUPER+ALT+A | Room window for the current world (same as clicking the current world in the bar) |
| SUPER+ALT+/ | Toggle the search window for the current world's room |
| SUPER+SHIFT+A | Claude (moved here from SUPER+A) |

## Room window

A normal window — tile it, float it, move it anywhere; at most one per
workspace. Clicking the current world in the bar (or SUPER+ALT+A):

- this workspace has a room window → close it
- another workspace has this world's room window → take you there
- neither → open one here, placed as the left-most root of the dwindle tree
  (left half, everything else moves right); alone it fills the workspace

Top: the room's agents with status, in the world's colour (● working · ✓ done, unseen ·
○ idle or seen · × blocked), workspace, model and folder. Click an agent to jump to its window;
each `@` click adds `@Name` to the message box (several = send to just those
agents). Below: the room's shared conversation. Typing without `@` posts to the
whole room: every agent in it receives the message plus the room history it
hasn't seen yet, and answers in the room (`room_reply`). `＋ agent` opens a new
agent, ⌕ opens search.

Sounds: when an agent finishes a turn (working → done) the room app plays herdr's
`done` ding (`assets/sounds/done.mp3`, via `paplay`), unless that agent's window
is focused; an agent going `blocked` plays herdr's `request` sound.

## Search window

Its own window (SUPER+ALT+/ or ⌕ in the room widget). Searches every agent's
conversation in the room — live agents and ones that have closed — plus the
room log. **Keyword**: exact phrase, case-insensitive, live as you type.
**✦ AI** (Ctrl+/): describe what you mean and press Enter; a small model
(`searchModel`, default claude-haiku-4-5) reads the recent entries and returns
the ones that match, each with a short reason. Also from the terminal:
`hyprpi find [--ai] QUERY`. What choosing a result does is still open.

## Agents

`hyprpi new` runs `<terminal> … pi -e ~/Work/hyprpi/pi-extension/index.ts` with
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
  "cwdFromFocused": true,
  "terminal": "auto",
  "pi": "pi",
  "piArgs": [],
  "searchModel": "claude-haiku-4-5"
}

- `cwdFromFocused` (default true): SUPER+A / `hyprpi new` starts the agent in the
  focused window's folder: another agent's folder, or the current directory of
  whatever runs in a focused terminal (kitty, foot, alacritty, ghostty, wezterm).
  Other windows (browser etc.) fall back to `cwd`. `hyprpi new --cwd DIR` wins.
```

- `rooms`: `"world"` (A = ws 1-10, B = 11-20, …), `"workspace"`, or `"single"`.
- `groups`: named rooms that override the mode, e.g. `{"Research": [1, 2, 13]}`.
- `follow`: `true` = an agent moved to another world moves to that room;
  `false` = it stays in the room it was born in.
- `terminal`: `"auto"` (default) uses Omarchy's default terminal (`xdg-terminal-exec --print-id`,
  i.e. `~/.config/xdg-terminals.list`), falling back to foot; or force `"kitty"`, `"foot"`,
  `"alacritty"`, `"ghostty"`. Windows always get app-id/class `hyprpi.agent`; kitty windows
  also get `copy_on_select=clipboard`.
- `terminalCommand`: override for any other terminal, an array with `{class}` `{title}` `{cwd}`
  placeholders; the pi command is appended. E.g.
  `["wezterm", "start", "--class", "{class}", "--cwd", "{cwd}", "--"]`.
- `piArgs`: extra `pi` flags for new agents (e.g. `["--model", "…"]`).

## Testing without touching the desktop

Everything was tested in a nested Hyprland on a headless output (see the
hyprcu notes): set `HYPRLAND_INSTANCE_SIGNATURE`/`WAYLAND_DISPLAY` to the
nested instance and `HYPRPI_STATE=/tmp/…` so test rooms stay out of the real
state directory.

## Later

Shift+click (or right-click) a world in the bar to open its room · choosing a search result · restarting agents (crash / after reboot) · master list of all
rooms · pop-up picker version · flagging an agent's window when it needs you.
