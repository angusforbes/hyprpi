# hyprwrlds

**Worlds** for [Hyprland](https://hypr.land) on [Omarchy](https://omarchy.org): a layer above
workspaces. A world is a block of ten numbered workspaces:

| World | Workspaces |
|---|---|
| A | 1-10 |
| B | 11-20 |
| C | 21-30 |
| ... | ... |
| I | 81-90 |

The current world is simply derived from the focused workspace id, so there is no extra state to
drift. Everything numeric in Hyprland (window rules, `hyprctl`, other tools) keeps working.

Companion project: **[hyprwrlds-vimarchy](https://github.com/angusforbes/hyprpi/tree/master/hyprwrlds-vimarchy)**, a
Vimarchy-style overview of worlds and workspaces with letter hints, previews and keyboard moves.

hyprwrlds lives in the **[hyprpi](https://github.com/angusforbes/hyprpi)** repo (folder `hyprwrlds/`),
whose agents use one room per world. That folder is the master; this standalone repo is published from it.

## Keys

| Keys | Action |
|---|---|
| **SUPER+1..0** | **Workspace 1..10 of the current world** |
| SUPER+SHIFT+1..0 | Move window there (follow) |
| SUPER+SHIFT+ALT+1..0 | Move window there silently |
| SUPER+TAB / SUPER+SHIFT+TAB | Next / previous occupied workspace in the current world |
| SUPER+scroll | Cycle occupied workspaces in the current world |
| SUPER+ALT+TAB / SUPER+ALT+SHIFT+TAB | Next / previous world |
| **SUPER+ALT+LEFT / RIGHT** | **Previous / next workspace in the current world (the grid, below), wrapping** |
| **SUPER+ALT+UP / DOWN** | **The same workspace in the previous / next world, wrapping** |
| SUPER+ALT+CTRL+arrows | One step to the adjacent workspace number (1-10) or world (A-I), empty or not; it's created when you get there. Wraps |
| SUPER+ALT+SHIFT+LEFT / RIGHT | Swap this workspace's windows with the neighbouring workspace's (same world, adjacent number) and follow |
| **SUPER+CTRL+1..9** | **Switch to world A..I (lands on that world's last-used workspace)** |
| SUPER+CTRL+SHIFT+1..9 | Move window to world A..I (follow) |
| SUPER+CTRL+ALT+1..9 | Omarchy's "Bar panel N" (moved here from SUPER+CTRL+1..9) |

These replace Omarchy's defaults on the same chords. Notably SUPER+CTRL+1..9 was Omarchy's
"Bar panel N", which now lives on SUPER+CTRL+ALT+1..9; SUPER+ALT+TAB was Omarchy's "next
window in group", and group windows stay reachable with SUPER+ALT+scroll and SUPER+ALT+1..5.
SUPER+ALT+arrows were Omarchy's "move window into the group on the left/right/…"; that move has
no key now, but SUPER+G (toggle grouping) and SUPER+ALT+G (move out of a group) remain.

**The grid** (SUPER+ALT+arrows): rows are worlds and columns are workspaces. The base grid,
worlds A-E × workspaces 1-5, is always walked, empty cells included. Beyond it only cells in use
are stops: workspace 6-10 of a world when it exists (it has windows, or it's the one you're on,
i.e. what the bar shows), a world F-I when it has a workspace or you're in it. So with B6 empty and
B7 in use, Right from B5 goes to B7. Each direction wraps. Up/Down keep the column when the target
world has it, otherwise land on that world's highest stop below it. To get to an empty workspace or
world outside the base grid, use SUPER+ALT+CTRL+arrows, which steps one by one and creates it.
SUPER+ALT+SHIFT+LEFT/RIGHT were Omarchy's "move workspace to the left/right monitor" (nothing to do
on one screen); SUPER+ALT+SHIFT+UP/DOWN still are.

## Bar widget

`omarchy-plugin/agf.hyprwrlds` replaces `omarchy.workspaces` in the top bar: world letters
(A B C ...) followed by the current world's workspace numbers.

- Each world gets a hue from the current Omarchy theme's `colors.toml`
  (A blue, B red, C cyan, D yellow, E magenta, F green, G orange, H brown, I foreground), so it
  follows theme changes.
- The current world is shown as the same solid block as the focused workspace; other worlds show
  their letter, dimmed when empty. The workspace numbers take the current world's colour.
- Click a letter to switch worlds, scroll over the letters to cycle, click a number to go there.
- Setting `worlds` (default 3): how many letters are always shown; higher worlds appear while
  they have windows. `omarchy bar set agf.hyprwrlds worlds 5`
- Setting `cellWidth` (default 15): the width of each letter and number cell (Style.space units;
  15 is compact, 20 the original wider look, allowed 8–40). `omarchy bar set agf.hyprwrlds cellWidth 12`.
  Both settings live in `~/.config/omarchy/shell.json`, in this widget's entry under `bar.layout`
  (`{"id": "agf.hyprwrlds", "worlds": "5", "cellWidth": "15"}`), and apply without a restart.

## World-coloured window border

The focused window's border takes the current world's colour (the same theme hues as the bar
widget), updating on every workspace switch and after theme changes. Set `WORLD_BORDERS = false`
at the top of `hyprwrlds.lua` to keep Omarchy's normal border.

## Install

Requires Omarchy with the Quickshell-based `omarchy-shell` and Hyprland 0.56+ (Lua config).

```
git clone https://github.com/angusforbes/hyprwrlds ~/Work/hyprwrlds
~/Work/hyprwrlds/install.sh
```

Or from a hyprpi checkout: `~/Work/hyprpi/hyprwrlds/install.sh` (the script works from wherever it is).

The script copies `hypr/hyprwrlds.lua` to `~/.config/hypr/`, adds `require("hypr.hyprwrlds")`
after `require("hypr.bindings")` in `~/.config/hypr/hyprland.lua`, installs and enables the bar
widget, and swaps it in for `omarchy.workspaces`. Edited files are backed up to
`~/.local/share/hyprwrlds-backups/`. A new bar widget loads without restarting the shell.

`MIN_WORLDS` at the top of `hyprwrlds.lua` (default 5) sets how many worlds SUPER+ALT+TAB cycles
through even when empty; keep it in step with the bar widget's `worlds` setting.

Debug: `hyprctl repl 'return hyprwrlds.state()'`. Scripting: `hyprctl eval 'hyprwrlds.world(2)'`,
`hyprwrlds.focus(n)`, `hyprwrlds.move(n, follow)`, `hyprwrlds.move_to_world(w, follow)`,
`hyprwrlds.cycle_world(±1)`, `hyprwrlds.cycle(±1)`.

## Uninstall

Run `uninstall.sh` (or `hyprpi integration uninstall hyprwrlds`). By hand: remove the `require("hypr.hyprwrlds")` line from `hyprland.lua` (Hyprland reloads on save), put
`{"id":"omarchy.workspaces"}` back in place of `{"id":"agf.hyprwrlds"}` in
`~/.config/omarchy/shell.json`, and delete `~/.config/omarchy/plugins/agf.hyprwrlds`.

## Notes

- The last-used workspace of each world is remembered in memory only; after a Hyprland config
  reload, switching to a world lands on its lowest occupied workspace instead.
- Window rules that pin an app to workspace `"5"` put it in world A.
- Vimarchy's own workspace-move radial targets absolute workspaces 1-10 (world A).
- If an edit to an already-loaded bar widget doesn't show, the shell may be serving a cached
  copy; restart it with `omarchy-restart-shell`.

## Maintaining (for the hyprpi repo)

Edit `hyprwrlds/` inside hyprpi and commit there. To publish the folder to the standalone repo
(history included, fast-forward only):

`git -C ~/Work/hyprpi subtree push --prefix hyprwrlds https://github.com/angusforbes/hyprwrlds main`

Run the usual secret check on the new commits first; it's a public repo.

## License

MIT
