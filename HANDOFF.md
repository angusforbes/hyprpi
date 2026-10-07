# hyprpi — handoff (👻 Ghost, 2026-09-25)

Repo: https://github.com/angusforbes/hyprpi (public) · code: `~/Work/hyprpi` · user docs: `README.md`.
Goal (Angus): replace Herdr's "all agents in one app" with Pi agents in **their own windows**,
anywhere in any workspace of any hyprwrld, grouped into **rooms** (default one per world).
Herdr and hyprpi run side by side for now; hyprpi is meant to replace Herdr eventually.

## The panels pair: Blink (lead) + pi·wpzt (Angus, 2026-09-30, @hyprpi N44)

- **Roles.** 👁️ Blink leads the panels: it owns the panel files (`mockups/*-tui.mjs`, `lib/tui/`,
  `lib/stream.mjs`) and the daemon side, splits the work, and has the last word on design. pi·wpzt is
  co-developer and the independent tester.
- **Card first.** Every panel task goes on the @hyprpi card FIRST, with its owner's name ("Blink" or
  "pi·wpzt"), whether it comes from Thoughts, from Angus in either window, or from the board. Check
  the card before starting anything; if it's already there with the other's name, hand it over
  instead of building it twice (say so to Angus).
- **Whoever didn't build a change tests it** (hidden pty / spare workspace), then says so on the card.
- **Acknowledge every message** between the two (a one-line talk_reply is enough), so a lost or late
  one shows up at once.
- **Safety, both:** file swaps keep the mode (`git show --summary HEAD | grep mode`; mockups/panels is
  755), the daemon is restarted only when nobody is mid-turn, and only your own files are committed.
- **Push after each verified change** (J211, Angus 2026-10-07: "yes push after each verified change"; all
  agents, all worlds, this repo and Angus's other repos agents work on). Once a change is verified (an
  independent tester passed it, or Thoughts recorded it verified), the agent that committed it pushes the
  branch to origin right away. Safety: only your own commits, from a tree where nobody else's work is
  committed by you; scan the diff since origin for personal data first (`git diff @{u}..HEAD`); author
  angus.forbes@gmail.com; fast-forward only: no force-push, no history rewrite. If the push is rejected,
  `git pull --rebase` only when that's trivial (no conflicts), else stop and report. One pusher at a time:
  if another agent is pushing the same repo, wait for it.

## Current state (all committed and pushed)

- **Daemon** `lib/daemon.mjs` — one per Hyprland instance, socket
  `$XDG_RUNTIME_DIR/hyprpi/<sha1(HIS)[:12]>.sock`, log next to it (`.log`). Started on demand
  by any `hyprpi` command. **The CLI restarts the daemon automatically when any `lib/*` file is
  newer than the daemon's start time** (`ping.started`). Agents reconnect by themselves.
  State: `~/.local/state/hyprpi/{agents.json,rooms/<room>.jsonl}` (override with `HYPRPI_STATE`).
- **Pi extension** `pi-extension/index.ts` — loaded only via `pi -e` by `hyprpi new`, which sets
  `HYPRPI_AGENT_ID`. Tools: `room_read/room_post/room_reply/talk/demand/talk_reply`. Status
  (working/done) from agent_start/agent_settled. Room questions arrive as `hyprpi-room` custom
  messages with the unseen room history.
- **UI** `ui/` — one Quickshell process per Hyprland instance (`qs -p ~/Work/hyprpi/ui`, gets
  `HYPRPI_SOCKET` from the CLI). `RoomWindow.qml` = room window (normal toplevel, at most one per
  workspace), `SearchWindow.qml` = search window. The daemon decides open/close/focus; the UI only
  creates windows.
