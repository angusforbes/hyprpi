# voice-routing

Talk to your hyprpi agents. Press a key (or just say a phrase), speak, and the words arrive as a prompt for the agent you chose, or for the Thoughts of the world you're on, instead of being typed into whatever text field has focus. Transcription runs locally.

```
          you speak                     "send send send" / key press
   ┌─────────────────────┐                        │
   │  🎙 microphone      │  ── PipeWire ──►  voice-agent  ──►  hyprpi dictate / hyprpi send
   └─────────────────────┘                        │              (one per selected target)
              │                                   ▼
     Vosk (phrases only,             faster-whisper (GPU/CPU, resident)
     ~3 % CPU, always on)                    0.2 s per utterance
```

It began as a separate project for Herdr (herdr-voice-to-agents); since Herdr was retired it routes only to hyprpi, and it lives here. The core needs Linux, PipeWire and hyprpi. Hyprland bindings and an Omarchy bar widget are optional extras.

## Three ways to speak

| Mode         | Trigger            | Result              |
| ------------ | ------------------ | ------------------- |
| Push-to-talk | a key: voice-agent | press, speak, press |
| Hands-free   | say "on on on"     | until "off off off" |
| By an agent  | "voice to Torque"  | target changes      |

- Push-to-talk: the first press records; the second transcribes and delivers.
- Hands-free: "on on on" starts keeping audio, "send send send" delivers what you've said so far and keeps going, "off off off" delivers and stops. The always-on listener costs about 3 to 8 % of one core and writes no audio to disk until you say the start phrase.
- By an agent: ask any Pi agent "switch my voice to Torque" and its `voice_switch` tool (or `/voice-switch`) changes the target, no picker needed.

Ordinary dictation into text fields (for example voxtype on Caps Lock) is untouched; this is a separate channel.

### Targets

With no target set, dictation goes to the Thoughts of the world you're on, and a spoken addressee at the start ("Knock, …" or "project system, …") sends it to that agent or project instead (`hyprpi dictate`). You can also pick a set of agents in the picker or widget; each utterance then goes to all of them, each agent getting its own prompt (`hyprpi send`, which queues it as a follow-up, so a busy agent isn't interrupted).

The prompt says it was spoken:

```
🎤 Voice command (spoken; transcription may contain misheard words): <text>
(Focused window when spoken: chromium — GitHub - Chromium)
```

If a target can't be reached, the text is copied to the clipboard and a toast says so.

## Install

Prerequisites: hyprpi, `uv`, `jq`, `socat`, PipeWire (`pw-record`), a notification daemon (`notify-send`), and a working microphone. An NVIDIA GPU is optional (CPU works: about 3 s per utterance instead of 0.2 s).

`voice-routing/install.sh` (add `--no-gpu`, `--no-widget`, `--no-pi` as needed)

The installer links the scripts into `~/.local/bin`, the bar widget into `~/.config/omarchy/plugins` (on Omarchy) and the Pi extension into `~/.pi/agent/extensions`, all pointing into this checkout, so a `git pull` updates them; after moving the checkout, run it again to repoint the links. It keeps a Python venv and the Vosk model in `~/.local/share/voice-routing` (or `$VOICE_ROUTING_HOME`; an older `herdr-voice-to-agents` data folder is moved there) and writes two `systemd --user` units, installed but not enabled. Nothing listens until you turn it on.

Then bind keys: a Hyprland/Omarchy Lua example is in `hypr/bindings.lua`, plain `hyprland.conf` lines in `hypr/hyprland.conf.snippet`. Any compositor works; the commands are just `voice-agent` and `voice-agent target`.

Uninstall: `voice-routing/uninstall.sh` (`--purge` also removes the data folder and your phrase config).

## Using it

```
voice-agent                 push-to-talk toggle (bind this)
voice-agent target          pop-up picker: Thoughts, agents, hands-free switch, None
voice-agent set Torque      make Torque the only target (name, unique prefix, hp:<id>, 'me', 'none')
voice-agent add Hello       add a target        voice-agent remove Hello
voice-agent handsfree on    start the phrase listener + whisper server (off | toggle | status)
voice-agent autostart on    have hands-free come back at login (default: off)
voice-agent phrase send "go go go"   change a phrase (2+ words; the last words must differ)
voice-agent status          target(s), recording, hands-free
voice-agent list            every possible target, machine-readable
```

In a Pi agent (after `/reload`): `/voice-switch Torque`, `/voice-switch add Hello`, `/voice-switch handsfree off`, or plain language: "send my voice to Torque", "stop listening". The agent says why if it can't (unknown or ambiguous name, agent gone).

### Omarchy bar widget

