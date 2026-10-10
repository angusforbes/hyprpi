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

- Config: `~/.config/hyprpi/sbx-relay.json`, e.g. `{"sandboxes":[{"name":"my-box","workspace":"~/Work/my-box","inbox":"~/Work/sbx-inbox/my-box","workspace_num":61,"container":"pi-sbx:developer"}]}` (`workspace_num` 61 = world G's first workspace). The `inbox` is a host-only folder outside the workspace, mounted read-only into the sandbox, so nothing in the sandbox can forge an incoming message; the relay refuses to run without it.
- A resident agent (J259): `docker/sbx-agent.sh [SANDBOX]` opens a kitty window on the sandbox's workspace running Pi inside the sandbox (`sbx exec -it … pi`), mounts the inbox read-only, and refreshes the in-sandbox extension `docker/sbx-dropbox-ext.ts`. That extension turns incoming messages into prompts (batched, at most 30 automatic turns an hour), gives Pi the tools `hyprpi_room_post`, `hyprpi_room_read`, `hyprpi_talk` and `hyprpi_reply`, and reports working / idle to the agents panel. The sandbox needs Pi and a model key inside it first (Docker Sandboxes can't inject keys for model hosts under NVIDIA's profiles).
- After a reboot (no autostart yet): `docker/sbx-relay.mjs start`, then `docker/sbx-agent.sh`. Stop: `/quit` in the agent's window, then `docker/sbx-relay.mjs stop`.
- Start / stop / status: `docker/sbx-relay.mjs start`, `docker/sbx-relay.mjs stop`, `docker/sbx-relay.mjs status` (a systemd user unit, `hyprpi-sbx-relay`, with memory and CPU limits).
- Approvals (J412 keys, the same in the Doorman window and the Thoughts panel): 1 approve, "1 text" approve and tell the asker the text, 1+ approve and allow similar for 1 h ("1+ 2h": 5 min to 8 h; plain messages to a peer only), 2 deny: the item always goes back to the asker with why it was held ("2 text" adds Angus's text; a denied research plan may carry a suggested plan from the Doorman, checked, never sent). On a host agent's question, "1 text" is the answer and 2 declines. CLI: `docker/sbx-relay.mjs pending`, then `approve ID [--note TEXT] [--allow-similar 2h]` or `deny ID [--reason TEXT]` (the old allow / return / answer commands and the edit are gone). The relay applies the same limits to a raw decision file: a 1+ on anything but a plain message, or a note over 500 characters, decides nothing (the item stays held). An allow-similar rule made before J412 lives at most 8 h from when it was made. Rules pause only while a denied MESSAGE is open (J370b); a "2" on a research plan links the asker's next plan or held result to it but pauses no message rule. A held message shows a desktop notification and a one-line notice in the sandbox's room, without its text.
- Log: `~/.local/state/hyprpi/sbx-relay/log.jsonl` (metadata and a hash of each message; `"log_text": true` in the config keeps the text).
- Security: reviewed by a second model family (J244); the drop-box folders are pinned as file descriptors so a sandbox can't swap them for symlinks to host files, every request is size- and rate-limited, and sandbox text is stripped of control characters and quoted line by line.

## A sandboxed world (J262): world G

World G is a whole hyprpi world inside ONE Docker Sandboxes sandbox (`world-g`): its own hyprpi daemon, agents, panels and Thoughts-G run inside and work together normally. Their windows are host kitty windows on G's workspaces (61–69). The only links to the host: a window helper for G's own windows, and the drop-box relay to the other worlds (messages out of G wait for Angus's approval).

- Inside the sandbox, `hyprctl` and `kitty` are stand-ins (`docker/world/bin/`) that ask the host's window helper (`docker/world/world-helper.mjs`) through a drop-box; the helper only sees and touches G's windows, only on G's workspaces, from a small allowlist of window operations. New windows run `sbx exec -it world-g …/g-run TOKEN` (the command itself stays inside the sandbox), with a locked-down kitty config (`sandbox-kitty.conf`) and an output filter (`g-filter.py`) so the sandbox can't reach the host through the terminal (no clipboard, links, graphics file reads or host shells).
- `docker/world/g-gate.mjs` inside the sandbox is G's gateway agent "Outside": "Name: text" to Outside goes to agent Name in another world (held for approval); messages from other worlds to "world-g" starting "Name: " reach that G agent, anything else reaches Thoughts-G.
- Config: `~/.config/hyprpi/worlds/world-g.json` (sandbox, workspace, host-only inbox, workspace range) and a `world-g` entry in `~/.config/hyprpi/sbx-relay.json`. Inside the sandbox: Pi and a model key in `~/.pi/agent`, `~/.config/hyprpi/config.json` (Pi, models), and read-only mounts of this checkout and the two host-only inboxes.
- No host Thoughts for G (J267): a `~/.config/hyprpi/worlds/<name>.json` marks its world as sandboxed on the HOST (the world is the room of its first workspace in `workspaces`, or `"world": "G"`; the relay agent is `"relayAgent"`, else `"sandbox"`). For that world the host daemon never starts, resumes or refreshes a Thoughts. Talks and asks to `Thoughts-G` from host agents and other worlds' Thoughts go to the relay agent (`world-g`) as `Thoughts-G: …`, so the gate hands them to G's real Thoughts-G, and its answer comes back as a normal reply (they fail with a clear reason when the relay isn't connected). The host Thoughts panel for G and the phone say so and point to G's own panel; Angus's host room-G posts go to the room's agents (the relay ones) instead of a Thoughts; host board care and tinker routing skip G (G's board lives inside the sandbox). `hyprpi list` shows `Thoughts-G  in its sandbox`. Remove the file (or the world) to undo.
- Models (J405): a sandboxed world's agents choose from its own `~/.pi/agent/models.json` (provider `nv-inference`, NVIDIA Inference Hub) and `enabledModels`. `docker/world/nv-inference-models.json` is the standard list (32 OpenAI + 12 Claude models, each tested under a full agent prompt; Claude through `openai-completions`); `node docker/world/pi-models.mjs SANDBOX [--dry-run]` merges it into a sandbox (adds what's missing, keeps the key, backups `*.bak-J405-*`). Run it once for a new sandboxed world after its key is in.
- Start (manual, after a reboot): `docker/world/world.sh start`, then `docker/world/world.sh new NAME` for each agent. Stop: `docker/world/world.sh stop`. Status: `docker/world/world.sh status`.
- Approving a held message is Angus's: click the toast (a terminal asks y/n) or run `docker/sbx-relay.mjs approve ID` in his own terminal; an agent's approve is refused (accident prevention, not authentication).

## The Doorman (J308): one talk-only agent per sandbox

A sandbox's agents can ask their Doorman about the host: why a domain is blocked, whether a folder is shared, what to do instead. It answers only from that sandbox's host card, and it drafts requests for Angus when something needs the owner.

- It runs in its own tiny Docker Sandboxes sandbox under the `external-plus-inference` policy profile (the model API only; everything else answers 403). Its only shares: the host card folder (read-only, at `/home/agent/.sandbox`, the same folder the served sandbox gets), its relay inbox (read-only) and an empty drop-box folder. Pi runs headless (RPC mode) with the tools `read`, `hyprpi_reply`, `hyprpi_talk`, `hyprpi_draft_request`, `hyprpi_gpu_lease` and `hyprpi_task_change`. Each question arrives with the card's current text (`docker/sbx-dropbox-ext.ts`, `HYPRPI_DOORMAN=1`); its prompt is `docker/doorman/doorman-prompt.md`.
- No memory (J373, J395; Angus's choice "c"): the Doorman remembers nothing between messages, so its behaviour never depends on how long it has been running or on who asked before. `docker/doorman/doorman-rpc.mjs` runs its pi and starts a new pi session after every turn (fail closed: a refused, cancelled or unconfirmed reset ends pi so the unit restarts it; the extension also exits if no fresh session comes within 30 s of a settled turn). The extension hands each session exactly ONE message (later ones wait unread for the next session) and sends it as a user turn, so the Doorman's rules (system prompt) are in every call; pi 1.0 sends an empty system prompt for a custom-message first turn. A call sees its rules, the host card (with the task) and that one message, nothing else: no earlier exchange from the same or any other agent (J395 removed J373's per-asker history, which one agent of a sandbox could read by claiming another's "[Name, in world G]" label). Receipts are never put in front of the Doorman; the asking agent hears every outcome from the relay itself (`tellOutcome`: a draft approved (where it went, or that it reached nobody or couldn't be sent), denied with Angus's reason, or an edit that couldn't be applied; task changes; typed requests; anything that expires undecided after 24 h), and Thoughts-G gets the same line; GPU lease notices (`gpuTell`) go to the named asker, or as one coordinator line when no agent is named. The asker is the agent whose message the Doorman was answering: the extension adds `about` (that message's request_id) to what it drafts, and the relay takes the asker from that message's "[Name, in world G]" signature, not from the `for` the model wrote. A host agent's answer to an approved draft goes straight to the asker (the relay keeps that link in memory for 24 h; after a relay restart the answer reaches the Doorman instead). J370's re-plan was always its own stateless research call (the original plan plus Angus's note). Each message leaves one session file in the Doorman sandbox (the newest 300 are kept). Tests: `node docker/doorman/test-stateless.mjs` (real pi + the extension against a local fake model: every call is [system, one message], nothing earlier, the tools, a retried turn, a cancelled reset), `node docker/doorman/test-rpc.mjs` (the controller fails closed), `E2E_STEPS=docker/doorman/test-outcomes-steps.sh bash docker/gateway/e2e.sh` (the asker hears each outcome, bound to its message; no history anywhere), `node docker/doorman/test-outcomes-unit.mjs` (delivery told honestly, answers to the asker, expiry) and `node docker/doorman/test-replan-context.mjs`.
- The relay enforces the limits, not the prompt. Only its own sandbox reaches it, and it reaches only that sandbox (any other pair with a Doorman is refused, never held). It has no room tools. Messages from host agents or room posts are dropped; only its sandbox and the Thoughts it reports to get through. Its `draft` (with for, why, tried and action) is held for Angus as a talk to that Thoughts: a toast plus the review in that world's Thoughts panel. It's approved once and never as an allow-similar rule. After 3 denied drafts in a row its drafts are refused for an hour (a circuit breaker, in memory).
- Config: an entry in `~/.config/hyprpi/sbx-relay.json` with `doorman_for` (the sandbox it serves), `reports_to` (default `Thoughts-A`), `display` (its name, e.g. `Doorman-G`), `workspace` (the empty drop-box folder), `inbox`, `card`, `model` (default `nv-claude/azure/anthropic/claude-opus-5-5`, an OpenAI-compatible model on NVIDIA's Inference Hub) and `key_file`.
- What it shows (J327, J412): follows the served sandbox's mode (the old `"visibility"` key is ignored). `strict`: headless, nothing recorded outside the journal. `safe` and `yolo`: headless, plus `~/.local/state/hyprpi/doormen/NAME/status.json` (state, last question and answer, for a status row) and `events.jsonl`. `open`: a live kitty window (`doorman-view.mjs view NAME --write`) on `"visibility_workspace"` (default 68) where Angus decides each held item by typing; nothing else can be typed there. There is no read-only observer window any more.
- Setup: add the entry, restart the relay with nothing held, then `docker/doorman/doorman.sh create NAME` and `docker/doorman/doorman.sh start NAME` (a systemd user unit, `hyprpi-doorman-NAME`). Also `stop`, `status` and `rm`. Pi is copied from the served sandbox, since the Doorman can't reach npm. The model key sits inside its sandbox, as for the served one (the same open gap).
- Asking it from inside world G: talk to Outside with `Doorman-G: <question>`. The gate sends it on, it's never held, and the answer comes back as a reply.

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

## GPU lease (J328): DEVELOPER MODE, not an approved route for work data

A sandboxed world can ask for a GPU job; the host runs it in a throwaway worker after Angus approves it. The approved sandbox (sbx) has no GPU (v0.47), so the worker is a plain Docker container with the GPU through the NVIDIA Container Toolkit (CDI). That shares the host's kernel and driver and is outside the approved route, which is why the setting is called developer. Design, limits and later levels: agent-config `docs/sandbox/doorman-design.md`, section 13.

- Setting, per sandbox, in `~/.config/hyprpi/worlds/<name>.json`: `"gpu": "developer"` or `"gpu": "off"` (or `{"mode": "developer", "max_seconds": 120, "max_vram_mib": 2048, "image": "python:3.12-slim"}`). Missing means developer for now; it should become off for new users before any public release. Off (or anything unreadable) refuses with a clear message and asks nothing of the owner. J412: the mode dial decides held / auto / refused for a lease (strict refused, safe and open held, yolo auto), but `"gpu": "off"` stays an explicit per-sandbox kill switch on top of the dial: off is refused in every mode, yolo included, and the card says so.
- Flow: the world's agent asks its Doorman, the Doorman drafts the lease (`hyprpi_gpu_lease`, relay op `gpu_lease`), the relay snapshots the job's files and holds it for Angus ("GPU lease for world-g", marked developer mode), and on approval `docker/gpu/gpu.mjs` runs it: no network, no shared folders (files are copied in), the GPU through CDI, a time limit (also enforced by a timer inside the worker), and a VRAM budget and scratch-disk cap that are watchdogs (polled about every half second, killed when seen over; not hard caps). Outputs and the log come back to the sandbox's read-only inbox; the worker is destroyed.
- Setup: `sudo pacman -S --needed nvidia-container-toolkit` then `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`, and `docker pull python:3.12-slim`. Check: `node docker/gpu/gpu.mjs check world-g`.
- Test: `node docker/gpu/e2e-isolated.mjs` (an isolated daemon and relay that cannot reach the live session; tiny jobs only, a 256 MiB allocation).

## Research (J309): web research for a sandbox, reviewed by Angus

A sandbox's agent asks Outside `Research: <what I'm looking for>` (or `Research (deep): …`). The request goes to the sandbox's Doorman, never to the web:
- The Doorman writes its own public searches (a stateless call to its model inside its sandbox; `docker/research/check.py`).
- A host check refuses searches that copy G's wording, rare words or internal-looking text (`planCheck` in `docker/research/research.mjs`).
- A quarantined reader sandbox (`reader-<world>`, profile `external-plus-inference`, no shares) runs them with Perplexity Sonar on NVIDIA Inference Hub, or sonar-deep-research for deep asks, and shapes the result into what was asked for (`docker/research/reader.py`).
- The Doorman vets the deliverable.

The relay (`op: "research"`) then holds the finished deliverable as one message for Angus: a toast, plus the Thoughts review showing the request, the searches that went out and the whole deliverable (also a Markdown file). Approving puts it in the sandbox's read-only inbox as `research-<id>.md`; the asker is told where.

- Setup: `node docker/research/research.mjs reader create --sandbox world-g` (once). The Doorman sandbox must exist (`docker/doorman/doorman.sh create doorman-g`).
- Optional config: `~/.config/hyprpi/research.json` (doorman, reader, reports_to, key_file, shape_model per sandbox).
- The one dial (J412, replaces J325 modes, J327 visibility and J366 level), per sandbox in `~/.config/hyprpi/worlds/<name>.json` as `"gateway": { "mode": "strict" | "safe" | "open" | "yolo" }`, read per request (no restart). Default `safe`; anything unknown, or two worlds files naming one sandbox, is `strict`. The active mode shows in the host card's "Web research" section, the inner guide, the review and deliverable headers and the digest. `node docker/research/research.mjs mode --sandbox NAME` prints it. Design and the full table: `~/Obsidian/Papers/Doorman/simplification-spec.md`.

  | mode   | plans          | results         | shares                     | window  |
  |--------|----------------|-----------------|----------------------------|---------|
  | strict | held           | reviewed        | listed, read-only          | none    |
  | safe   | sent           | reviewed        | listed, ro unless rw       | status  |
  | open   | sent, never held | reviewed      | all projects writable      | decides |
  | yolo   | sent           | NOT reviewed    | all projects writable      | status  |

  - strict: everything waits for Angus; allow_host, GPU leases and free-form requests are refused. Off-task, no-task and drifting plans are held.
  - safe (default): searches go out; Angus reviews results and what leaves the sandbox; off-task plans are held as exceptions.
  - open (developer): plans are never held (off-task plans go out flagged in the digest); Angus reviews research summaries and everything that leaves the sandbox, in the Doorman window.
  - yolo: TESTING ONLY. No review at all: every kind goes ahead after its code checks and is logged (`reviewed:false`), results arrive labelled "NOT reviewed", one digest line a day goes to Thoughts. Changing the sandbox's own mode stays held for Angus. Exact word only.
  - The old values still read: `doorman-strict` is strict, `doorman-safe` is safe, `doorman-open` (no review) is yolo, `"research": {"strict": true}` is strict, a Doorman in developer visibility with no mode reads as open; each prints a note. `"access"` / `"gateway.level"` still win for the share level (deprecated).
- Task-bound research (J352, from the J349 red team): Angus sets what the sandbox works on in `~/.config/hyprpi/worlds/<name>.json` as `"task": "…"` (one sentence, at most 300 characters; `node docker/research/research.mjs task --sandbox world-g [--set TEXT | --clear]`). The sandbox never sets it.
  - The Doorman writes the searches toward the task's purpose and says whether the request serves the task (on_task) and whether the sandbox's recent requests jump between unrelated subjects (drift).
  - Off-task, drifting or no-task requests are held for Angus as exceptions in strict and safe (in open and yolo they go out flagged) ("Off-task research for <sandbox>: approve?", with the task beside the searches); a missing verdict counts as off-task. More than 3 such holds an hour per sandbox are refused.
  - The task shows in the host card's Web research section, the inner guide, and the plan and deliverable headers.
  - The Doorman can draft a task change (tool hyprpi_task_change → relay op task_change); only Angus's approval writes it, and only if the task hasn't changed since the draft.
- Numbers (J352, docker/research/numbers.mjs): a number of 3 or more digits from the request may not appear in a search in any written form: digits, digit groups, English number words (standard, year-style pairs, digit by digit) or Roman numerals. Years are no longer exempt; numbers the task names are allowed.
- Searches must be plain text (no markup or links) in every mode (J352 review): any plan may end up in front of Angus.
- Limits: 10 quick and 3 deep requests an hour, 2 running at once, 1000 bytes per request.
- `node docker/research/research.mjs digest [--send]` sums up the last hour for the reporting Thoughts.
  - The hourly timer is a permanent systemd user unit pair (~/.config/systemd/user, enabled): `docker/research/digest-timer.sh` installs it from this checkout (re-run after moving the checkout or changing node); `stop` removes it.
- Tests: `node docker/research/test-research.mjs`.


## The research gateway's settings (J372)

One block per sandbox in `~/.config/hyprpi/worlds/<name>.json`, every key optional (the older keys `doorman.mode`, `access` and research.json `shape_model` still work; the block wins; the share level follows `mode` now):

```json
"gateway": {
  "search": { "provider": "sonar", "quick_model": "perplexity/perplexity/sonar", "deep_model": "perplexity/perplexity/sonar-deep-research", "key_file": "~/.config/<secrets>/<search-api-key>" },
  "report_model": "azure/openai/gpt-6-sol",
  "doorman_model": "azure/anthropic/claude-opus-5-5",
  "mode": "safe"
}
```

- `search.provider`: `sonar` (default: Perplexity Sonar through NVIDIA Inference Hub) or `brave` (Brave Search API: results only; the report model writes the report; needs `search.key_file`). Adapters live in docker/research/reader.py (`PROVIDERS`); to add one, add a function and an entry in docker/research/gateway.mjs `SEARCH_PROVIDERS` with the host it needs.
- The reader sandbox may reach a provider's host only while that provider is selected: `research.mjs reader network [--apply]` shows or sets it (`sbx policy allow/rm network --sandbox <reader> <host>`, never global). `config-set` and an approved proposal run it for you.
- `doorman_model` is the model for the Doorman's research checks (plan, vet), on the same Inference Hub account. The Doorman's CHAT session model is set when its sandbox is created (`model` in sbx-relay.json); the window visibility is `visibility` there. Both are shown, not changed, here.
- Every host check is the same whichever provider or model is chosen: cleaning, J360 links, the number and copy checks, the Doorman's vet.
- What is in effect: `node docker/research/research.mjs config --sandbox world-g` (`--json` for programs); the Doorman window shows it as a dim line under its header.
- Who changes settings: only Angus. By editing the file, or `node docker/research/research.mjs config-set --sandbox world-g report_model=... mode=...`, which needs a real terminal and refuses under any agent ancestor (docker/agent-guard.mjs, shared with the relay's approve command). A host agent can only PROPOSE: `node docker/sbx-relay.mjs propose-gateway world-g --by NAME --changes '{"report_model":"..."}'` creates a held item in the Doorman window showing current → proposed; on Angus's 1 the relay applies exactly that (digest-checked, only if the values are still what was shown). `search.key_file` can't be proposed. Tests: docker/research/test-gateway.mjs.
