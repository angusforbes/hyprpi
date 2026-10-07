# hyprwrlds-vimarchy

Part of **[hyprpi](https://github.com/angusforbes/hyprpi)** (folder `hyprwrlds-vimarchy/`); newer
versions live there. It builds on [hyprwrlds](https://github.com/angusforbes/hyprpi/tree/master/hyprwrlds).

A [Vimarchy](https://github.com/clickety-clacks/vimarchy)-style window overview for
**[hyprwrlds](https://github.com/angusforbes/hyprwrlds)** worlds on Omarchy/Hyprland: see your
workspaces as mini-screens with a live-looking preview of every app, jump to any window by typing
its letter, and move windows between workspaces and worlds from the keyboard.

(World A = workspaces 1-10, B = 11-20, ... see hyprwrlds.)

| Keys | View |
|---|---|
| ALT+SPACE | The current workspace (replaces Vimarchy's window hints) |
| ALT+CTRL+SPACE | The current world: its workspaces side by side |
| ALT+SHIFT+SPACE | All worlds: one row per world |
| ALT+SHIFT+CTRL+SPACE | The original Vimarchy (kept for its own gestures) |

## Overview

- Each window is a box at its real position and size inside a mini-screen for its workspace,
  with a still capture of the app (also for windows on hidden workspaces) and a small app label
  (`chrome-web.whatsapp.com__-Default` -> `whatsapp`).
- Vimarchy's look: every window gets a colour from Vimarchy's palette (tinted box, coloured
  outline, translucent circle with the letter in full colour). Circle size follows Vimarchy's
  rule; Ctrl+= / Ctrl+- resize all circles (saved). Circles are drawn above every box, so a
  sub-window never hides a letter; a fullscreen/maximized window is drawn on top, as on screen, labelled ▣
  (`fullscreenOnTop`), and the windows beneath keep their letters.
- World letters and workspace headers use the hyprwrlds world colours from the Omarchy theme.
- Workspaces with windows are shown (plus any empty workspace that exists, e.g. the one you are
  on). A workspace you empty by moving windows out stays as an empty tile until you close.
- Left-aligned; at most 3 worlds and 3 workspaces per row by default.

## Hints

- **Global:** a window has the same letter and colour in all three views. Letters run in reading
  order over all windows (world, workspace, left-to-right/top-to-bottom): `a`-`z`, then `A`-`Z`
  (Shift), then `aa`, `ab`, ...
- A letter that also starts a pair (e.g. `a` once `aa` exists) waits 0.4 s for a second key;
  Enter/Space selects it at once. Every other letter jumps instantly.
- Letters never change while the overview is open (moves included); they are re-ordered on the
  next open. Each view only accepts the letters it shows.
- Case comes from Shift, so Caps Lock can't flip a hint.
- **Double-tap** a hint (repeat its last key within 0.3 s) to jump and toggle fullscreen
  (maximized by default). Other keys typed right after a jump go to the app as usual.

## Navigation

| Keys | Action |
|---|---|
| a-z, A-Z, aa... | Jump to that window (Hyprland switches to its workspace) |
| Arrows | Move the selected workspace (dark border, "▸"); wraps at both ends. "‹ 9" / "5 ›" and "▲ G" / "▼ D" name what is just off-screen |
| Enter | Go to the selected workspace |
| Click a window | Jump to it |
| Ctrl+= / Ctrl+- | Bigger / smaller circles |
| Esc, Backspace (empty), click the backdrop | Close |

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
| `showEmptyWorkspaces` | false | If true: while a window is held (Alt+hold), world views show all 10 workspaces (1-9, 0) of each world; empty ones can be selected and dropped into |
| `shortenAppNames` | true | `chrome-web.whatsapp.com__-Default` -> `whatsapp` |
| `showPreviews` | true | Still capture of each app inside its box |
| `doubleTap` | true | A quick repeat of a hint's last key (within `doubleTapMs`) toggles fullscreen on the window you jumped to |
| `fullscreenOnTop` | true | A fullscreen/maximized window is drawn over its workspace's other windows, as on screen (▣ in its label); their hint letters stay on top. `false` = draw it at the back |
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

## Moving windows (keyboard-first)

| Keys | Action |
|---|---|
| Alt+hold a hint (~0.35 s) | Add the window to the move list (heavy outline; banner lists them). Alt+hold a listed one to remove it. Two-key hints: Alt+tap the first key, then Alt+hold the second |
| Arrows | Move the workspace selection |
| Enter / click a workspace | Move every listed window into the selected / clicked workspace |
| 1-9, 0 | Drop into that workspace of the selected row's world (single-workspace view: current world) |
| Alt+N | Add an empty workspace to the selected row's world (next free of 1-0; max 10) |
| Alt+Shift+N | Add a new world (next free A-I) with an empty workspace 1 (all-worlds view) |
| Alt+Esc | Clear the move list |
| Esc | Close the overview |

Moves are silent (you stay where you are) and the overview refreshes so you can keep going. Empty
workspaces added with Alt+N / Alt+Shift+N become real once a window is dropped in.

## Install

Requires [hyprwrlds](https://github.com/angusforbes/hyprwrlds), Omarchy's Quickshell-based shell
and Hyprland 0.56+ (Lua config).

```
git clone https://github.com/angusforbes/hyprpi ~/Work/hyprpi
~/Work/hyprpi/hyprwrlds-vimarchy/install.sh
```

(The script works from wherever it is; install hyprwrlds first: `~/Work/hyprpi/hyprwrlds/install.sh`.)

This installs the overlay plugin `agf.hyprwrlds-vimarchy` into `~/.config/omarchy/plugins/`
(and enables it) and `hypr/hyprwrlds-vimarchy.lua` (the keys above + double-tap support) into
`~/.config/hypr/`, required right after `hyprwrlds`. The original Vimarchy plugin is only needed
for ALT+SHIFT+CTRL+SPACE. After updating an already-installed copy, run `omarchy-restart-shell`
(the shell may otherwise keep a cached copy of the QML).

## Development

- `Overview.qml`: the whole overview, self-contained (reads theme colours and settings itself).
- `plugin/`: the Omarchy overlay wrapper; summon with
  `omarchy-shell shell summon agf.hyprwrlds-vimarchy '{"mode":"workspace"|"world"|"all"}'`.
- `shell.qml`: a standalone Quickshell harness (`qs -p .`) that never touches the bar, with IPC
  for testing without a keyboard: `dry <mode>` (build without showing), `state`, `resolve`,
  `would <keys>`, `pick <hint>`, `dropDigit <n>`, `newWorkspace`, `newWorld`, `rowsSummary`,
  `move <dr> <dc>`, `open`, `close`. The harness auto-closes the overlay after 20 s.

## Credits

Look and feel follow [Vimarchy](https://github.com/clickety-clacks/vimarchy) by Mike Manzano
(MIT): its hint palette, tint levels, circle sizing rule and double-tap idea. No Vimarchy code is
included; this is a separate plugin.

## License

MIT

<!-- TODO: screenshots of the three views (ALT+SPACE, ALT+CTRL+SPACE, ALT+SHIFT+SPACE) from a
staged desktop or a synthetic demo mode; no personal windows/content in the images. -->

## Uninstall

Run `uninstall.sh` (or `hyprpi integration uninstall hyprwrlds-vimarchy`): it removes the require line,
`~/.config/hypr/hyprwrlds-vimarchy.lua` and the overlay plugin (backups in `~/.local/share/hyprwrlds-backups/`).
