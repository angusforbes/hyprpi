# hyprpi terminal helpers: kitty

Settings that make kitty a good home for Pi agents. hyprpi opens kitty agent windows with
**your own `kitty.conf` first and then `pi.conf`** (`kitty --config <yours> --config pi.conf`),
so these apply to agent windows and override yours only there. `"terminalHelpers": false` in
`~/.config/hyprpi/config.json` turns them off. Other terminals get nothing yet
(`terminal-helpers/<terminal>/` is where their equivalents would go).

| File | What |
|---|---|
| `pi.conf` | Agent windows only: select-to-copy; SUPER+C copies Pi's own selection (Ctrl+Insert passes through when kitty has none, for Pi's `editor-select` extension); Ctrl+Shift+A reaches Pi (select-all) instead of starting kitty's opacity shortcuts; Shift+Enter and Alt+Shift+Enter as CSI-u. Includes `links.conf`. |
| `links.conf` | Ctrl+click opens links and local files with the system default app; plain clicks never open anything. |

To have Ctrl+click in **every** kitty window too, add this to `~/.config/kitty/kitty.conf`:

`include ~/Work/hyprpi/terminal-helpers/kitty/links.conf`

Reload kitty afterwards (Ctrl+Shift+F5, or `pkill -USR1 -x kitty`). Agent windows that were
already open keep the settings they were started with until they are reopened.

## Why it is set up this way

- **`xdg-open` silently "fails" on text files.** The default for `text/plain` is `nvim.desktop`
  (`Terminal=true`). `xdg-open` launches it with no terminal, so nvim runs invisibly in the
  background. Each click leaves an orphan nvim holding a swap file (we found ~30).
  **`gio open` honours `Terminal=true`** by running the app through `xdg-terminal-exec`, so every
  file type opens with its real system default: txt → nvim in kitty, md → omawrite, png → imv,
  pdf → Evince. Don't use `open-actions.conf` to force types into nvim: that overrides the
  system defaults.
- **Always-underlined vs hover-only.** `underline_hyperlinks always` only applies to real OSC 8
  hyperlinks (Pi's rendered links, `eza --hyperlink`, …). Plain text that looks like a URL is only
  detected under the mouse, so it underlines on hover. Bare paths (`/home/...`) are never
  clickable as plain text.
- **Pi:** in kitty, Pi renders Markdown links and `<file:///...>` autolinks as OSC 8 links (blue,
  Ctrl+clickable). Bare `file:///...` text is not autolinked (bare `https://` is), so agents should
  write `[label](file:///abs/path)` or `<file:///abs/path>`.
- **Ctrl+Shift+A:** kitty's defaults use it as the first key of `kitty_mod+a>m/l/1/d` (background
  opacity), so kitty waited for a second key and the first press never reached Pi. A single-key
  `send_key` mapping defined after those sequences wins.
- **SUPER+C:** Omarchy sends Ctrl+Insert to terminals (windows tagged `terminal`; hyprpi's
  `hypr/hyprpi.lua` tags agent windows). `copy_or_noop` copies kitty's own selection if there is
  one and otherwise passes the key to Pi, whose editor has its own selection.
- **Testing:** `kitty @ send-text` into a window running Pi types into Pi's prompt. Use a separate
  test window instead, e.g. `setsid -f kitty --hold --title link-test sh -c 'ls --hyperlink=always'`.
