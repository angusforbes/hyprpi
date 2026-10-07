# Requirements

What hyprpi needs, and what's optional. The install itself is in the
[README](../README.md#install).

## The essentials

- **Linux with [Hyprland](https://hypr.land) 0.56+** and its **Lua config**
  (`~/.config/hypr/hyprland.lua`). hyprpi's keys and window rules are a Lua file
  ([hypr/hyprpi.lua](../hypr/hyprpi.lua)).
- **[pi](https://github.com/earendil-works/pi)** 1.0.x, the coding agent hyprpi runs in each window:
  `npm i -g @earendil-works/pi-coding-agent`, then run `pi` once and log in with `/login`.
  - Thoughts (each world's assistant) runs on `claude-opus-5-5` and the search panel's AI mode on
    `claude-haiku-4-5` by default. If you log in to another provider, set `thoughtsModel` and
    `searchModel` in `~/.config/hyprpi/config.json` to models you have (`pi --list-models` lists them).
- **Node.js 22 or newer** (the daemon, the CLI and the panels are plain Node, no npm install).
- **A terminal**: **kitty** is recommended (hyprpi's link handling, copy and keys are written for it);
  foot, alacritty and ghostty also work. What each one supports: [docs/terminals.md](terminals.md).
- **systemd --user**, only for the optional services (the MCP gateway and the phone app).
- Command-line tools: `jq`, `fd`, `wl-clipboard` (pasting screenshots), `libnotify` (`notify-send`),
  `libvips` (image thumbnails).

On Arch / Omarchy, in one line:

`sudo pacman -S --needed nodejs npm kitty jq fd wl-clipboard libnotify libvips`

## For the bar, the finder and the switcher

- **[Omarchy](https://omarchy.org)** with its Quickshell shell (`omarchy-shell`): the bar plugins
  (the SUPER+SHIFT+SPACE finder, the lapsed-login mark, the hyprwrlds worlds widget) and the
  hyprwrlds-vimarchy overview are Omarchy shell plugins. On plain Hyprland, skip them: agents, rooms,
  panels and Thoughts work without.

## Optional

- **[Tailscale](https://tailscale.com)**: to reach the phone app ([remote-control/](../remote-control/))
  from your phone over your tailnet.
- **MCP servers** behind the shared gateway ([mcp-gateway/](../mcp-gateway/README.md)).

## Optional companions (not in this repo)

hyprpi works without these; they're what its author runs alongside it.

- **[pi-twin](https://github.com/angusforbes/pi-twin)**: split / fork an agent's conversation into a
  second live agent (`/twin-split`, `/twin-fork`).
- **pi-jot** (not public yet): `/jot-note`, `/jot-idea`, … into a notes folder;
  Thoughts loads it when `jotExtension` in `config.json` points at it.
- **name-sync** (a pi extension): `/name` sets the pi session name and the hyprpi name together.
  Without it, use `hyprpi name NAME` (or the agent's `rename_self` tool).
- **bonk / ding**: small scripts that play a sound and show a toast when an agent needs you.
  hyprpi's own chime (an agent finished) works without them.
- **voice-agent**: push-to-talk dictation into agents or a world's Thoughts.
- **Skills** for agents: orchestrate, twins, recipe-fanout, recipe-build-verify (how to use
  hyprpi's `spawn_agent` / `wait_report` tools well).

Where a companion isn't public yet, its name is listed so you know what the references in
hyprpi's docs mean.