A 🎤 in the bar: normal means push-to-talk ready, blue means hands-free listening, red means transcribing, crossed means nothing selected. Left-click opens the panel; right-click toggles hands-free. The panel has the hands-free switch, the target list (click, Enter or Space toggles a row; ↑↓ or j k move; F flips hands-free; Esc closes), editable phrases and the "on at login" switch. Rows highlight the instant you click and show ⏳ until the change is confirmed (reverting after 5 s if it isn't). Bind `omarchy-shell herdr.voice toggle` to open it from a key. The widget's id, `herdr.voice`, is kept from the Herdr days so existing bars and key bindings keep working.

## How it works

- `bin/voice-agent` (bash) is the whole control surface: recording (`pw-record`), transcription (the resident server over a Unix socket, else one-shot faster-whisper), targets and fan-out (`hyprpi list`, `hyprpi dictate`, `hyprpi send`), phrase config, service control, and a JSON `panel-state` for UIs. Everything else is a thin client of it, so keys, widget, picker, CLI and agents can't disagree. It finds hyprpi in its own checkout (`../bin/hyprpi`), else `$HYPRPI_BIN`, else on PATH.
- `bin/voice-agent-target` is the pop-up picker (Omarchy menu, else fuzzel, wofi or rofi). Its "New desktop agent" row opens a hyprpi agent with the desktop-control system prompt (`$VOICE_DESKTOP_PROMPT`, default `~/.pi/agent/desktop-control/SYSTEM.md`; the row is hidden when that file is missing).
- `bin/voice-listen` controls the listener and starts both services (`voice-listen run`, `voice-listen whisper`), finding the venv, the scripts and any pip CUDA libraries itself, so the units hold no machine paths.
- `listen/voice_listen.py` runs Vosk with a grammar of just your three phrases plus `[unk]`; that's what makes always-on cheap and false triggers rare. Word timestamps cut the audio before the phrase, so "send send send" never appears in the text (a regex strips it if it ever does).
- `listen/voice_whisper.py` keeps faster-whisper `small.en` loaded; `--once` is the cold fallback.
- `pi/voice-switch.ts` is the Pi extension with `/voice-switch` and the `voice_switch` tool; it only calls `voice-agent`.
- `omarchy-plugin/herdr.voice` is the bar widget, a view over `voice-agent panel-state`.

Why phrases rather than streaming: an agent that receives half a sentence starts answering half a sentence. Prompts are one-shot; the send phrase is the streaming primitive, and the resident whisper makes it feel instant.

## Troubleshooting

- Toast never appears (Omarchy): custom notification plugins may drop anything not from `omarchy-notification-send`'s default app name under Do Not Disturb; the scripts use that sender when present.
- Phrases don't trigger: check the level first. `voice-listen inject <16k-mono.wav>` feeds a file through the exact pipeline; `voice-listen log` shows what Vosk heard. Speak the three words evenly. Leading words get clipped after silence; matching is on the last word plus at least 3 of the last 4.
- Whisper server slow to start, or "libcublas not found": the unit sets `HF_HUB_OFFLINE=1` (otherwise `WhisperModel()` blocks on a Hub check), and `voice-listen whisper` adds the venv's pip CUDA libraries to `LD_LIBRARY_PATH`. Re-run `install.sh` if you added a GPU later.
- SUPER+SHIFT+Caps doesn't work: if keyd maps `capslock` back to real Caps Lock in a `[shift]` layer, Shift chords never yield F9. Use ALT.
- Extra Caps Lock chords (the picker on SUPER+CTRL+ALT+Caps and SUPER+SHIFT+ALT+Caps), learned 2026-09-22: modified chords must not reach Hyprland as `F9`. The bare-F9 voxtype press binding fires anyway (its fullscreen OSD grabs input), and holding a chord whose F9 binding opens a bar button can start the bar's press-and-hold drag (the bar jumps to another edge and snaps back with a shell reload, a black flash). Ctrl+Alt+F3 then Ctrl+Alt+F1 recovers a stuck seat. The working design has keyd composite layers emit F13 (see below). Composite layers need their constituent layers defined first (else they silently never match), and they strip their own modifiers, so Hyprland receives `SUPER + F13` only; xkb names keycode F13 `XF86Tools`, so bind `o.bind("SUPER + XF86Tools", …)`. A three-modifier layer `[meta+alt+shift]` crashed keyd 2.6.0 on reload, so check `systemctl is-active keyd` after every reload. Watch emitted keys with `sudo keyd monitor` (`keyd do` bypasses remaps and is useless for this).
- Two utterances a second apart merged into one turn: known; a per-target settle delay is on the list.

The keyd layers for the extra chords:

```
[alt]
[control]
[control+alt]
capslock = f13
[alt+shift]
capslock = f13
```

## Ideas

- The target picker is really a generic "pick a live hyprpi agent" menu. It could become an `agent-pick` helper that prints the chosen id, with `voice-agent target` one caller among others: choosing where a pasted screenshot goes, routing typed text, jumping to an agent's window, picking a review or handoff recipient. Not started.
- A bar indicator for non-Omarchy desktops; a wake phrase to start a session by voice.
