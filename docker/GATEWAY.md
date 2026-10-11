# The gateway: one thing with a few named parts

A sandboxed agent can't reach the host. The gateway is how it asks for things anyway, with every decision made by the owner or by rules the owner set. It is ONE thing you install, check and configure with ONE command, `doorman`. Underneath it is a handful of separate processes (the relay stays small; heavy or risky work runs in contained workers).

`docker/doorman/doorman status` prints the parts and whether each is up. `doorman doctor` explains whatever is broken. `doorman install` sets up the units and timers. `doorman config` is where every setting lives.

## The named parts

| part | what it is | runs as |
| --- | --- | --- |
| relay | the small core: receives requests, applies the rules, holds items | hyprpi-sbx-relay |
| sandbox | the world the agents work in | sbx |
| Doorman | the talk-only agent that explains and drafts | hyprpi-doorman-NAME |
| window | where you read and decide held items | a terminal window |
| runner | starts one host agent per approved job | doorman-bridge-runner.path |
| host agents | Claude Code, Codex or Pi on the host, through the bridge | started by the runner |
| digests | an hourly and a daily summary | two systemd timers |
| phone decisions | deciding held items from the phone | part of the remote app |

The world helper and the folder-sharing watcher belong to a world with its own windows; `status` lists them as optional.

## The commands

`doorman status [WORLD]` one summary: mode, every part up or not, the host's levels, anything held, last errors. Exit code 1 if something is broken.

`doorman doctor [WORLD]` finds the broken pieces (a dead unit, a unit that points at a path that moved, a missing key file, two worlds files naming one sandbox, a setting outside the host's levels) and says how to fix each.

`doorman install [WORLD]` starts the relay and the Doorman, installs the runner (when host agents are on) and the digest timers. It is safe to repeat. `doorman start` and `doorman stop` start and stop the relay, the Doorman and the runner's path unit (the digest timers are a schedule, not a process: remove them with docker/research/digest-timer.sh stop). A step that fails makes the command exit 1.

`doorman config [WORLD]` shows every setting with its allowed range. `doorman config get KEY`, `doorman config set KEY VALUE` and `doorman config edit` change them, only from your own terminal (a process with an agent above it is refused). `doorman config levels` shows the host's levels; `doorman config levels set KEY VALUE` changes them.

`doorman host-agent-config` prints the lines that connect your own Claude Code or Codex to the bridge.

## One source for the settings

A world's settings live in one place: the `gateway` block of `~/.config/hyprpi/worlds/<world>.json`. Everything that sets a sandbox up reads it (the shares, the host card the sandbox sees, the reader's network, the Doorman's checks), and `doorman config` is the one tool to read and change it.

The host also decides which settings a world may use AT ALL, in `~/.config/hyprpi/gateway-levels.json`:

| key | meaning |
| --- | --- |
| modes | the modes a world may be set to (strict, safe, open, yolo) |
| max_share_level | the widest share level |
| phone_decisions | whether decisions from the phone may be turned on |
| runner_harnesses | the host agents the runner may start (claude-code, codex, pi) |

No file means everything is allowed, as before. The share cap applies to the mode too (a mode that implies a wider share level than max_share_level is not allowed) and to the folders actually shared. A setting or a proposal from a sandbox or host agent outside the levels is refused (not held for review), a mode in a hand-edited worlds file is clamped to the widest allowed mode below it (a stricter mode is never widened), and a broken levels file fails closed to the strictest. The sandbox's host card shows its current settings and the allowed range.

## Config files today, and their fate

| file | holds | fate |
| --- | --- | --- |
| worlds/WORLD.json | shares, roles, projects, ports, the gateway block, gpu, task | the source of truth for a world; edit through doorman config |
| gateway-levels.json | what the host allows (new) | the source for the allowed range; the host's settings and state folders are never shared into a sandbox |
| sbx-relay.json | the relay's sandboxes and Doorman entries (names, folders, key file, model, window, host_agents, bridge defaults) | stays: wiring, shown read-only by doorman config |
| config.json | host-wide: project folders, protected, role folders, thoughts model | stays |
| hyprpi.jsonc | routing, budgets and other hyprpi policy | stays; unrelated to the gateway |
| pi agent settings.json enabledModels | the one list of usable models | stays; the model checks read it |
| research.json | the old per-sandbox research settings | retired: read only as a fallback for report_model, replaced by the gateway block |
| doorman.mode and access in worlds files | the old mode and share level | deprecated: replaced by gateway.mode; still read |
| nv-inference-models.json | the template model list for a new sandboxed world | stays as the template; pi-models.mjs gives a sandbox only the models the host's scoped model list allows |
| systemd units | the relay, Doorman, runner and digests | generated by doorman install; never edit by hand |
| host card and network allowlist | what the sandbox is told | generated from the settings; never edit by hand |
| backup copies in the worlds folder | nothing | harmful: a copy naming the same sandbox makes the mode fail closed; doctor reports it, keep backups elsewhere |
