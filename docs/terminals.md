# Terminals: what hyprpi and pi need, and how kitty, Ghostty, foot and Alacritty compare

hyprpi runs every agent (and its panels) in a terminal window. Which terminal is picked:
`"terminal"` in `~/.config/hyprpi/config.json`: `"auto"` (default) asks `xdg-terminal-exec --print-id`
(Omarchy's default terminal, `~/.config/xdg-terminals.list`), else foot. Or force `"kitty"`, `"foot"`,
`"alacritty"`, `"ghostty"`; any other terminal with `"terminalCommand"`. See `lib/terminal.mjs`.

**Short answer: kitty is the one everything is built and tested on.** Agents work in the other three
(they get their class and their own process, so rooms, summon/dismiss and the switcher work), but
you lose some comfort features, and the four panels (agents, Stream, search, projects) only open in
kitty today.

Checked against the code on 2026-10-06 (hyprpi `7fd56eb`, J189) with kitty 0.48.2, Ghostty 1.3.1,
foot 1.28.0 and Alacritty 0.17.0. **T** = tested here, **D** = from the terminal's or pi's
documentation (pi: `docs/terminal-setup.md`) or from reading hyprpi's code, not tried.

## What hyprpi and pi rely on (and where)

| # | Feature | Used by |
|---|---|---|
| 1 | Window class / app-id `hyprpi.agent` (`hyprpi.agents`, `hyprpi.mockup`, `hyprpi.summon` for panels) | `lib/terminal.mjs` (`KNOWN`: `--class` / `--app-id`), Hyprland rules in `hypr/hyprpi.lua` (`o.window("hyprpi\\..*", { tag = "+terminal" })`, the pin border), the daemon's window list, the vimarchy switcher's names/icons |
| 2 | One process per window | `lib/hypr.mjs` `windowForPid`: the daemon finds an agent's window by walking up from pi's pid, so single-instance / server modes must be off (Ghostty: `--gtk-single-instance=false`; foot: plain `foot`, never `footclient`) |
| 3 | Window title set by the program (OSC 2) | pi's extension sets `π - <name> - <folder>` (`pi-extension/index.ts`); kitty is started **without** `--title` because kitty would pin it (`lib/terminal.mjs` comment); the others get `--title pi` as a start value |
| 4 | Panel launchers | `mockups/agents-tui`, `room-tui`, `search-tui`, `board-tui`, `summon` (fallback pop-up): `exec kitty --class … -o …` with key maps (`ctrl+insert copy_or_noop`, `send_text` for Ctrl+Tab), `mouse_map` (Ctrl+click grabbed), `confirm_os_window_close=0`; **kitty only** |
| 5 | Agent-window helpers | `terminal-helpers/kitty/pi.conf` + `links.conf` (loaded after your `kitty.conf`): Ctrl+click opens links/files via `gio open`, select-to-copy, SUPER+C → `copy_or_noop`, Ctrl+Shift+A passed to pi, Shift+Enter / Alt+Shift+Enter as CSI-u. `agentclick.py` (a kitty kitten, currently off). Other terminals: no helper folder yet |
| 6 | OSC 8 hyperlinks + Ctrl+click | pi renders Markdown links and `<file:///…>` as OSC 8; agents are told to write file links that way (AGENTS.md); panels draw their own links and handle Ctrl+click themselves (SGR mouse, `lib/tui/markdown.mjs` `openTarget`) |
| 7 | Inline images | pi shows images with the kitty graphics protocol or the iTerm2 protocol (`PI_IMAGE_PROTOCOL` / `terminal.images`); no sixel |
| 8 | Extended keys | pi: Shift+Enter (newline), Alt+Enter (follow-up), SUPER bindings need the kitty keyboard protocol or CSI-u (pi `terminal-setup.md`) |
| 9 | OSC 52 clipboard | panels' copy (`mockups/room-tui.mjs`, `search-tui.mjs`, `board-tui.mjs`), with `wl-copy` as fallback |
| 10 | Synchronized output (DEC 2026) | panels draw each frame atomically (`board-tui.mjs`, `room-tui.mjs`) |
| 11 | SGR mouse incl. Ctrl/Shift+click, wheel | all four panels (click to select, Ctrl+click to jump to an agent or open a link, wheel scroll) |
| 12 | Character widths (emoji, ZWJ, variation selectors) | `lib/tui/term.mjs` measures widths the way **kitty** draws them; other terminals may draw some emoji 1 cell wider/narrower, shifting panel columns |
| 13 | Omarchy SUPER+C / SUPER+V | Omarchy sends Ctrl+Insert / Shift+Insert to windows tagged `terminal` (hyprpi tags its classes); kitty's `copy_or_noop` copies kitty's own selection or passes the key to pi |
| 14 | Current folder of a focused terminal | `cwdFromFocused` (`lib/apps.mjs` `TERMINALS`, reads the shell's cwd from `/proc`): kitty, foot, alacritty, ghostty, wezterm and others are recognised |
| 15 | Nerd Font glyphs / emoji icons | agent icons, the finder, pi's footer; a font matter (Omarchy ships a Nerd Font for all its terminals) |
| 16 | No visible tabs | one agent per OS window; panels map Ctrl+Tab to world switching (kitty would use it for tabs) |

hyprpi does **not** use kitty remote control (`kitten @`) itself; Omarchy's `omarchy-cmd-terminal-cwd` does,
for kitty windows.

## The table

| Feature | kitty | Ghostty | foot | Alacritty |
|---|---|---|---|---|
| 1 Class/app-id for Hyprland rules | ✅ `--class` **T** | ✅ `--class` **T** | ✅ `--app-id` **T** | ✅ `--class` **T** |
| 2 Own process per window | ✅ **T** | ✅ with `--gtk-single-instance=false` (hyprpi passes it) **T** | ✅ `foot` (not `footclient`) **T** | ✅ **T** |
| 3 pi sets the title | ✅ (no `--title`) **T** (daily use) | ⚠️ `--title` pins the title in Ghostty, so pi's `π - name - folder` may not show; drop `--title` for Ghostty **D** | ✅ `--title` is only the start value **D** | ✅ while `window.dynamic_title` is on (default) **D** |
| 4 Panels (agents, Stream, search, projects, summon pop-up) | ✅ **T** | ❌ launchers are kitty-only; needs Ghostty versions of the launchers (keybinds via `--keybind`) **D** | ❌ same; foot has `--override` for most of it **D** | ❌ same; `-o` overrides exist, no `copy_or_noop` equivalent **D** |
| 5 Agent-window helpers (Ctrl+click files, select-to-copy, SUPER+C, Shift+Enter CSI-u) | ✅ `terminal-helpers/kitty` **T** | ⚠️ no helper folder yet; Ghostty has `copy-on-select`, `keybind` and link opening built in **D** | ⚠️ no helpers; `selection-target=clipboard` gives select-to-copy **D** | ⚠️ no helpers; `selection.save_to_clipboard` gives select-to-copy **D** |
| 6 OSC 8 links + Ctrl+click on links/files | ✅ Ctrl+click via `links.conf` (`gio open`) **T** | ✅ Ctrl+click opens links; while pi has the mouse use Shift+Ctrl+click (pi docs) **D** | ⚠️ OSC 8 shown, but no mouse click: open with URL mode (Ctrl+Shift+O, then the hint key) **D**, and AGENTS.md notes Ctrl+click doesn't work in foot | ✅ OSC 8 supported (0.11+); opened through hints (default: Ctrl+Shift+U keyboard mode, or the hint mouse binding) **D** |
| 7 Inline images in pi | ✅ kitty graphics **T** (daily use) | ✅ kitty graphics protocol **D** | ❌ sixel only, pi doesn't speak sixel: images show as text placeholders **D** | ❌ no image protocol **D** |
| 8 Shift+Enter / Alt+Enter / SUPER keys in pi | ✅ (kitty keyboard protocol; pi.conf also sends CSI-u) **T** | ✅ kitty keyboard protocol; pi docs: map `alt+backspace` if needed **D** | ✅ kitty keyboard protocol (foot 1.13+) **D** | ✅ Shift+Enter reported; Alt+Enter may need a binding (pi docs) **D** |
| 9 OSC 52 copy (panels) | ✅ **T** | ✅ (clipboard-write allowed by default) **D** | ✅ **D** | ✅ **D** |
| 10 Synchronized output | ✅ **T** | ✅ **D** | ✅ **D** | ✅ (0.13+) **D** |
| 11 SGR mouse with Ctrl/Shift | ✅ (launchers unmap kitty's own Ctrl/Shift click actions) **T** | ⚠️ Ghostty takes Ctrl+click for links and Shift+click for selection unless mapped off **D** | ✅ passes Ctrl+click; Shift is its selection override **D** | ⚠️ Shift+click selects (override); Ctrl+click may be taken by hints **D** |
| 12 Emoji/ZWJ widths match `lib/tui/term.mjs` | ✅ **T** | ⚠️ mostly; some emoji sequences may differ by a cell **D** | ⚠️ grapheme-cluster mode (`+graphemes` build) differs in places **D** | ⚠️ no grapheme clustering: ZWJ emoji and flags draw wider **D** |
| 13 SUPER+C / SUPER+V (Omarchy) | ✅ `copy_or_noop` **T** | ⚠️ Ctrl+Insert copies Ghostty's selection; without one it isn't passed to pi unless bound **D** | ⚠️ needs a `[key-bindings]` entry to copy on Ctrl+Insert and pass it on otherwise **D** | ⚠️ Alacritty's defaults differ; binding needed **D** |
| 14 cwd of a focused terminal | ✅ **D** (code) | ✅ **D** (code) | ✅ **D** (code) | ✅ **D** (code) |
| 15 Nerd Font icons / emoji | ✅ **T** | ✅ **D** | ✅ **D** (font fallback list) | ✅ **D** |
| 16 No tabs | ✅ tab bar hidden with one tab **T** | ⚠️ GTK tabs exist (hidden with one window); Ctrl+Tab is Ghostty's **D** | ✅ no tabs **D** | ✅ no tabs **D** |
| Omarchy | installable (`omarchy-install-terminal kitty`) | installable | **Omarchy's default** (in its base packages) | installable |

**Others.** WezTerm works through `"terminalCommand"` (e.g. `["wezterm", "start", "--class", "{class}",
"--cwd", "{cwd}", "--"]`; turn on `enable_kitty_keyboard`, pi docs); it has kitty graphics and iTerm2
images, OSC 8, OSC 52 and sync output (**D**). Konsole, GNOME Console and xterm aren't in hyprpi's known
list; xfce4-terminal can't tell Shift+Enter from Enter (pi docs).

## Which terminals Omarchy supports

`omarchy-install-terminal` and `omarchy-default-terminal` take exactly **alacritty, foot, ghostty, kitty**
(`/usr/share/omarchy/bin/`). foot is the one in Omarchy's base package list (`install/omarchy-base.packages`);
the others are installed on demand. hyprpi's `"auto"` follows whichever is first in
`~/.config/xdg-terminals.list` and falls back to foot.

## Why kitty

Angus (2026-10-06): kitty "seems fast, supports icons and scrolling, and didn't have any weird tabs".
What the history shows (his sessions, 2026-09-25): agents had run in foot (Omarchy's default, and Herdr's
home); that day he tried Ghostty as his default terminal, then moved to kitty the same afternoon to get
**Ctrl+click on local files as well as URLs** ("I want to be able to click (or maybe ctrl+click) the exact
way I can with a URL link (in kitty), but for a local file"). foot can't open links with the mouse at all
(only its keyboard URL mode), which is the clearest reason foot was left. Everything since was built on
kitty: the `terminal-helpers/kitty` settings (2026-09-26), the four kitty panels with their key and mouse
maps (2026-09-25 → 10-01), and pi's inline images, which need the kitty graphics protocol (foot only has
sixel).

## To make another terminal first-class

1. Ghostty is the closest: kitty graphics, kitty keyboard protocol, OSC 8. Needs: no `--title` in
   `lib/terminal.mjs`, a `terminal-helpers/ghostty/` config (copy-on-select, Ctrl+Insert/Shift+Insert,
   Ctrl+Shift+A, mouse modifiers off), and Ghostty variants of the panel launchers.
2. foot / Alacritty: agents work as is; for parity, helper configs for select-to-copy and the Omarchy
   copy keys, and panel launchers. Inline images can't be had (no kitty graphics protocol).
3. Panel launchers could pick the terminal through `lib/terminal.mjs` instead of hard-coding `kitty`.
