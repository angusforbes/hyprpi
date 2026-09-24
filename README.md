# hyprwrlds-vimarchy

Vimarchy-style overview for hyprwrlds "worlds" (world A = workspaces 1-10, B = 11-20, ...).

| Keys | View |
|---|---|
| ALT+CTRL+SPACE | Current world: its occupied workspaces side by side |
| ALT+SHIFT+SPACE | All worlds: one row per world that has windows |

Windows are outlined boxes at their real position and size inside a mini-screen per workspace.
Only workspaces with windows are shown. Each window gets a hint: `a`-`z` for the first 26
(filled badges), then `A`-`Z` with Shift for 27-52 (outlined badges), then two lowercase
letters. Typing a hint jumps to that window (Hyprland switches to its workspace). Case comes
from Shift, so Caps Lock can't flip a hint. Escape, Backspace on an empty entry, or a click on
the backdrop closes. Clicking a window box jumps to it too. Jumping only (moving windows: later).

## Layout
- `Overview.qml`: the whole overview, self-contained (reads theme colours itself).
- `plugin/`: Omarchy overlay plugin wrapper (`agf.hyprwrlds-vimarchy`).
- `install.sh`: copies into `~/.config/omarchy/plugins/agf.hyprwrlds-vimarchy/`.
- `shell.qml`: standalone dev harness (`qs -p ~/Work/hyprwrlds-vimarchy`), which never
  touches the bar. IPC: `open world|all`, `openTest <mode> <hintStart>`, `resolve <seq>`
  (dry run), `press <key>`, `close`, `state`. Auto-closes after 20 s (keyboard grab).

Keybindings live in `~/.config/hypr/hyprwrlds.lua`.

## Caveat
The Omarchy shell may keep serving a cached copy of an already-loaded plugin's QML after
`install.sh`. Iterate in the dev harness; a shell restart (ask first) picks up plugin changes.
