# Terminals for hyprpi

**Bottom line:** use **kitty**; everything is built and tested on it. **Ghostty** is the realistic
alternative (needs a title fix, a helper config and panel launchers); **foot** and **Alacritty** run
agents fine but without pi's inline images, and the panels don't open in them.

## Summary

| Feature | kitty | Ghostty | foot | Alacritty | WezTerm |
|---|:-:|:-:|:-:|:-:|:-:|
| Agents run (class, own process) | ✅ᵗ | ✅ᵗ | ✅ᵗ | ✅ᵗ | ⚠️ |
| Panels open | ✅ᵗ | ❌ | ❌ | ❌ | ❌ |
| Inline images in pi | ✅ᵗ | ✅ | ❌ | ❌ | ✅ |
| Ctrl+click file links | ✅ᵗ | ✅ | ❌ | ⚠️ | ✅ |
| pi's window title | ✅ᵗ | ⚠️ | ✅ | ✅ | ✅ |
| Shift+Enter / Alt+Enter in pi | ✅ᵗ | ✅ | ✅ | ⚠️ | ⚠️ |
| SUPER+C / select-to-copy helpers | ✅ᵗ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Panel mouse (Ctrl/Shift+click) | ✅ᵗ | ⚠️ | ✅ | ⚠️ | ⚠️ |
| Emoji widths match the panels | ✅ᵗ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| No tabs in the way | ✅ᵗ | ⚠️ | ✅ | ✅ | ⚠️ |

✅ works · ⚠️ works differently or needs setup (see below) · ❌ doesn't · ᵗ tested here; the rest is from
the terminal's or pi's docs (pi: `docs/terminal-setup.md`) and hyprpi's code. Checked 2026-10-06 with
kitty 0.48.2, Ghostty 1.3.1, foot 1.28.0, Alacritty 0.17.0 (WezTerm not installed).

Choose the terminal with `"terminal"` in `~/.config/hyprpi/config.json`: `"auto"` (default: Omarchy's
default terminal via `xdg-terminal-exec`, else foot), `"kitty"`, `"ghostty"`, `"foot"`, `"alacritty"`, or any
other with `"terminalCommand"` (`lib/terminal.mjs`).

## Feature notes

**Agents run.** Every agent window gets class / app-id `hyprpi.agent` (panels `hyprpi.agents`,
`hyprpi.mockup`, `hyprpi.summon`) for the Hyprland rules (`hypr/hyprpi.lua`), the daemon and the
switcher. Each must be its own process: the daemon finds an agent's window by walking up from pi's
pid (`lib/hypr.mjs` `windowForPid`).
- kitty `--class`, foot `--app-id` (plain `foot`, never `footclient`), Alacritty `--class`, Ghostty
  `--class` plus `--gtk-single-instance=false` (hyprpi passes it). Tested: all four launched with
  hyprpi's own arguments, got the class and their own process.
- WezTerm: only through `"terminalCommand"`, e.g. `["wezterm", "start", "--class", "{class}", "--cwd", "{cwd}", "--"]`.

**Panels open.** The agents, Stream, search and projects panels and the summon fallback pop-up are
started by kitty-only scripts (`mockups/agents-tui`, `room-tui`, `search-tui`, `board-tui`, `summon`):
`kitty --class … -o …` with key maps (`ctrl+insert copy_or_noop`, `send_text` for Ctrl+Tab), mouse maps
(Ctrl+click grabbed) and `confirm_os_window_close=0`.
- Other terminals would need their own launchers (Ghostty `--keybind`, foot `--override`, Alacritty
  `-o`; Alacritty has no `copy_or_noop` equivalent), or the launchers could pick the terminal through
  `lib/terminal.mjs`.

**Inline images.** pi draws images with the kitty graphics protocol or the iTerm2 protocol
(`PI_IMAGE_PROTOCOL`, setting `terminal.images`), not sixel.
- kitty, Ghostty, WezTerm: yes. foot: sixel only, so images show as text placeholders. Alacritty: no
  image protocol.

**Ctrl+click file links.** pi renders Markdown links and `<file:///…>` as OSC 8 hyperlinks; agents are
told to write file links that way. The panels draw and handle their own links (`lib/tui/markdown.mjs`).
- kitty: `terminal-helpers/kitty/links.conf` opens links and files with Ctrl+click via `gio open`
  (tested daily).
- Ghostty: Ctrl+click opens links; while pi has the mouse, use Shift+Ctrl+click (pi docs).
- foot: shows OSC 8 but has no mouse opening; use its URL mode (Ctrl+Shift+O, then the hint key).
- Alacritty: OSC 8 supported (0.11+), opened through hints (default Ctrl+Shift+U keyboard mode, or the
  hint mouse binding).
- Ctrl+click on an **agent's name**: works in the panels (all kitty). In agent windows it's a kitty
  kitten (`terminal-helpers/kitty/agentclick.py`), built but switched off.

**pi's window title.** pi's extension sets `π - <name> - <folder>` (OSC 2). kitty is started without
`--title` because it would pin the title; the others get `--title pi` as a start value.
- Ghostty: `--title` pins the title, so pi's title may not show; drop `--title` for Ghostty.
- foot: `--title` is only the start value. Alacritty: fine while `window.dynamic_title` is on (default).

