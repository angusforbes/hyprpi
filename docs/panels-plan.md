# hyprpi panels: what exists, what we built, how to split it

Written 2026-09-27 (session with Angus). Record first, plan second.
The panel code discussed here is `mockups/room-tui.mjs` (1084 lines) and
`mockups/search-tui.mjs` (281 lines); the Quickshell windows in `ui/` are untouched.

---

## 1. Record: what this session added (commits 8ad1e6c → ea60914)

### 1.1 Resume agents after a restart (`8ad1e6c`)

Problem: after a reboot, agents from the last session were gone from the list even
though their Pi session files existed.

- `lib/daemon.mjs`
  - `remember()` now stores per agent: `connected` (live at save time), `leftAt`
    (when it disconnected), `resumable`, `forgotten`, `parkedFrom`.
  - Heartbeat `~/.local/state/hyprpi/daemon.beat`, written every 10 s and on a clean exit.
  - On start: an agent that was `connected`, or left at most 30 s before the last beat,
    and whose pid is not alive (`pidIsAgent` checks `/proc/<pid>/environ` for
    `HYPRPI_AGENT_ID=<id>`) becomes `resumable`. This is what separates "lost to a
    reboot/crash" from "closed on purpose".
  - `dormantList()`: resumable + recently-closed registry entries, deduped by session
    file (newest `updatedAt` wins), skipping sessions a live agent already has, skipping
    missing session files, skipping ids currently being resumed (30 s window).
  - Methods `agent.resume` (spawns `bin/hyprpi new --id <id> [--twin-of …] -- --session <file>`)
    and `agent.forget` (sets `forgotten`); `list` and the `agents` UI event gained `dormant: [...]`.
  - `agent.hello` clears `resuming`/`forgotten` and un-marks other registry entries with
    the same session file.
  - `quit()` beats, flushes the registry synchronously (the 500 ms debounce could lose it).
- `bin/hyprpi`: `hyprpi new --id ID` reuses a known agent id (that is what keeps the name,
  room and twin link); `--twin-of` was already there.
- Room TUI: dormant agents listed greyed; Enter resumes, `^W^W` forgets.

Effect: a resumed agent keeps its id, so **twins stay twins** (`twin_of` points at the
parent id). Sankey / Sankey[a] were restored this way after the reboot.

### 1.2 Parked and closed agents, `^O` toggle (`335b5da`, `08889e5`, `ea60914`)

- Parking (Reprieve, SUPER+W → `special:reprieve`) takes an agent out of every room
  (`OFFLIMITS`, pre-existing). The daemon now remembers `parkedFrom` (the room it was
  parked from) and exposes `parked_from` in `view()`.
- New method `agent.unpark`: moves the window to the active workspace and focuses it.
- "Closed" = closed/killed while hyprpi kept running, for `closedHours` (config, default 24).
- Room TUI `^O` cycles two views: `live` (live + lost-to-restart) → `+ parked`
  (also parked and closed). Status bar counts both kinds in either view.
