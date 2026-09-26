# hyprpi

Pi agents in **their own windows**, anywhere in any workspace of any
[hyprwrld](../hyprwrlds-vimarchy), grouped into **rooms** (one per world by
default). Meant to replace Herdr eventually; for now the two are separate.

| Key | Does |
|---|---|
| SUPER+A | New Pi agent in its own terminal window (Omarchy's default terminal) on the current workspace; it joins that world's room |
| SUPER+ALT+A | Room window for the current world (same as clicking the current world in the bar) |
| SUPER+ALT+/ | Toggle the search window for the current world's room |
| SUPER+SHIFT+A | Claude (moved here from SUPER+A; a personal binding in `~/.config/hypr/bindings.lua`, not part of hyprpi) |

These keys, the rule that tags agent windows as terminals (so Omarchy's SUPER+C/V copy and
paste instead of sending Ctrl+C, which Pi treats as clear/interrupt) and the click-to-mark-seen
handler are in `hypr/hyprpi.lua`. Install it once:

`ln -s ~/Work/hyprpi/hypr/hyprpi.lua ~/.config/hypr/hyprpi.lua`

then add `require("hypr.hyprpi")` to `~/.config/hypr/hyprland.lua` after
`require("hypr.bindings")`. It finds `bin/hyprpi` under `~/Work/hyprpi` (or `$HYPRPI_HOME`).

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
- `hypr/hyprpi.lua` — Hyprland keys, the agent window rule and click-to-mark-seen
  (symlinked into `~/.config/hypr/`).
- `terminal-helpers/kitty/` — kitty settings for agent windows (`pi.conf`: Ctrl+click links
  and files, SUPER+C / Ctrl+Shift+A / Shift+Enter for Pi, select-to-copy), loaded after your own
  `kitty.conf`; `links.conf` can also be included by every kitty window. See its README.

## Activity stream

The room TUI shows each room as a **stream**: its messages plus what its agents are doing.
Ctrl+F cycles the view: **room · all activity** (room messages and agent-to-agent messages) ·
**stream · all activity** (all activity, no room messages) · **room + stream** (everything) ·
**room + stream · topics only** (room messages and topic changes; the default). Finishes and "needs you" are
logged but not shown: the agent list's ✓ and × show them. Activity is a history for you (and tools
like dashboards); it is never part of any agent's context.

Files (append-only JSONL, one object per line, under `~/.local/state/hyprpi/`, or `$HYPRPI_STATE`):

- `rooms/<room>.jsonl` — messages: `{ seq, ts, room, author: { kind: "human"|"agent", id?, name, icon?, color?, markup? }, text, reply_to? }`
- `activity/<room>.jsonl` — activity, schema version 1:

```json
{ "v": 1, "ts": 1790000000000, "room": "C", "kind": "tool", "text": "editing lib/daemon.mjs",
  "agent": { "id": "hp-…", "name": "Quartermaster", "icon": "🗃️", "color": "#e0af68", "markup": "" },
  "to": ["Sankey"] }
```

| `kind` | `text` | Source |
|---|---|---|
| `tool` | one line per tool call, batched ("reading a.ts, b.ts +3", "$ git push", "web search: …") | the agent's Pi extension |
| `topic` | the new topic label | topic labelling (on the ding) |
| `done` / `blocked` | "finished" / "needs you" | status changes |
| `talk` / `demand` | "to Name: gist" / "asks Name: gist" (`to`: recipients) | `talk` / `demand` between agents |
| `reply` | "replies to Name: gist" (`to`: the asker) | `talk_reply` |
| `prompt` | "Angus → Name: gist" | a direct prompt from the room TUI / `hyprpi send` |
| `joined` / `left` | "joined · ~/Work" (twins: "· twin of Name") / "left" | agent connects for the first time / is gone |
| `renamed` | "pi·w96n is now 🗃️ Quartermaster" | a name or icon change |
| `moved` | "moved to workspace C3", "moved to room A (A2)" (logged in both rooms), "went to Reprieve", "back from Reprieve, to C1" | window moves |
| `model` | "switched model to claude-opus-5-5" | model change |
| `aborted` / `error` | "stopped (Esc)" / "error: …" | how a turn ended (the agent's Pi extension) |

`ts` is milliseconds since the epoch; texts are cut to 200 characters. New kinds may be added;
readers should ignore kinds they don't know. The daemon method `activity.read { room, limit }`
returns the recent tail; UI connections also get each new event live as `activity`.
Config: `"activity": false` turns the stream off; `"activityTools": false` keeps it but drops tool lines.

## Config — `~/.config/hyprpi/config.json`

```json
{
  "rooms": "world",
  "groups": {},
  "follow": true,
  "cwd": "~/Work",
  "cwdFromFocused": true,
  "terminal": "auto",
  "terminalHelpers": true,
  "pi": "pi",
  "piArgs": [],
  "searchModel": "claude-haiku-4-5"
}

- `offLimitsWorkspaces` (default `["special:reprieve"]`): an agent whose window is
  on one of these workspaces (Reprieve) leaves its room: not in any room panel, no
  room messages, can't post to a room. Moving it out puts it back in its world's room.
- `cwdFromFocused` (default true): SUPER+A / `hyprpi new` starts the agent in the
  focused window's folder: another agent's folder, or the current directory of
  whatever runs in a focused terminal (kitty, foot, alacritty, ghostty, wezterm).
  Other windows (browser etc.) fall back to `cwd`. `hyprpi new --cwd DIR` wins.
```

- `rooms`: `"world"` (A = ws 1-10, B = 11-20, …), `"workspace"`, or `"single"`.
- `groups`: named rooms that override the mode, e.g. `{"Research": [1, 2, 13]}`.
- `follow`: `true` = an agent moved to another world moves to that room;
  `false` = it stays in the room it was born in.
- `terminalHelpers` (default true): agent windows also load `terminal-helpers/<terminal>/`
  settings (kitty only for now: `pi.conf`, after your own `kitty.conf`).
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