**Shift+Enter / Alt+Enter in pi.** pi needs the kitty keyboard protocol or CSI-u for these and for
SUPER bindings. kitty's `pi.conf` also sends Shift+Enter / Alt+Shift+Enter as CSI-u.
- Ghostty and foot (1.13+) speak the kitty keyboard protocol; pi's docs suggest mapping
  `alt+backspace` in Ghostty if needed.
- Alacritty reports Shift+Enter; Alt+Enter may need a binding (pi docs).
- WezTerm: set `enable_kitty_keyboard = true` (pi docs).

**SUPER+C / select-to-copy helpers.** Omarchy sends Ctrl+Insert / Shift+Insert for SUPER+C / SUPER+V to
windows tagged `terminal` (hyprpi tags its classes). kitty's `pi.conf` uses `copy_or_noop` (copy
kitty's selection, else pass the key to pi's own selection), `copy_on_select`, and passes Ctrl+Shift+A
to pi. No helper folder exists for other terminals yet (`terminal-helpers/<terminal>/`).
- Ghostty: Ctrl+Insert copies its selection, but isn't passed to pi without one unless bound;
  `copy-on-select` exists.
- foot: needs a `[key-bindings]` entry for Ctrl+Insert; `selection-target=clipboard` gives
  select-to-copy.
- Alacritty: needs a binding; `selection.save_to_clipboard` gives select-to-copy.
- Panels copy with OSC 52 (falling back to `wl-copy`): all five terminals support OSC 52.

**Panel mouse.** All panels use SGR mouse reports with Ctrl/Shift modifiers (click, Ctrl+click to jump
or open, wheel). kitty's launchers unmap kitty's own Ctrl/Shift click actions.
- Ghostty takes Ctrl+click (links) and Shift+click (selection) unless mapped off.
- foot passes Ctrl+click; Shift is its selection override.
- Alacritty: Shift+click selects; Ctrl+click may be taken by hints.

**Emoji widths.** `lib/tui/term.mjs` measures emoji, ZWJ sequences and variation selectors the way
**kitty** draws them; elsewhere some emoji may be a cell wider or narrower, shifting panel columns.
- Ghostty: mostly the same. foot: its grapheme-cluster mode differs in places. Alacritty: no grapheme
  clustering, so ZWJ emoji and flags draw wider.

**No tabs.** One agent per window; the panels use Ctrl+Tab for switching worlds.
- kitty hides its tab bar with one tab. Ghostty has GTK tabs (hidden with one window) and uses Ctrl+Tab
  itself. foot and Alacritty have no tabs.

**Also the same everywhere:**
- Synchronized output (DEC 2026, the panels draw each frame at once): all five (Alacritty 0.13+).
- `cwdFromFocused` reads a focused terminal's folder from `/proc` and knows kitty, foot, alacritty,
  ghostty, wezterm and others (`lib/apps.mjs`).
- Nerd Font icons and emoji: a font matter; Omarchy ships a Nerd Font for all its terminals.
- hyprpi doesn't use kitty remote control (`kitten @`); only Omarchy's `omarchy-cmd-terminal-cwd` does.

**Others.** Konsole, GNOME Console and xterm aren't in hyprpi's known list (use `"terminalCommand"`);
xfce4-terminal can't tell Shift+Enter from Enter (pi docs).

## Omarchy

`omarchy-install-terminal` and `omarchy-default-terminal` take exactly **alacritty, foot, ghostty and
kitty** (`/usr/share/omarchy/bin/`). foot is in Omarchy's base packages (`install/omarchy-base.packages`),
so it's the default; the others are installed on demand. hyprpi's `"auto"` follows the first entry of
`~/.config/xdg-terminals.list` and falls back to foot.

## Why kitty

- Angus (2026-10-06): kitty "seems fast, supports icons and scrolling, and didn't have any weird tabs".
- History (his sessions, 2026-09-25): agents ran in foot (Omarchy's default, and Herdr's home). He tried
  Ghostty as his default terminal that afternoon, then moved to kitty the same day to get **Ctrl+click
  on local files as well as URLs**. foot can't open links with the mouse at all, the clearest reason it
  was left.
- Everything since was built on kitty: `terminal-helpers/kitty` (09-26), the four kitty panels with their
  key and mouse maps (09-25 to 10-01), and pi's inline images, which need the kitty graphics protocol
  (foot only has sixel).

## To make another terminal first-class

1. **Ghostty** is closest (kitty graphics, kitty keyboard protocol, OSC 8). It needs no `--title` in
   `lib/terminal.mjs`, a `terminal-helpers/ghostty/` config (copy-on-select, Ctrl+Insert / Shift+Insert,
   Ctrl+Shift+A, mouse modifiers off) and Ghostty versions of the panel launchers.
2. **foot / Alacritty:** agents work as they are. For parity: helper configs for select-to-copy and
   Omarchy's copy keys, and panel launchers. Inline images can't be had.
3. The panel launchers could pick the terminal through `lib/terminal.mjs` instead of hard-coding kitty.