- Greyed rows use `midFg` (the stream's grey) and the same columns as a live row:
  `◌ icon name · topic · model · parked|closed [· ⏎ revive | · ⏎ resume · ^W^W forget]`.
- Enter on a greyed row: parked → `agent.unpark` ("revive"); closed → `agent.resume`.
- The TUI re-execs itself when its own code (`room-tui.mjs`, `lib/client.mjs`,
  `lib/paths.mjs`, `lib/search-view.mjs`) changes, unless something is typed or a search
  is running — so an open panel is never stale after an update.

### 1.3 Facts worth keeping

- Registry: `~/.local/state/hyprpi/agents.json`, one entry per agent id, never pruned.
- A Pi session is resumed with `pi --session <file>`; the name comes back from the file.
- Restarting the daemon by hand is racy: any live agent calls `hyprpi ensure` within ~2 s,
  so `hyprpi stop` + edit + start must be done in one go (kill, wait for the pid to be gone,
  write, `hyprpi ensure`).
- Voice targets live in `$XDG_RUNTIME_DIR/voice-agent/target`, one line per target,
  `hp:<agent id>\t<name>` or `room:hp-<ROOM>\t<label>` (see `~/.local/bin/voice-agent`).
  That file is how panel 1 can show who hears dictation.

---

## 2. Where the code stands

`mockups/room-tui.mjs` is one program doing three jobs:

| Part | Lines (approx) | What it is |
|---|---|---|
| terminal basics | 36–135 | theme, colours (`midFg`, `markupFg`, world colours), grapheme widths, `cut`/wrap |
| message box | 137–178 | multi-line input, selection, paste, clipboard |
| agent list | 185–248, 390–430 | `hereAgents`/`listHere`, marks, cursor, `^O` views, row rendering |
| mouse select/copy | 249–374 | drag selection over the whole screen |
| stream | 440–632 | room messages + activity, filters (`^F`), scrolling, `^↑↓` selection |
| search / ask / help | via `lib/search-view.mjs` | shared with `search-tui.mjs` already |
| plumbing | 664–760 | daemon connect, `applyList`, room cycling, new agent, close/kill |
| keys | 884–1060 | one big `onKey` |

`mockups/search-tui.mjs` (SUPER+ALT+/) is the older, smaller search window: it uses
`lib/search-view.mjs` but has none of this session's agent work and none of `/ask`,
`/history`, or the marked-agents scope that room-tui grew.

---

## 3. Plan: three panels

### Panel 1 — agents (SUPER+ALT+A), `mockups/agents-tui.mjs`

The world's agents, nothing else. Small window.

- Live agents (mark, name, topic, model, workspace), plus greyed parked and closed ones;
  `^O` keeps cycling `live` / `+ parked`.
- Enter: live → focus its window; parked → revive; closed → resume. `^W`/`^K` close/kill
  or forget. `^N` new agent. `Tab` switches world.
- Selection (`▸`, Shift+Space / click) stays here and becomes **shared state** (§4), because
  it is what panels 2 and 3 filter by.
- Later: a 🎤 column showing who receives dictation, read from
  `$XDG_RUNTIME_DIR/voice-agent/target` (watch the file, no new daemon work), and
  eventually a key to retarget dictation to the selected agent(s).
- **View + selector only** (decided): no message box, no stream, no prompting. Later it gains
  commands that act on the selection — route dictation to the selected agents, form a
  "taskforce" — but not in this round.

### Panel 2 — room / stream (**SUPER+ALT+R**, agreed), `mockups/room-tui.mjs`

Keeps the name and most of today's code, minus the agent list.

- Stream (messages + activity), `^F` filters, `/history`, scrolling, drag-copy.
- The message box: posts to the room, or to the selected agents, `@Name` routing.
- **No search pane** (decided): search lives in panel 3. Instead a command line for a live
  text filter over the stream (today's `/stream WORDS`) plus the `^F` view toggles.
- A one-line header instead of the agent pane: room, world colour, who is selected
  ("only ▸ Sankey, Lippy"), counts.

### Panel 3 — search (SUPER+ALT+/), `mockups/search-tui.mjs`

Bring this session's search work back into the standalone window: `/ask`, keyword ⇄ AI
(`^S`), `/history N`, results selection and Enter-to-jump, and the marked-agents scope
from shared selection. Then room-tui drops its search pane (or keeps it as a shortcut
that opens panel 3 — open question Q3).

### Shared modules (new `lib/tui/`)

Extracted from room-tui.mjs, imported by all three panels:

| Module | Contents |
|---|---|
| `term.mjs` | theme, colours, widths, `cut`/`wrap`, alt-screen setup, `quit()` |
| `selectcopy.mjs` | mouse drag selection + clipboard |
| `inputbox.mjs` | the multi-line message box |
| `agentlist.mjs` | agent/dormant/parked model + row rendering + `^O` views (panels 1 and 2's header) |
| `stream.mjs` | stream row building and filters |
| `conn.mjs` | connect, `applyList`, activity cache, self-restart-on-code-change |

Goal: no behaviour change, three thin programs (~150–250 lines each) over shared modules.

### §4 Shared selection (daemon)

Selection must survive panel boundaries, and dictation retargeting will want it too.

- Daemon: `selection` per room (`Set<agentId>` + "all" default), methods
  `selection.get` / `selection.set` / `selection.toggle`, broadcast as a `selection` UI event.
  Cleared when an agent leaves the room; persisted in the registry? (probably not: session-scoped).
- Panels 1–3 render from it; only panel 1 writes it (panel 2 may clear with Esc).

### Order of work

1. Extract `lib/tui/` from room-tui.mjs with no functional change (verify by running the
   current panel before/after on the same data).
2. Add daemon selection state + event.
3. Write panel 1 (`agents-tui.mjs`), bind SUPER+ALT+A to it; keep room-tui on SUPER+ALT+A
   until panel 1 is good, then move room-tui to its own key.
4. Slim room-tui to panel 2.
5. Fold search-view improvements into `search-tui.mjs` (panel 3).
6. Dictation column in panel 1.

### Keeping a copy

`git tag panels-combined ea60914` (or a branch) so the single combined panel is always
recoverable, plus this document. No file copies needed — the whole thing is in git.

---

## 4. Open questions for Angus

1. ~~Key for panel 2~~ **SUPER+ALT+R** (agreed 2026-09-27; SUPER+ALT+S is Reprieve stash).
2. ~~Panel 1 prompting~~ **view + selector only** (agreed 2026-09-27).
3. ~~Panel 2 search pane~~ **no**; panel 2 gets a filter command line instead (agreed).
4. **One window or many**: should opening panel 1 while it is already open focus it (like now),
   and should panels 1 and 2 open side by side automatically the first time?
5. **Selection scope**: per room (my assumption), or one global selection?
