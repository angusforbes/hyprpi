# hyprpi

Pi agents in **their own windows**, anywhere in any workspace of any
[hyprwrld](../hyprwrlds-vimarchy), grouped into **rooms** (one per world by
default). Meant to replace Herdr eventually; for now the two are separate.

| Key | Does |
|---|---|
| SUPER+A | New Pi agent in its own terminal window (Omarchy's default terminal) on the current workspace; it joins that world's room |
| SUPER+ALT+A | Agents panel for the current world, brought here (`mockups/panels --only 1`) |
| click the current world in the bar | Agents panel for the current world: jump to it wherever it is, or open it here in the top-left slot (`hyprpi room --toggle` → `mockups/agents-here`) |
| SUPER+ALT+/ | Toggle the search window for the current world's room |
| SUPER+SHIFT+A | Claude (moved here from SUPER+A; a personal binding in `~/.config/hypr/bindings.lua`, not part of hyprpi) |

These keys, the rule that tags agent windows as terminals (so Omarchy's SUPER+C/V copy and
paste instead of sending Ctrl+C, which Pi treats as clear/interrupt) and the click-to-mark-seen
handler are in `hypr/hyprpi.lua`. Install it once:

`ln -s ~/Work/hyprpi/hypr/hyprpi.lua ~/.config/hypr/hyprpi.lua`

then add `require("hypr.hyprpi")` to `~/.config/hypr/hyprland.lua` after
`require("hypr.bindings")`. It finds `bin/hyprpi` under `~/Work/hyprpi` (or `$HYPRPI_HOME`).

## Room window (retired)

**Retired 2026-09-28 (Angus): kept in `ui/`, no longer developed.** The bar click that used to
toggle it now opens the agents panel (see the table above). It can still be opened explicitly
with `hyprpi room ROOM`. What follows describes it as it was.

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
**✦ AI** (Ctrl+/ here; Ctrl+S in the room TUI): describe what you mean and press Enter; a small model
(`searchModel`, default claude-haiku-4-5) reads the recent entries and returns
the ones that match, each with a short reason. `@Names` in the box limit it to those agents'
history (`@Lippy kafka`; Tab completes). Also from the terminal:
`hyprpi find [--ai] QUERY`. What choosing a result does is still open.

### Room TUI keys: three parts, one modifier each

| Part | Keys |
|---|---|
| **Top: agent list** (Shift) | Shift+↑↓ cursor · Enter on an empty box (right after using the list) jumps to the agent (the ▸ marks are retired) |
| **Middle: stream / search / ask** (Ctrl) | Ctrl+↑↓ select the previous / next stream item (highlighted like a search result; past the newest = follow new items again) or search result · PgUp PgDn a page · Ctrl+Home oldest item / Ctrl+End back to the newest · Esc clears the selection · Ctrl+/ next view (stream → search → ask) · Ctrl+S keyword ⇄ AI · Ctrl+F stream view |
| **Bottom: message box** (plain keys) | multi-line: ↑↓ between lines, Shift+Enter new line, Home/End line start / end · Shift+←→, Ctrl+Shift+←→, Shift+Home/End select · typing replaces the selection · Ctrl+C copy (no selection: clear the box) · Ctrl+X cut · Ctrl+V or SUPER+V paste (line breaks kept) · SUPER+C copy · Enter send |
| **Other** | Tab / Shift+Tab room · Ctrl+N new agent · Ctrl+W close / Ctrl+K kill (press twice) · Ctrl+Q quit (Ctrl+C never quits) |

The launcher (`mockups/room-tui`) maps Shift+Space and Shift+Enter to CSI-u and Ctrl+Insert to
`copy_or_noop` for its kitty window, so those keys reach the TUI.

### Search inside the terminal room (`mockups/room-tui.mjs`)

The room TUI's input line takes slash commands (`lib/search-view.mjs`; typing
`/` shows the matches, Tab completes and steps through them, `/help` lists them):

