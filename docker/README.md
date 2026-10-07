# hyprpi · Docker agents (pi-sandbox)

Run a Pi agent **inside a Docker container** that still behaves like a hyprpi agent: it joins its room,
talks to other agents, reads and writes the board, gets its window in the panels (shown as
`pi·erb2 (🐳 docker) · B2 · …` in the agents panel), and is dropped when you close it.
Plans and the security design: [docs/sandbox-plan.md](../docs/sandbox-plan.md).

> ⚠️ Not yet a security boundary against hostile code: the container gets the main hyprpi socket,
> which can steer other agents as if it were Angus (see the plan). Use it for your own work and trusted
> sites until the sandbox socket exists.

## Files

- `Dockerfile.pi`: the `pi-sandbox` image. node:24-bookworm-slim + bash, git, ripgrep, procps, curl, wget,
  python3, jq, file, unzip + Pi (pinned: `PI_VERSION`, default 0.87.1). ~1.4 GB.
- `Dockerfile.pi-browser`: the `pi-browser` image, pi-sandbox + Playwright + headless Chromium (~2.85 GB).
  `/node_modules` links to the global modules, so `import { chromium } from "playwright"` works from any
  folder without an npm install, and the `playwright` CLI is on PATH.
- `run-hyprpi-agent.sh`: starts Pi in a container, wired to the host daemon.

Build (from this folder; pi-browser builds on pi-sandbox, and both need deb.debian.org):

`docker build -t pi-sandbox -f Dockerfile.pi .`

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