- **Keys** (`~/.config/hypr/bindings.lua`): SUPER+A new agent · SUPER+ALT+A room window ·
  SUPER+ALT+/ search · SUPER+SHIFT+A Claude (moved from SUPER+A; Omarchy's ChatGPT unbound).
- **Bar**: clicking the *current* world letter in the hyprwrlds bar widget runs
  `hyprpi room --toggle` (hyprwrlds commit 9aa5822, pushed; now `hyprwrlds/` in this repo).
- **Integrations outside this repo** (backups in `~/.local/state/hyprpi/backups/`):
  - `~/.pi/agent/extensions/herdr-room/index.ts`, `peer-chat/index.ts`: `return` early when
    `HYPRPI_AGENT_ID` is set (Pi refuses to start on duplicate tool names).
  - `~/.pi/agent/extensions/name-sync.ts`: `/name` / `rename_self` call `hyprpi name` inside hyprpi.
  - `~/Work/pi-twin/src/herdr.mjs`: `createHyprpi` host adapter (twin = new window beside the
    original, same room). **Uncommitted** in pi-twin.
  - `~/.local/bin/voice-agent`, `voice-agent-target` (copied into `~/Work/herdr-voice-to-agents`,
    **uncommitted**): hyprpi targets `hp:<agent>` and rooms `room:hp-<room>`.
  - `~/.local/bin/bonk`: toast title "Agent <Name> needs you", hyprpi-aware.
  - `~/.pi/agent/AGENTS.md`: "hyprpi agents" and "bonk" sections.

## Room window behaviour (decided with Angus)

World click / SUPER+ALT+A: this workspace has a room window → close it; another workspace has
this world's → go there; neither → open one and make it the **left-most dwindle root**
(`movetoroot`, then `togglesplit` if it came out as a top/bottom half, then `swapsplit` if it's on
the right). Alone on a workspace it fills it (Angus chose that over max-width workarounds).
The pointer is saved before and restored after (focus dispatches warp it).

## How to test without touching Angus's desktop

Nested Hyprland (recreate after reboot):
1. `printf '%s\n' 'hl.monitor({ output = "", mode = "1600x1000", position = "auto", scale = 1 })' > /tmp/hyprcu-nested/hyprland.lua`
2. `hyprctl dispatch 'hl.dsp.exec_cmd("[workspace 9 silent] Hyprland -c /tmp/hyprcu-nested/hyprland.lua")'`
3. Find the new instance in `$XDG_RUNTIME_DIR/hypr/`, write `/tmp/hyprcu-nested/env.sh` with
   `HYPRLAND_INSTANCE_SIGNATURE` and `WAYLAND_DISPLAY=wayland-2`.
4. `. /tmp/hyprcu-nested/env.sh; hyprctl output create headless TEST; hyprctl eval 'hl.monitor({ output = "WAYLAND-1", disabled = true })'`
5. Also `hyprctl eval 'hl.config({ dwindle = { preserve_split = true } })'` (Omarchy has it on).
Then with `export HYPRPI_STATE=/tmp/hp-nested-state`: `hyprpi new`, `hyprpi room --toggle`,
`hyprpi post "…"`, `hyprpi find [--ai] …`, screenshots with `grim -o TEST`, clicks/typing with
`~/Work/hyprcu/.venv/bin/hyprcu`. Layer check: `hyprctl layers -j`.

## Known bugs / sharp edges

- **Closing the room window can leave the other windows rearranged.** Dwindle's `movetoroot`
  rebuilds the rest of the tree, and that persists after close (verified: even plain `movetoroot`
  does it; unstable variant too). Angus accepted this for now. Alternative on file: floating room
  window + per-workspace left gap (tree untouched, exact restore).
- **Quickshell hot reload is unreliable** for this UI: after editing QML, kill the UI process
  (match cmdline `hyprpi/ui` AND the right `WAYLAND_DISPLAY`) rather than trusting the reload.
  Never `pkill -f 'hyprpi/ui'` from a bash command that contains that string — it kills itself.
- Agents named from outside (`hyprpi name --agent`) don't know their name; the room question
  now says "you are X". Real `/name` sets the Pi session label too.
- The `subagent` (herdr pane) tool does nothing useful in hyprpi agents; twins work.
- No restart of agents after crash/reboot yet (registry has the data: session file, workspace).
- AI search model default `claude-haiku-4-5` via `pi -p` (config `searchModel`).
- The nested test Hyprland was still running on workspace 9 at handoff (with test agents).

## Next steps (Angus's "later" list)

Choosing a search result (open/jump/quote?) · restarting agents (crash + after reboot) · master
list of all rooms · pop-up picker version · flagging an agent's window when it needs you ·
pop-out/pin toggle was discussed and parked.

---

# Loom's additions (2026-09-26 11:35 CDT)

Loom was a hyprpi agent (room C). Everything below is committed and pushed (last commit `b1093dd`).

## Current state

- **Keys** now live in `hypr/hyprpi.lua` (symlinked as `~/.config/hypr/hyprpi.lua`, required from
  `hyprland.lua` after Omarchy's defaults). They **supersede the key list above**:
  - SUPER+A: new agent.
  - SUPER+ALT+A: **room TUI** (`mockups/room-tui`, current world).
  - SUPER+ALT+/: **search TUI** (`mockups/search-tui`).
  - SUPER+SHIFT+/: Monitor scaling down. Omarchy's SUPER+ALT+/ binding is `hl.unbind`-ed there because it clashed.
  - The QML room and search windows have no keys now; `hyprpi room|search --toggle` still works.
- **TUIs** (`mockups/room-tui.mjs`, `mockups/search-tui.mjs`): the launchers `mockups/room-tui` and
  `mockups/search-tui` open their **own** kitty window (`--class hyprpi.mockup`). With no ROOM
  argument they use the current world's room. Every press opens a new window (no toggle).
- **Search:** nothing runs until Enter, in both the TUI and `ui/SearchWindow.qml`. In the TUI, Enter
  again with unchanged text jumps to the selected agent.
- **Status marks:** ● working · ✓ done (dings; stays until a click or typing in that window, via
  the click hook in `hypr/hyprpi.lua` + `hyprpi seen`) · ○ idle · × blocked (`bonk`, sticky).
  An Esc-aborted turn ends as idle, with no ding.
- **Topics:** the daemon labels each agent's subject in a short phrase (≤5 words / 40 chars;
  `topicWords`, `topicChars`), relabelled on the ding.
- **Names:** unique among live agents. `{#rrggbb}` markup is kept (`name_markup`). The agent
  gets a footer and window title with its own name.
- **Reprieve:** agents on `offLimitsWorkspaces` (default `special:reprieve`) leave their room.
- **Outside this repo:**
  - `~/.pi/agent/extensions/editor-select.ts`: Shift+Arrow selection in Pi's editor.
  - `~/.pi/agent/keybindings.json`: Ctrl+Enter = newline.
  - kitty `map ctrl+insert copy_or_noop`.
  - Copies of the editor extension and kitty config are in `~/Work/herdr-agent-config`.

## How to test without touching Angus's screen

`hyprctl dispatch "hl.dsp.exec_cmd('kitty --class hyprpi.selftest -o allow_remote_control=yes --listen-on unix:/tmp/kt-test node /home/agf/Work/hyprpi/mockups/search-tui.mjs C', { workspace = 'special:selftest silent' })"`

Then use `kitty @ --to unix:/tmp/kt-test send-text|send-key|get-text --extent screen`, and finish with `close-window`.
- Run the `.mjs` directly, not the launcher (the launcher opens a second, visible window).
- For Pi itself, run `env -u HYPRPI_AGENT_ID pi --no-session` in the same way.
- Before adding any key: `hyprctl binds -j` and look for the same modmask+key (case-insensitive: `SLASH` = `slash`).

## Decisions (with Angus)

- Only the name gets the grey cursor highlight, never the status mark.
- Agent rows: mark · name · topic · model, separated by dots like Herdr, not tabs.
- Messages show the name aligned with the agent names above, then the text, with no time.
- Search waits for Enter (typing must not search).
- Keys open the TUIs, not the QML windows.

## Known bugs / not verified

- `SearchWindow.qml` "wait for Enter" was only linted, never opened.
- A single-letter paste through kitty's own paste action was not reproducible from the harness.
- The two TUIs were Angus's "mockups" but are now the default UI. Consider moving them out of `mockups/`.

## Next steps

- A toggle for the TUIs (close an existing room TUI on this workspace instead of opening another).
- Move the TUIs out of `mockups/` and give them `hyprpi tui` / `hyprpi search-tui` commands.
- Everything in Ghost's list above (choosing a search result, restarting agents, a master room list).

---

# Quartermaster's additions (2026-09-26)

- **Activity stream.** The room TUI's room pane is now a stream: messages plus agent activity,
  Ctrl+F cycles all / messages / activity. Activity is never part of any agent's context.
  - Daemon (`lib/daemon.mjs`): `recordActivity` appends to `~/.local/state/hyprpi/activity/<room>.jsonl`
    (schema v1, documented in README "Activity stream") and broadcasts `activity` to UI connections;
    methods `agent.activity` (from agents) and `activity.read`. It records topic changes, done/blocked,
    talk/demand/talk_reply between agents and Angus's direct prompts itself.
  - Pi extension: `tool_call` → one short line per tool call, batched (2 s after the last call, at most
    every 6 s; same-verb runs merge), flushed on agent_settled. Only agents started or reloaded after
    this change send tool lines.
  - Config: `activity` (default true), `activityTools` (default true).
  - Sankey (omarchy-data-visualization dashboard) reads the JSONL; keep the schema stable (add kinds,
    don't rename fields; bump `v` for breaking changes).
- **Kitty terminal helpers** (`terminal-helpers/kitty/`): agent windows load your kitty.conf then
  `pi.conf` (Ctrl+click links, SUPER+C / Ctrl+Shift+A for Pi, Shift+Enter, select-to-copy);
  `links.conf` is also included by `~/.config/kitty/kitty.conf`. `terminalHelpers: false` skips it.
- **`hypr/hyprpi.lua`** holds the keys, the window rule and click-to-mark-seen (symlinked into ~/.config/hypr).
- Restarting the daemon after lib changes: `hyprpi ensure` (not every command checks code mtime).
- Not done: drag-select on activity rows; activity in the QML room window; a per-agent "now doing"
  line in the agent list.
- **The Stream (Blink, 2026-09-30; @hyprpi N40, Angus via Thoughts-C).** Panel 2 is the Stream
  (README "The Stream"): `lib/stream.mjs` builds one timeline (posts, did lines deduped against
  posts, topics, events, talk, board changes from `boards/<W>.log.jsonl`, Thoughts' lines; project per
  line) and parses the filter (`@names` union of agents + projects, `3h`/`today`/`since 9am`, words,
  `raw`). Ctrl+F = full ⇄ compact. `history.read` takes `since` and returns `changes`; board
  `onChange` broadcasts the change. `/digest` = daemon `thoughts.digest` (same filter) →
  `thoughts.digest()` in lib/thoughts.mjs (evidence entry + prompt for a summary by project);
  `thoughts.seen` on the Thoughts window's focus-out. Angus kept the box sending (his correction
  to point 4). Not renamed (risky): the file room-tui.mjs, the title "hyprpi-room C", `/room`
  (`/stream` from other panels now goes there too).
- **▸ marks retired (Blink, 2026-09-30; Angus answered @hyprpi D4 with c).** Gone: the agents
  panel's ▸ column (kept blank so names don't move), Space / Ctrl+A / Esc marking and
  second-click marking; the room panel's "to:" selection (the prompt is just `C ❯`; `@Names` alone
  now asks for a message), its marks stream filter and "· ▸ N"; the Thoughts window's marks
  filter and "(marks)" note; the daemon's selection.get / set / toggle and the "selection" event.
  Replacements: `@Name text` / `@project text`, `/stream @Name` (new), `/keyword @Name …`. Space in
  the agents panel is unbound.
