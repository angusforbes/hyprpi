# hyprpi — handoff (👻 Ghost, 2026-09-25)

Repo: https://github.com/angusforbes/hyprpi (public) · code: `~/Work/hyprpi` · user docs: `README.md`.
Goal (Angus): replace Herdr's "all agents in one app" with Pi agents in **their own windows**,
anywhere in any workspace of any hyprwrld, grouped into **rooms** (default one per world).
Herdr and hyprpi run side by side for now; hyprpi is meant to replace Herdr eventually.

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
  `hyprpi room --toggle` (`~/Work/hyprwrlds` commit 9aa5822, pushed).
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
