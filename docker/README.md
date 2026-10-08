# hyprpi · Docker agents (pi-sandbox)

Run a Pi agent **inside a Docker container** that still behaves like a hyprpi agent: it joins its room,
talks to other agents, reads and writes the board, gets its window in the panels (shown as
`pi·erb2 (🐳 docker) · B2 · …` in the agents panel), and is dropped when you close it.
The sandbox plans and security design are kept privately.

> ⚠️ Not strong isolation: the container gets the main hyprpi socket, which can steer other agents.
> Trusted workloads only for now.

## Files

- `Dockerfile.pi`: the `pi-sandbox` image. node:24-bookworm-slim + bash, git, ripgrep, procps, curl, wget,
  python3, jq, file, unzip + Pi (pinned: `PI_VERSION`, default 0.87.1). ~1.4 GB.
- `Dockerfile.pi-browser`: the `pi-browser` image, pi-sandbox + Playwright + headless Chromium (~2.85 GB).
  `/node_modules` links to the global modules, so `import { chromium } from "playwright"` works from any
  folder without an npm install, and the `playwright` CLI is on PATH.
- `run-hyprpi-agent.sh`: starts Pi in a container, wired to the host daemon.

Build (from this folder; pi-browser builds on pi-sandbox, and both need deb.debian.org):

`docker build -t pi-sandbox -f Dockerfile.pi .` (the pi version comes from `PI_VERSION` next to it, the same pin hyprpi's installer uses)

`docker build -t pi-browser -f Dockerfile.pi-browser .`

## Running an agent

Run the script from the folder the agent may work in (only that folder is mounted read-write):

`AGENT_ID=hp-mybox WS=12 ~/Work/hyprpi/docker/run-hyprpi-agent.sh --model claude-opus-5-5`

In its own hyprpi window, without moving you (here on workspace 12):

`hyprctl dispatch "hl.dsp.exec_cmd('env AGENT_ID=hp-mybox WS=12 kitty --class hyprpi.agent -d /path/to/project /path/to/hyprpi/docker/run-hyprpi-agent.sh', { workspace = '12 silent' })"`

Options (environment variables):

| Variable | Effect |
|---|---|
| `AGENT_ID` | hyprpi agent id (default `hp-dockertest`) |
| `WS` | workspace for its first room (default 11); the room then follows the window |
| `TOOLS=web,nim` | also load web search/fetch (pi-web-access) and the NVIDIA NIM tools: code mounted read-only, `web-search.json` and `NVIDIA_API_KEY` passed in (the container can read the key) |
| `BROWSER=1` | the pi-browser image, with `--shm-size=1g --init` |

What goes in: the Anthropic **access token** only (`ANTHROPIC_OAUTH_TOKEN`; never auth.json or the refresh
token, since a container refreshing a rotated token could sign the host out; it works until the token expires,
a few hours), the hyprpi socket folder (read-write), this hyprpi checkout (read-only, for the extension), and
the current folder at the same path (so `file:///` links work). It runs as your uid with a throwaway
HOME (`/tmp/home`): no host settings, extensions, sessions, SSH keys or mise toolchains. Its session is lost
when the container ends; have it write anything worth keeping into the mounted folder first.

## pi-sbx sandboxes: the drop-box relay (J244)

A Docker Sandboxes (`sbx` / `pi-sbx`) sandbox can't reach anything on the laptop: NVIDIA's policy blocks localhost, and local exceptions are refused. It does share its workspace folder with the host. So `sbx-relay.mjs` gives each sandbox a drop-box in its workspace (`.hyprpi-dropbox/outbox/` and `inbox/`, with a README for the agent) and carries a small allowlist of requests to hyprpi as that sandbox's own agent: post or read its own room, talk (to anyone but another relay sandbox it waits for Angus's approval), and reply to messages it received. It never gives a sandbox the daemon socket and never acts as Angus.