- **Did lines (Blink, 2026-09-30).** On each working→done the daemon writes one activity line of
  kind `turn` (lib/topics.mjs `turnInput` reads the session from the turn's start: Angus's message or
  an injected hyprpi-talk / room message, reading back up to 8 MB because tool results make huge
  lines; `summarizeTurn` = one haiku call). The room panel shows did lines and hides tool lines in
  every view (`/stream raw` shows them); agents mid-turn show "● Name working…". Tool lines are
  still logged: AI search, /ask (which ranks did lines above tool lines) and historySince read them.
  Dropping tool-line logging waits until /ask can read session files for exact details.
  Next: the agents panel's "last did" line. The daemon already sends `last_did` {text, ts} on every
  agent (lib/daemon.mjs `lastDidOf`); agents-tui draws one row per agent and its click mapping
  assumes that, so a second row needs care.

## Resumed sessions keep their identity (💋 Lippy, 2026-09-28)

- **Bug:** an agent whose Pi session was reopened under a *new* hyprpi id (e.g. resumed outside hyprpi's own dormant-resume) got a fresh registry record: the name came back from Pi's session name, but **topic, icon and colour were blank**. Its topic also stayed blank until the next working→done transition, and a follow-up typed mid-turn delays that.
- **Fix:** `lib/daemon.mjs`, `agent.hello`: for a brand-new id with a session file (not a twin), copy `name, nameMarkup, icon, color, topic, topicKey` (only if still empty) from the most recently updated registry record with the same session. If a *live* agent still holds that name, copy only the topic (names/colours stay unique).
- **Commit:** landed inside `9551e12` (another agent's commit, "Room panel: explain // …"), so the message doesn't describe it. `git show 9551e12 -- lib/daemon.mjs` shows the 14 lines.
- **Verified:** throwaway daemon (`HYPRPI_STATE`/`HYPRPI_SOCKET` in a temp dir) with a registry holding an old Lippy record: `agent.hello` with a new id + same session returned name Lippy, 💋, #9b5cff; a second new id on the same session while the first was live got no name. The first version of the test copied icon/colour anyway; that was tightened afterwards and only re-checked with `node --check`, not re-run. The live daemon restarted at 14:07 on 2026-09-28, so the fix is running; it has not yet been observed on a real resume.
- **Where topics come from** (for anyone confused like Angus was): the daemon, not the agent. `refreshTopic` runs 500 ms after an agent's status goes working→done, summarising the last 3 user messages with claude-haiku-4-5 (`lib/topics.mjs`).

---

## 2026-09-30 — ▥ Mullion (hp-muk23k2vkrh, room C): resume, the agents panel, panel columns

**State: all committed and in use.** Commits `8ad1e6c` → `9551e12`, plus `54698b9`. Full design
record in `docs/panels-plan.md` (§1 is what was built and why, §4b the layout lessons).
Tag `panels-combined` marks the single combined TUI from before the split.

### What exists now

| Piece | Where |
|---|---|
| Resume agents lost to a reboot | `lib/daemon.mjs` (heartbeat, `dormantList`, `agent.resume`, `agent.forget`), `bin/hyprpi` (`new --id`) |
| Parked agents (Reprieve) | `agent.unpark`, `parkedFrom` / `parked_from` |
| Panel 1, agents | `mockups/agents-tui.mjs` + `mockups/agents-tui` launcher, SUPER+ALT+A |
| Panel 2, room/stream | `mockups/room-tui.mjs`, SUPER+ALT+R |
| Shared terminal layer | `lib/tui/term.mjs` |
| Per-room selection (the ▸ marks) | daemon `selection.get/set/toggle` + `selection` event |
| Column layout | `mockups/panels` + launcher, SUPER+ALT+P |

### How to run / test

- Panels: `SUPER+ALT+A` (agents), `SUPER+ALT+R` (room), `SUPER+ALT+P` (columns). Each panel
  re-execs itself when its own code changes, so an open window is never stale — except one
  started before that feature existed, which needs one manual restart.
- **Test without touching the desktop**: run a daemon on a throwaway state dir and drive a panel
  in a pty. `HYPRPI_STATE=$T/state HYPRPI_SOCKET=$T/run/t.sock node bin/hyprpi daemon` then the
  same env for `node mockups/agents-tui.mjs C` under `pty.fork()`. Write a fake `agents.json` and
  `daemon.beat` to fabricate dormant/parked/closed agents. Screens come back with `\r\r\n` line
  endings; strip ANSI and split on the card/section marker, not on `\x1b[H`.
- Before/after comparisons of a refactor: capture both versions the same way and diff the
  normalised screen. That is how the panel-2 slimming was proved to change nothing visible.

### Decisions and why

- **"Lost to a reboot" vs "closed on purpose"** is decided by a 10 s daemon heartbeat plus
  `connected`/`leftAt` per agent, and a `/proc/<pid>/environ` check for `HYPRPI_AGENT_ID` so a
  recycled pid can't fake a live agent. A window closed while hyprpi keeps running is gone for
  good; one lost within 30 s of the last beat comes back. Rejected: evicting/reopening everything,
  because the registry holds ~70 dead entries and never prunes.
- **Resume reuses the agent id** (`hyprpi new --id`). This is the whole reason names, rooms and
  twin links survive; `twin_of` points at an id, so a new id silently breaks twinning.
- **Selection lives in the daemon, per room**, because panel 1 sets it and panels 2–3 read it, and
  because dictation routing will want it later. Per room, not global, so switching worlds doesn't
  wipe your marks.
- **Exact columns float; dwindle is the "off" state.** Angus asked for precision "even if we break
  out of dwindle". Panel mode floats each panel and places it by pixel inside the monitor's
  reserved area; a second SUPER+ALT+P tiles them back and deliberately leaves dwindle's own
  50/25/25 so the two states look different at a glance.
- **In panel mode a new agent goes to the neighbouring workspace** (after, or before on the
  world's last), not the first free one — Angus's rule.

### Known bugs / traps

- **Resizing tiled windows one by one skews dwindle's tree** — a panel ended up 16 px wide. The
  working recipe is: float all, tile back left-to-right with `hl.dsp.layout("preselect r")`
  between, then ONE exact resize of the left-most window. An exact resize needs a real height;
  `y = 0` is rejected as "Invalid size".
- **Hyprland Lua dispatch names are not the hyprctl ones.** `hl.dsp.layout("preselect r")`,
  `hl.dsp.window.resize({x, y, relative=false})`, `hl.dsp.window.move({x, y, relative=false})`,
  `hl.dsp.focus({ workspace = "29" })`, `hl.dsp.window.float()` (which TOGGLES — drive it towards
  the state you want). `hl.dsp.layoutmsg`, `hl.dsp.workspace(n)`, `splitratio exact` do not exist.
- **Panel window titles are the panel identity** (`hyprpi-router C`, `hyprpi-room C`,
  `hyprpi-search C`, and now `hyprpi-board C`). They deliberately do NOT end in ` · <ROOM>`,
  because the daemon treats titles ending that way as its own room windows and repositions them.
  If you change a panel's title, change `mockups/panels` in the same commit.
- **Restarting the daemon by hand is racy.** Any live agent runs `hyprpi ensure` within ~2 s, so
  "stop, edit `agents.json`, start" must be one script that waits for the pid to be gone. I lost
  an edit to this.
- **A visible special workspace swallows new windows.** `hyprpi new` now hides it first; anything
  else that spawns windows should too.
- Duplicate panel windows accumulate (several stale ones sit in Reprieve). Nothing cleans them up.

### Next steps

1. Revive-a-parked-agent (Enter on a parked row) is **untested end to end** — park something and try it.
2. `--tidy` for `mockups/panels`: close duplicate panels for a room.
3. Optional, discussed with Angus and not taken: daemon-side eviction of non-panel windows from a
   panel workspace. It is the only thing that would cover terminals; the current rule only governs
   windows hyprpi launches itself. Put it behind a config flag, default off.
4. `docs/panels-plan.md` §3 still lists shared modules (`selectcopy`, `inputbox`, `stream`, `conn`)
   that were never extracted; only `term.mjs` was. The panels still duplicate the message box and
   mouse-selection code — though Blink has since started `lib/tui/command-line.mjs`, which may
   supersede this.

## 2026-09-30 — ⚒ Lathe (hp-mukr623ze03, pi·ze03, workshop room D): panels, spin-out, projects section, Thoughts

**Built (all committed):** `6ffbe5d` spinout · `a64692c` panels override fullscreen (`lib/hypr.mjs` unfullscreen/clearFullscreen) · `ab25106` + `4e57df6` bar world click = agents panel toggle here, without focus (`mockups/agents-here`) · `05bf44a` room "stream · topics only" · `1ac0cd8` projects section in agents-tui, board panel = projects panel on SUPER+ALT+P, arranger on SUPER+CTRL+ALT+P, daemon project `short` summaries + `board.open` · `278655f` clickable world tabs (`lib/tui/world-tabs.mjs`) · `d6bdee7` Ctrl+C copies / search box wraps · Thoughts: `22a4971` `0972621` `61f7be0` `f214db6` `7eb93ef` `fd32611`.

**Thoughts (world agents), state:**
- `lib/thoughts.mjs`: the daemon runs Thoughts-<room> as `pi --mode rpc` with its own session under `state/thoughts/<room>/`, the thread in `state/thoughts/<room>.thread.jsonl`, and an idle stop after `thoughtsIdleMin`. No built-in tools. The system prompt is read only when the process starts, so a changed prompt needs the daemon restarted while Thoughts is idle (`thoughts.get` busy=false).
- Tools: `pi-extension/thoughts.ts` → daemon `thoughts.*` methods (world, ask, work, open, answer, topic; Blink added evidence/find).
- Requests from Thoughts to agents are ordinary `talk` requests with `from: "thoughts:<room>"`; `talk.reply` routes them back. They live in memory, so a daemon restart drops them.
- The search panel was rebuilt by Blink (`276b60f`, `38a7f97`) into a single Thoughts window. My Thoughts-mode code in search-tui is superseded, but the backend is the same.

**Testing recipe:** isolated daemon: `HYPRLAND_INSTANCE_SIGNATURE=bogus-x HYPRPI_STATE=/tmp/x/state HYPRPI_SOCKET=/tmp/x/s.sock XDG_RUNTIME_DIR=/tmp/x/run node bin/hyprpi daemon`. For wl-paste add `WAYLAND_DISPLAY=/run/user/1000/wayland-1`, since XDG_RUNTIME_DIR is overridden. A fake agent: `connect()` + `agent.hello {agent_id}` + answer `talk` events with `talk.reply`. Panels: run a temp copy (`mockups/.x.tmp.mjs`) in a pty with pyte (`/tmp/pytevenv`), then `mv` it into place. Kill test processes by env (`grep bogus /proc/PID/environ`).

**Decisions (Angus):** Thoughts is one agent per world (Opus 5.5), not in the agents panel, never given tinker jobs, one new agent per request. Its room posts are one line per hand-off, reply and agent question, plus a topic; plain chat is not posted. Links must always be clickable. The board panel is "projects" on SUPER+ALT+P.

**Known issues / next:**
- Reprieve (@omarchy N1): SUPER+W can file a window as 📌 Stashed. It needs a real-key test (ask Angus first).
- Thoughts `open_agent` and jot_save are untested live.
- In-memory Thoughts requests don't survive a daemon restart. Persist them, or let the agent re-ask.
- `project.spinout` (`6ffbe5d`) has largely been superseded by /move; check before extending either.

## 2026-09-30 15:25 CDT — 📌 Tack (pi·k3vg, hp-muljw28k3vg, room C): the project board's view and panel

**Current state.** The board's view is `lib/tui/board-view.mjs`. `createBoardView({render})` returns:
- `frame(ctx)` draws rows in the stream's row shape, so selection and copy work unchanged;
- `input(text, ctx)` handles what is typed in board mode: commands, "@p …" and bare handles;
- `key(d, ctx)` handles the modifier keys;
- plus `complete`, `click`, `pick`, `scroll`, `refresh` and `status`.

It is shown by
- `mockups/board-tui.mjs`, "hyprpi-board ROOM", panel 4, SUPER+ALT+B (launcher `mockups/board-tui`, Blink);
- the room panel's board mode, still in room-tui. When board-tui exists, Ctrl+B there opens the panel instead.

Folds are per machine in `~/.local/state/hyprpi/board-folds.json`. The shimmer lives in `lib/tui/shimmer.mjs`, the box in `lib/tui/input-box.mjs` (Blink).

**Keys (Angus's rule): plain keys type, board actions need a modifier.**
- ^↑↓ move the highlight.
- ^⏎, or ⏎ on an empty box, opens a card, goes back to all projects, or puts a handle into the box.
- ^Space/^O fold. ^D drops an item (on a header: archives the project). ^T done. ^Z undoes a drop or archive.
- Alt+1…9 answers the highlighted decision.
- Esc clears the box selection, then the highlight, then the open card; it never quits.

**How to test (nothing touches Angus's boards or windows).**
- Drive the real panel in a pty and pyte: `uv run --with pyte python drive.py` (pty.fork, TIOCSWINSZ, pyte.ByteStream; send keys and SGR mouse, dump `screen.display`; cell `.bg` shows the highlight).
- Call it with `node mockups/board-tui.mjs Z` (or room-tui Z + ^B). Use a throwaway board **Z** only (`board.project create/remove` with room:"Z").
- Test projects with **no live members**: every board.request otherwise prompts real agents, yourself included.
- **Clean up all of** `~/.local/state/hyprpi/boards/Z.*`, `rooms/Z.jsonl` and `activity/Z.jsonl` (else a stray Z world tab appears), and take test ids out of board-folds.json.
- Unset WAYLAND_DISPLAY while testing copy, so wl-copy doesn't overwrite Angus's clipboard.
- Unit checks: import board-view with `HYPRPI_STATE=$(mktemp -d)` and a fake `api.call`.

**Decisions.**
- A handle is unique only within a project. A bare handle resolves to the open card first, else to the only project that has it, else it's refused with the @p to add.
- "Thinking" clears only on a change **not by Angus** (board.changes `by`), and the timer runs only while the board is visible.
- /move and /merge confirm with ⏎ twice and return `{confirm:true}`, so the resend guard doesn't swallow the second ⏎.
- Typing replaces the text left in the box after a send, and an arrow or Backspace first switches to editing it. This stops accidental resends.
- The @project **owner answers** room/board requests; other members talk the owner and don't post. It's built into the daemon's prompts now, after we crossed wires repeatedly.

**Known sharp edges.**
- Several agents share this tree, so commit only your hunks (`git diff`, then `git apply --cached` with a filtered patch). I once swept in Blink's work.
- Don't use `mockups/panels --only N` from a panel: it pulls windows onto the current workspace and breaks the 2×2 grid.
- Messages cross with Blink's constantly; check `git log` and the working tree before assuming a talk is current.

**Next (none claimed by me):** multi-project /fold; "since you left" was only ever tested with simulated agent changes; Ctrl+click to jump to an agent in board-tui is untested with a real agent.

## 2026-10-01 21:49 CDT — 📊 Sankey (hp-muil9rkd5ua, room C): the Decisions view (@hyprpi N68), publishing plan, wranglers survey

### What exists now
- **Decisions view** in the projects panel (mockups/board-tui.mjs): **Ctrl+F** or `/decisions` toggles cards ⇄ Decisions. Live since the daemon restart at b98fbfe.
  - Keys: ^↑↓ step; "2⏎" or Alt+2 picks option 2; ⏎ with an empty box takes ★; "L⏎" or Alt+L puts it off (to the end of the list, kept in memory per panel and across code restarts); other words + ⏎ answer in Angus's words (`typed: true`, never parsed as an option letter); Esc / ^F back.
  - Files: `lib/decisions.mjs` (pure: `openDecisions`, `parseDecision`, `sameDecision`, `isCatchAll`; reusable for a later pop-up), `lib/tui/decisions-view.mjs` (the view), `lib/tui/board-view.mjs` (Needs you also lists unfiled ones).
- **Answering** (daemon `board.item` action decide, humanOnly): the Decide item becomes a **Next** item with the same handle (`boards.decideItem`: sec next, was decide, resolution, decidedBy/At). The asking agent and the writer get one prompt each. The change line reads `decided D1: (question…) answer`. This applies to every answer path ("D1 b", Alt+N on cards too).
- **autoDecide** (lib/daemon.mjs) turns agents' decisions outside the board into Decide items:
  - Sources: any agent's "🔧 decide:" room post (tinker jobs via relayTinkerResult, which also dings) and `ding "…"` (helpers/bonk sends `hyprpi status blocked --quiet --decision "…"`).
  - Placement, **never across worlds**: the agent's project in its world (the one it changed most recently) → that world's catch-all card (name workshop / inbox / inbox-* / misc / general) → **unfiled** on that world's board (`b.unfiled`, U1…; answered → `b.unfiledDone`, the asker told).
  - Duplicates: `sameDecision` against any open item, or the agent's own hand-added Decide item from the last 2 min. Auto items carry `auto: true`. No new sounds.
- `hyprpi status blocked --decision TEXT` (bin/hyprpi); `agent.update` takes `decision`. A decision block clears when it's answered (`otherBlock` false for decision blocks).

### How to run / test
- `/tmp/n68/test_n68.py` (run with `/tmp/pytevenv/bin/python`) is the 44-check suite: isolated daemon on /tmp/n68/{sock,state}, HOME=/tmp/n68/home with a logging stand-in bonk, XDG_CONFIG_HOME=/tmp/n68/cfg (pi=/tmp/n68/fakepi, which prints an emoji so project-icon doesn't break), scripted fake agents (/tmp/n68/fake.mjs), the real board-tui in a pty read with pyte, and the real bonk with stubbed players.
- Refresh the tree first: `rm -rf /tmp/n68/tree; mkdir -p /tmp/n68/tree; tar cf - $(git ls-files) | tar xf - -C /tmp/n68/tree`; also `rm -f /tmp/n68/sock` and empty state/.
- pi·wpzt's independent suite: /tmp/n68w/test.py (67 checks).

### Decisions and why
- Ctrl+F: the panel had no view cycle; the Stream already uses ^F for views. Thoughts-D OK'd it; Angus may override.
- Digits and L need ⏎ (or Alt). As single keys they ate typed answers ("let's wait", "2 weeks is fine"; found by pi·wpzt).
- A decision stays in the agent's world (Thoughts-D's correction of the brief). There's no implicit @workshop creation (Blink).
- Answered → Next, not Done: the decision usually unblocks work, so it belongs in Next with the answer on it.

### Known bugs / traps
- `~/.local/bin/bonk` is a **copy** of agent-config/helpers/bonk, not a link. I updated it on 2026-10-01 (backup `bonk.bak-2026-10-01`). Future helper edits need copying again, or turn it into a symlink (Angus's PATH, so ask).
- Not exercised: a real tinker job's "🔧 decide".
- The "later" order lives in each panel (not the daemon), so two panels can differ.
- Don't pkill with a pattern that matches your own command line (it killed my shell).

### Next steps
- Angus to try Ctrl+F, and maybe pick another key.
- Later: a decisions pop-up (reuse `openDecisions`); the remote-control website (card H9, see ideas-worth-pursuing 2026-10-01).
- Publishing (N38) waits on decide item D5. The plan is ~/Obsidian/Tinker/2026-09-30 Publishing hyprwrlds and hyprpi.md; the survey is ~/Obsidian/Tinker/2026-09-30 Agent wranglers compared.md.