| command | what the pane below the agent list shows |
|---|---|
| `/room` | the stream, filter `room · all activity` |
| `/stream [WORDS]` | the stream; with WORDS only rows containing all of them (live, heading shows `filter: …`); alone clears the filter |
| `/search [WORDS]` | keyword search of the room (agents' conversations + room log), one line per hit |
| `/ai DESCRIPTION` | the same, by meaning (`searchModel`) |
| `/ask QUESTION` | a one-shot 2–3 sentence answer with its cited lines (daemon `ask`) |
| `/new [DIR]`, `/help` | new agent · the command list |

In search view the input is the search box: Enter searches and **never posts**
(the prompt reads `⌕ C ❯`, or `✦ C ❯` in AI mode); Enter again on the same words
(or on an empty line, or a double click) jumps to the selected hit's agent.
Ctrl+↑↓ / PgUp PgDn / wheel select, Ctrl+S switches keyword ⇄ AI, Ctrl+/ moves to
the next view (stream → search → ask), Esc goes back. The query and results are kept, so
coming back to search returns to them; Tab (room switch) clears them. `//text` posts `/text` to the room; an
unknown `/word` is refused with a hint instead of being posted.

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

### Restore-all: everything that was open comes back (J8)

The daemon keeps a live map of what is open: agents in the registry (`agents.json`, field
`open`), panels in `~/.local/state/hyprpi/panels.json` (kind, world, workspace, tiled or floating,
geometry). Both are written atomically (tmp + rename) with the previous version kept as `.bak`, and
the panels map is never replaced by an empty one except by a deliberate close.

**The one rule** (Angus, 2026-10-01): something that goes away *on its own* was closed on purpose
(a window closed by hand, `/quit`, `/handoff`, ^W / ^K) and is dropped from the map after 6 s.
Something that goes away *together* with others (3+ hyprpi windows within 3 s: a logout, Hyprland
going down), while the daemon is shutting down, or in a power cut, stays. `hyprpi stop`, SIGTERM
and SIGHUP save the map and then freeze it, so the windows a shutdown closes don't count; a
removal within 5 s of the daemon's last beat is undone at the next start. A pi that crashes alone
counts as closed (it is still in the room panel's closed list).

**Restoring.** When a fresh daemon finds open agents or panels that aren't live, the first
deliberate entry point (SUPER+A / `hyprpi new`, the panel keys SUPER+ALT+A / R / P / slash, the
panels' `/agents`-style commands) shows one menu, once per daemon start: *Restore all* · *Restore
world X only* · *Not now* · *No* (let them go). `hyprpi restore [all|X]` does the same any time
(`--list` only shows it, `--no` lets it go). Each agent comes back with its own id (name, icon,
twins), on **its own workspace** (a parked one parked), on the **model and thinking level** of its
session's last `model_change` (not the config's `--model`), all at once (twins in a second wave, after their
originals), with one notification counting up and a "hyprpi restore complete" one that stays until dismissed, opened with Hyprland's `exec_cmd … 'N silent'` so your focus never moves
(`hyprpi new --silent`). Panels come last, the same way. Missing session files are listed and let
go. One `♻️ restored …` line goes to the current world's room. Agents still running (a plain daemon
restart) are skipped. Nothing is restored automatically at login.

### Resuming agents after a restart (and parked / closed agents)

The room TUI's **Ctrl+O** cycles which greyed (`◌`) agents are listed under the live ones:
`live` (default: live + agents lost to a reboot/crash) → `+ parked` (also parked windows and
agents closed or killed while hyprpi ran, for the last `closedHours`, default 24). The status
bar counts both kinds either way (`1 parked · 2 closed`). Greyed rows use the stream's grey and
the same columns as a live row (`◌ name · topic · model`). Enter: a closed agent is resumed
(same id); a **parked** one (Reprieve, SUPER+W: still running, out of rooms) is moved back to
the current workspace (daemon `agent.unpark`). A parked agent is listed in the room it was
parked from. An open room TUI re-execs itself when its own code changes, so panels are never
stale.

Agents that were still open when hyprpi went down (reboot, logout, crash) come
back as **closed** entries in their world's room TUI (SUPER+ALT+A): greyed
`◌ name · topic · closed` under the live agents. Select one (↑↓ or click) and
press Enter to reopen its Pi session in a new window, with the same agent id,
so its name, icon, room and twin link survive (a twin's `twin_of` still points
at its parent's id). ^W twice forgets it (the session file stays). Windows are
never reopened automatically.

How the daemon tells "lost to a restart" from "closed on purpose": it writes
`daemon.beat` every 10 s (and on exit) and records `connected` / `leftAt` per
agent in `agents.json`. On start, an agent that was still connected, or left
at most 30 s before the last beat, and whose process is gone becomes
`resumable`. A window you close while hyprpi keeps running is not. Only the
newest entry per session file is listed, and none whose session is open.
Daemon methods: `agent.resume {agent}`, `agent.forget {agent}`; `list` and
the `agents` UI event carry `dormant: [...]`. `hyprpi new --id ID --twin-of ID
-- --session FILE` is what a resume runs.

## Panel commands (all four panels)

The agents, room, search and board panels share one command line (`lib/tui/command-line.mjs`):
the same parsing (a unique prefix runs a command; `//text` is not a command), Tab completion, the
hint while typing and `/help`. Every panel has:

| Command | Does |
|---|---|
| `/agents` `/room` `/search` `/board` | go to that panel for this world: jump to it wherever it is, or open it here (`mockups/panel-here`) |
| `/search WORDS` · `/ai QUESTION` (`/ask`) | the search panel runs it (from any panel; the search panel's own run it in place) |
| `/world X` | switch this panel to world X (^Tab steps through them) |
| `/go @Name` | jump to that agent's window (Tab completes the name; the same as Ctrl+click) |
| `/new [DIR]` | a new agent (on the board, a new project is `/project @name`) |
| `/tinker [W:] TEXT` · `/help` · `/quit` | drop a fix off in the workshop · this panel's commands and keys · close the panel |

Panel-specific: room `/messages` (was `/room`) `/stream` `/history`; search `/search /ai /ask`
(in place); board `/project /todo /note /done /drop /assign …` (see `/help` in each).

## Add-ons

Optional parts, each switched in `~/.config/hyprpi/config.json`. Hyprland picks up a change at its
next reload (`hyprctl reload`).

### Finder (on by default)

**SUPER+SHIFT+SPACE** opens the Omarchy menu (the same one as the apps menu on SUPER+ALT+SPACE)
listing every world's live and parked agents, then its open projects, each with where it is:
`Sankey · C3`, `@hyprpi · C1` (a project sits where its writer is, else where its world's projects
panel is). Type to filter, ↑↓, Enter, Esc. Enter on an agent jumps to its window (a parked one is
brought back here); on a project it opens its card in the projects panel. The key again closes it.
Also `hyprpi finder` (or `mockups/finder --list` to print the rows).

It takes Omarchy's "Toggle top bar" key, so the bar toggle moves to **SUPER+ALT+B**.

- `"finder": false`: off; SUPER+SHIFT+SPACE toggles the top bar again, as in stock Omarchy.
- `"finderDetail": true`: a grey line under each row (status and topic; members and where it
  stands), at the cost of fewer rows on screen (the menu caps itself at 70% of the screen).

## Tinker (the workshop world)

Worlds are projects. Friction work (a panel, a key, the bar: anything that slows your
thinking) has its own world, the **workshop**. Say which world once, in the drop-off
itself: `/tinker D: what to fix`. The daemon remembers it (`~/.local/state/hyprpi/workshop.json`,
which wins over an optional `"workshop"` config key) and announces "the workshop is world D
now" in your room and in D's room. After that plain `/tinker what to fix` goes there; another
letter (`/tinker B: …`) moves it. When something bugs you mid-project, drop it off and
keep going:

- `/tinker what to fix` in any agent window (a Pi command from the hyprpi extension)
- `/tinker what to fix` in the room panel
- `hyprpi tinker what to fix` in a terminal

The daemon gives each drop-off to **one** free (idle or done) agent in the workshop's
room, never the whole room, so two agents don't fix the same thing. If none is free,
it waits in a queue (`~/.local/state/hyprpi/tinker-queue.json`) and a new agent opens
on the workshop world's first workspace without taking focus; the queue drains as
agents there become free. The agent is told where it came from (agent, room, folder),
to fix and verify it without asking you, and to `room_post` "🔧 done: …" (or
"🔧 decide: …" / "🔧 stuck: …") in the workshop room. Each hand-off is logged there as "🔧 → Name: …".

Decisions: the agent makes small, reversible ones itself and lists them in its result under
"Decided for you:" with how to undo each. Ones that are hard to undo or are yours (publishing or
pushing anywhere public, sending to other people, deleting or rewriting your data, changing how you
work, choosing between designs you'd see) it does not make: it does everything else and posts
"🔧 decide: question, options, recommendation", then stops. A thought rather than a fix (how to
organise something) gets a proposal written to `~/Obsidian/Tinker/<date> <title>.md` (so it isn't
lost in the room scroll), only the uncontroversial part built, and a "🔧 plan: … (link)" post.
Every "🔧 done / plan / decide / stuck" post is **copied to the room the drop-off came from** (as
"(workshop D #seq) …"), so results and questions reach you where you are working. **decide dings
you, plan and stuck bonk you** (the daemon does it, not the agent: the sound, a toast naming the agent, and
× on the agent until it works again), so nothing that needs you sits unseen. Answer by talking to
that agent (or with another /tinker).

### The three agent sounds

Angus's names (2026-09-28), kept clearly distinct:

- **ding**: a decision is needed from you, right away. `ding TEXT` (= `bonk --ding`) plays
  `~/.local/share/sounds/ding.wav` (a symlink to one of three candidates; see
  `~/Work/agent-config/helpers/make-ding-sounds.py`), and the toast says "Agent X needs a decision
  from you" 🔔. Daemon hook (for the board's Decide section): `dingFor(agent, text, { itemId })` when
  an item is added, `clearDing(agent, itemId)` when you resolve it. The × clears when the agent's
  last open decision is resolved, unless a plain bonk is also pending. Tinker "🔧 decide:" uses it.
- **bonk**: you asked to be told, or an agent thinks it's urgent. `bonk TEXT`, two knocks and
  "Agent X needs you" 👉. Daemon: `bonkFor(agent, text)`. Tinker "🔧 plan:" / "🔧 stuck:" use it.
- **chime**: an agent went from working to done. The daemon plays herdr's `assets/sounds/done.mp3`
  itself (`paplay`), whatever panels are open. Every finish chimes, even several at once.
  Config: `"chime": false` turns it off; `"chimeGapSec": N` limits it to one per N seconds.

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
- `docker/` — Pi agents in a Docker container that are still full hyprpi agents (room, board, window,
  `(🐳 docker)` in the agents panel): images and `run-hyprpi-agent.sh`. See its README; plans and the
  security design in `docs/sandbox-plan.md`.
- `terminal-helpers/kitty/` — kitty settings for agent windows (`pi.conf`: Ctrl+click links
  and files, SUPER+C / Ctrl+Shift+A / Shift+Enter for Pi, select-to-copy), loaded after your own
  `kitty.conf`; `links.conf` can also be included by every kitty window. See its README.

## The Stream (panel 2, SUPER+ALT+R)

The room panel is now **the Stream** (Angus 2026-09-30, @hyprpi N40; `lib/stream.mjs`): one
read-only timeline of the world. Header `— stream C`, status bar `hyprpi stream`. (Internal names
stay: the file is `mockups/room-tui.mjs` and the window title `hyprpi-room C`, because the launchers
and the daemon find the window by it.)

- **What it shows**, oldest first: agents' posts, per-turn **did** lines, topic changes, agent
  events (joined, moved, …), agent-to-agent talk and Angus's prompts, **board changes** (📋 @project
  · who op handle: text; "update where / next step" bookkeeping is left out), project moves,
  Thoughts' 💭 lines. **Dedupe:** an agent that posted during a turn doesn't also get that turn's
  did line (the post says it). Each line shows its **project** when known: its own tag, else the one
  @project its text names, else the agent's only project. `● Name working…` stays at the bottom.
- **Ctrl+F** cycles the views (the header says which): **full** text → **compact** (one line each:
  time · who · @project · text) → **topics** (topic changes only, drawn as before the Stream: the
  agent's name on its own line, its consecutive topics under it, a blank line before the next
  agent; no times). The `/stream` filters apply in every view.
- **Filters**, all combinable, typed as `/stream …`: `@Blink @Sankey @hyprpi` (a union of agents and
  projects; a project = lines tagged with it or naming it, its board changes, and its members'
  untagged lines) · `3h` `90m` `2d` `today` `yesterday` `since 9am` `since 14:30` (a time window
  loads history from then) · other words narrow (every word) · `raw` adds the tool lines. The
  header shows the filter; `/stream` alone or **Esc** clears it. e.g. `/stream @hyprpi 3h commit`.
- **The box** still sends (Angus): plain text is a room post (every agent in the room gets it),
  `@Name text` goes just to them, `@project text` to the project (its owner answers).
- **`/digest [filter]`** (Thoughts window, or from any panel): the matching Stream lines go to
  Thoughts as evidence (the newest 30 shown, up to 400 to the model) and it writes a summary by
  project: done, decided, waiting on Angus. Follow-ups work. Alone: since Angus last looked at that
  Thoughts window (it reports focus-out; `STATE/thoughts/looked.json`), else the last 12 h; with a
  filter but no time window, the same default.

The ▸ marks (a shared per-room selection of agents) are **retired** (Angus, 2026-09-30, @hyprpi D4).

## Activity stream

The room TUI shows each room as a **stream**: its messages plus what its agents **did**. When an
agent finishes a turn, the daemon's small model (the topic model, claude-haiku-4-5) writes one
**"did" line** (kind `turn`) from that turn's tool calls and final message, e.g. "made the room
header one line; tested in a hidden pty; committed 161186f" (lib/topics.mjs `turnInput` /
`summarizeTurn`; config `"turnLines": false` turns them off). Agents mid-turn show as a dim
"● Name working…" line at the bottom. Ctrl+F cycles the view: **room + stream** (the default:
room messages, did lines, topics, agent-to-agent messages, joins and moves) · **room** (room and
agent-to-agent messages) · **stream** (the same without room messages) · **topics** (topic changes
only). **Raw tool lines** ("$ …", "reading a.ts") are in no view (Angus, 2026-09-30); `/stream raw`
shows them (again: back). Finishes and "needs you" are logged but not shown: the agent list's ✓ and × show them. Activity is a history for you (and tools
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
| `turn` | the "did" line: what the agent did in its last turn and how it ended | turn summary (on the ding) |
| `done` / `blocked` | "finished" / "needs you" | status changes |
| `talk` / `demand` | "to Name: gist" / "asks Name: gist" (`to`: recipients) | `talk` / `demand` between agents |
| `reply` | "replies to Name: gist" (`to`: the asker) | `talk_reply` |
| `prompt` | "Angus → Name: gist" | a direct prompt from the room TUI / `hyprpi send` |
| `joined` / `left` | "joined · ~/Work" (twins: "· twin of Name") / "left" | agent connects for the first time / is gone |
| `renamed` | "pi·w96n is now 🗃️ Quartermaster" | a name or icon change |
| `moved` | "moved to workspace C3", "moved to room A (A2)" (logged in both rooms), "went to Reprieve", "back from Reprieve, to C1" | window moves |
| `model` | "switched model to claude-opus-5-5" | model change |
| `aborted` / `error` | "stopped (Esc)" / "error: …" | how a turn ended (the agent's Pi extension) |

`ts` is milliseconds since the epoch. Texts of messages (`talk`, `demand`, `reply`, `prompt`) are kept whole (up to 4000 characters, line breaks kept); all other texts are one line cut to 200 characters. New kinds may be added;
readers should ignore kinds they don't know. The daemon method `activity.read { room, limit }`
returns the recent tail; UI connections also get each new event live as `activity`.
Config: `"activity": false` turns the stream off; `"activityTools": false` keeps it but drops tool lines.

## Ask (one-shot)

The daemon method `ask { room, question }` answers a question about a room in up to three
sentences, with citations: `{ answer, citations: [{ kind: "msg"|"agent"|"activity", who, ts, text }], model }`.
It picks entries from the room's agents' conversations, the room log and the activity stream
(entries sharing words with the question first, Angus's own words ranked higher, then recent ones),
and makes one small-model call (`askModel`, else `searchModel`, default `claude-haiku-4-5`) with no
tools and no memory: about 3 s. The room TUI's `/ask` uses it. For real questions, ask a Pi agent.

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
  "searchModel": "claude-haiku-4-5",
  "aiSearchChars": 110000,
  "aiSearchActivityShare": 0.2
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
- **AI search** (search panel, AI mode: a short answer + the evidence it used). One
  `searchModel` call reads a slice of the room's history: conversations (what was
  *said*) and the activity stream (what was *done*: tool calls, topics, joins/moves).
  Both keys are read on every search, so changes apply without a restart.
  - `aiSearchChars` (default 110000, ~28k tokens): how much text the model reads per
    search. More = wider coverage, slower and costlier.
  - `aiSearchActivityShare` (default 0.2): the **cap** on the activity stream's part of
    that budget, 0..1. Activity lines are many and short (every `ls`, read and edit), so
    uncapped they would crowd out the conversations, where reasons and decisions are;
    but without them "who changed bindings.lua?" can't be answered. 0.2 = 22000
    characters, about 150 activity lines (each trimmed to ~140), roughly a busy hour of
    tool calls in a room, leaving 80% for conversation. Lines sharing words with the
    query go in first, then the newest. A cap, not a reservation: unused activity budget
    goes to conversations. `0` leaves activity out; `1` removes the cap.

## Testing without touching the desktop

Everything was tested in a nested Hyprland on a headless output (see the
hyprcu notes): set `HYPRLAND_INSTANCE_SIGNATURE`/`WAYLAND_DISPLAY` to the
nested instance and `HYPRPI_STATE=/tmp/…` so test rooms stay out of the real
state directory.

## Later

Shift+click (or right-click) a world in the bar to open its room · choosing a search result · restarting agents (crash / after reboot) · master list of all
rooms · pop-up picker version · flagging an agent's window when it needs you.