- Config: `~/.config/hyprpi/sbx-relay.json`, e.g. `{"sandboxes":[{"name":"sbxprobe","workspace":"~/Work/sbx-probe","inbox":"~/Work/sbx-inbox/sbxprobe","workspace_num":61,"container":"pi-sbx:developer"}]}` (`workspace_num` 61 = world G's first workspace). The `inbox` is a host-only folder outside the workspace, mounted read-only into the sandbox, so nothing in the sandbox can forge an incoming message; the relay refuses to run without it.
- A resident agent (J259): `docker/sbx-agent.sh [SANDBOX]` opens a kitty window on the sandbox's workspace running Pi inside the sandbox (`sbx exec -it … pi`), mounts the inbox read-only, and refreshes the in-sandbox extension `docker/sbx-dropbox-ext.ts`. That extension turns incoming messages into prompts (batched, at most 30 automatic turns an hour), gives Pi the tools `hyprpi_room_post`, `hyprpi_room_read`, `hyprpi_talk` and `hyprpi_reply`, and reports working / idle to the agents panel. The sandbox needs Pi and a model key inside it first (Docker Sandboxes can't inject keys for model hosts under NVIDIA's profiles).
- After a reboot (no autostart yet): `docker/sbx-relay.mjs start`, then `docker/sbx-agent.sh`. Stop: `/quit` in the agent's window, then `docker/sbx-relay.mjs stop`.
- Start / stop / status: `docker/sbx-relay.mjs start`, `docker/sbx-relay.mjs stop`, `docker/sbx-relay.mjs status` (a systemd user unit, `hyprpi-sbx-relay`, with memory and CPU limits).
- Approvals: `docker/sbx-relay.mjs pending`, then `docker/sbx-relay.mjs approve ID` or `deny ID`. A held message shows a desktop notification and a one-line notice in the sandbox's room, without its text.
- Log: `~/.local/state/hyprpi/sbx-relay/log.jsonl` (metadata and a hash of each message; `"log_text": true` in the config keeps the text).
- Security: reviewed by a second model family (J244); the drop-box folders are pinned as file descriptors so a sandbox can't swap them for symlinks to host files, every request is size- and rate-limited, and sandbox text is stripped of control characters and quoted line by line.

## How hyprpi handles it (daemon and extension)

- **Window**: Pi in a container reports pid 1 and hangs off containerd-shim, so the usual walk UP from its
  pid to a window finds nothing. The daemon then searches DOWN from `hyprpi.agent` windows for a process whose
  environment has `HYPRPI_AGENT_ID=<id>` (the script exports it to the `docker` client). The match is cached
  as `hostPid` and also used for liveness (resume after a daemon restart, drop on close, ^K^K kill).
- **Marker**: the script sets `HYPRPI_CONTAINER=docker:<image> +<tools>`, which the extension sends in
  `agent.hello`; the daemon also infers `docker` when it found the window through a docker/podman client.
- **No second daemon**: `HYPRPI_NO_ENSURE=1` stops the extension from running `hyprpi ensure` inside the
  container (it would start a daemon on the shared socket without access to Hyprland; reproduced once).

## Tested (2026-09-29)

In containers against the live daemon: rooms, board, talk/demand both ways, interactive TUI, window
mapping, following a window move, drop on stop, resume detection across a daemon restart; with
`TOOLS=web,nim`: web search (Exa), fetch (Wikipedia, docs, GitHub repo, arXiv PDF, image, 404, raw JSON,
answer mode), FLUX; with `BROWSER=1`: `playwright screenshot` and a Playwright script saving PNG + PDF.
Known limits, none from Docker: fetch_content's readable mode rejects pages under 500 characters of text
(same on the host; raw mode works), Exa's free tier refuses bursts (HTTP 429), YouTube needs a Gemini key.

Not available inside: host-integrated extensions (hyprcu, WhatsApp, mail, voice, pi-jot/Obsidian,
name-sync), `ding`/`bonk`, subagents, MCP, SSH/`gh` credentials, GPU (needs the NVIDIA Container Toolkit and
`--gpus all`; not installed).
