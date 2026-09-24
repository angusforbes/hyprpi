# hyprwrlds-vimarchy

Vimarchy-style overview for hyprwrlds "worlds" (world A = workspaces 1-10, B = 11-20, ...).

| Keys | View |
|---|---|
| ALT+CTRL+SPACE | Current world: its occupied workspaces side by side |
| ALT+SHIFT+SPACE | All worlds: one row per world that has windows |
| ALT+SPACE | Current workspace only (replaces Vimarchy's hints) |
| ALT+SHIFT+CTRL+SPACE | The original Vimarchy (kept for reference) |

Windows are outlined boxes at their real position and size inside a mini-screen per workspace,
styled like Vimarchy: each window gets a colour from Vimarchy's palette (tinted box, coloured
outline, translucent circle with the letter in full colour). Only workspaces with windows are
shown. Hints are global: every window has the same letter (and colour) in all three views. They run alphabetically and contiguously in reading order over ALL windows (world, workspace, then
left-to-right/top-to-bottom): `a`-`z` for the first 26, then `A`-`Z` with Shift for 27-52
, then two lowercase letters. Ctrl+= / Ctrl+- resize the circles
(0.75-1.5x, saved in `~/.config/omarchy/hyprwrlds-vimarchy.json`). Each box shows a still capture of the app (taken when the overview opens, also for windows on
hidden workspaces). All hint circles are the same size. Settings in the JSON file:
`hintScale`, `showPreviews` (default true), `shiftRing` (ring around A-Z hints, default false),
`windowTintOpacity`, `badgeTintOpacity`. App labels are shortened
(`chrome-web.whatsapp.com__-Default` -> `whatsapp`). At most 3 worlds and 4 workspaces per row are shown. Arrow keys move a selected workspace
(dark border, "▸"): Left/Right within the row, Up/Down between worlds, wrapping at the ends;
the view scrolls to follow. When a row has more than fits, "‹ 9" / "5 ›" name the workspace just outside the view on each side, wrapping; likewise "▲ G" / "▼ D" name the world above/below. Enter goes to the
selected workspace. Hints keep their letters while scrolling. Typing a hint jumps to that window (Hyprland switches to its workspace). Case comes
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

## Settings

`~/.config/omarchy/hyprwrlds-vimarchy.json` is created with every setting at its default the
first time the overview runs (missing keys are filled in later too). Edits apply the next time
the overview opens; no restart needed.

| Key | Default | Meaning |
|---|---|---|
| `workspacesPerRow` | 3 | Workspaces visible per row (1-10); arrows scroll the rest |
| `worldsVisible` | 3 | Worlds visible at once in the all-worlds view (1-9) |
| `align` | `"left"` | `"left"` or `"center"` |
| `margin` | 48 | Edge margin in px |
| `maxTileWidth` | 460 | Largest workspace tile width in px (tiles shrink to fit the screen) |
| `hintKeys` | `"abcdefghijklmnopqrstuvwxyz"` | Hint letters, in order (unique a-z, at least 2) |
| `uppercaseHints` | true | After the lowercase keys, use Shift+uppercase before two-letter hints |
| `shortenAppNames` | true | `chrome-web.whatsapp.com__-Default` -> `whatsapp` |
| `showPreviews` | true | Still capture of each app inside its box |
| `doubleTap` | true | A quick repeat of a hint's last key (within `doubleTapMs`) toggles fullscreen on the window you jumped to |
| `doubleTapMode` | `"maximized"` | `"maximized"` (full working area, bar stays; like Vimarchy and SUPER+F) or `"fullscreen"` |
| `doubleTapMs` | 300 | Double-tap window in ms (120-800) |
| `shiftRing` | false | Extra ring around uppercase (Shift) hints |
| `badgeBacking` | false | Cream disc under each circle for legibility over busy previews (Vimarchy has none) |
| `hintScale` | 1.0 | Circle size multiplier (0.5-5); Ctrl+= / Ctrl+- change it by 15% per press and save it |
| `badgeMin` / `badgeMax` / `badgeFraction` | 72 / 132 / 0.34 | Vimarchy's circle rule: shorter side of the real window x fraction, clamped to min..max px, x hintScale, then scaled to the mini-map |
| `windowTintOpacity` | 0.07 | Tint of each window box (0-0.3) |
| `badgeTintOpacity` | 0.21 | Colour tint of each circle (0-0.3) |
| `backdropOpacity` | 0.94 | How opaque the backdrop is (0-1) |
| `palette` | Vimarchy's 14 colours | Window/circle colours, assigned in hint order |

World colours (A blue, B red, ...) come from the Omarchy theme, not this file.
