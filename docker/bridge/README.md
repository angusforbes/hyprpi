# The Doorman bridge

A sandboxed agent asks for something on the host that no fixed request type covers ("set up X", "find this in my notes"). The Doorman drafts it, the owner approves it in the Doorman window, and it becomes a host job. (A free-form draft can't be edited before approval today; the job carries the text he approved.) The bridge lets any host agent work that job: Claude Code, Codex, pi, or a script. The bridge is a CLI, `doorman-bridge`, plus an MCP server with the same operations.

The bridge can't approve, deny or edit anything, create jobs or change settings. The owner decides in the Doorman window, and the relay applies the decisions. The sandbox never uses the bridge; it only asks, through the Doorman.

## Turning it on

In `~/.config/hyprpi/sbx-relay.json`, on the Doorman's entry:

```json
{ "name": "doorman-g", "doorman_for": "world-g", "host_agents": "bridge",
  "bridge": { "tools": ["Read", "Write"], "folders": ["~/Work/cube-art"], "time_limit_s": 3600 } }
```

- `host_agents: "bridge"`: approved free-form drafts become host jobs instead of going to a hyprpi Thoughts agent. `false` means no free-form drafts at all.
- `bridge`: the default tools, folders and time limit printed with each job, to start the agent narrowly.
- Restart the relay to start the bridge.

## Who is there: registration (J407)

The relay only knows a host agent exists if it registers. A host agent registers with a name, its harness, a one-line capability summary and optionally the sandboxes it serves, then heartbeats at least every 30 s; one that stops for 120 s expires. Registration grants nothing new: it only lets the agent claim jobs (the bridge's existing powers) and tells the relay and the sandbox that someone is there.

| CLI                                 | MCP tool         | what it does              |
|-------------------------------------|------------------|---------------------------|
| register NAME --harness H           | register_agent   | register; get a token     |
| heartbeat --agent-token T           | (automatic)      | stay alive                |
| unregister --agent-token T          | unregister_agent | leave                     |
| agents                              | list_agents      | who is there, read-only   |
| receipts [--by NAME]                | read_receipts    | decisions on proposals    |

- The MCP server keeps its agent token in memory, heartbeats every 30 s while it runs, and unregisters when its client closes it. `claim_job` refuses until the registration is done (automatic with `DOORMAN_BRIDGE_AGENT` set, J424; otherwise `register_agent`). A claim is always made in the registered name.
- The per-job runner registers for the length of each run (on demand). While its path unit is installed it counts as an available agent.
- Per sandbox the relay is then in one of two modes. Host agent available: a free-form request the Doorman drafts is held for the owner as before, and the held item says "Will be done by: <name> (<harness>)". Agent-free (nobody registered, no runner): a free-form request is refused at once with "no host agent available" and never held; the fixed request types, research, GPU leases and task changes still work. The sandbox's host card has a "Host agents" line saying which, refreshed when it changes.
- A claim from an unregistered or expired agent is refused. Only a Doorman entry with `"host_agents": "bridge"` uses any of this; world G's bridge is off.

## The operations

| CLI                      | MCP tool         | what it does            |
|--------------------------|------------------|-------------------------|
| list [--all]             | list_jobs        | jobs waiting for an agent |
| show ID                  | show_job         | approved text and limits |
| claim ID --agent-token T | claim_job        | take it, with a lease   |
| renew ID                 | renew_job        | keep the claim          |
| ask ID TEXT              | ask_owner        | a question; the job waits |
| report ID STATE          | report_job       | done, failed or partial |
| release ID               | release_job      | give it back            |
| wait [--timeout S]       | wait_for_job     | block until work comes  |
| settings SANDBOX         | read_settings    | settings, read-only     |
| propose SANDBOX k=v      | propose_settings | wait for the owner's OK |

- show gives only the owner's approved text, the tools and folders he allowed, the time limit, and questions with their answers. It never gives the sandbox's own words, unless he approved them as they were.
- claim: one claimer. The lease (30 minutes by default, never past the job's time limit) runs out unless renewed; then the job is waiting again ("abandoned" in its history). A job with no report when its time limit is used up ends as no_report.
- ask: the question becomes a held item in the owner's Doorman window, and the job waits. Read his answer with show. Ask the owner nowhere else.
- report: done, failed or partial, a summary, and exactly what you ran (`--ran`) and changed (`--changed`). The relay records it, tells the agent that asked and its coordinator, and the Doorman's archive keeps it.
- propose: the change waits in the Doorman window. The owner approves it with 1, and the host applies it, only if nothing changed meanwhile.
- `--json` gives machine output. `claim` prints a token. Pass it with `--token` to renew, ask, report or release. There is no shared token cache, so one agent can't pick up another's claim by accident. The MCP server keeps the tokens of its own claims in memory, and a per-job run gets its own token in `DOORMAN_BRIDGE_TOKEN`. The tokens do live in host-only state (the job records, the bridge's request files, a run's 0600 MCP config), so a hostile process running as the owner could still read them. The boundary is the user account, as for the decision files.
- The job's action is stored as its own field (`approved.action_line`, taken from the Doorman's draft), never parsed out of the text, so a line inside the sandbox's "why" can't pose as the action.
- wait (J431): blocks until a job in the agent's scope is waiting (event job), the owner answers a question on one of its own jobs (event answer; the CLI takes `--mine ID`), or the timeout passes (event none: call again). The timeout defaults to 240 s and is at most 290 s, below Claude Code's limits (a stdio MCP call may be idle 30 min; `MCP_TOOL_TIMEOUT` is the hard limit). Codex stops an MCP call after 60 s by default (`tool_timeout_sec`): pass `timeout_s` 50 there, or raise it. `DOORMAN_BRIDGE_WAIT_S` changes the default. The registration keeps heartbeating while it waits (CLI: with `--agent-token`). It only reads, like list and show, so it grants nothing. Jobs still being scoped (scoping, scope_held) aren't waiting, so they don't wake it. An answer wakes it only for a question that session asked, on a job it still holds (a lapsed claim another agent took is no longer "yours"). In the MCP server "once" holds for the session; the CLI is one call, so pass `--seen ID#N` (and `--by NAME` to require that you still hold the claim). A claim that fails because another agent was first says so; any other failure (not registered, relay down) tells the agent to stop and tell the user, and that job isn't offered to that session again. The wait runs alongside other requests, so renew/report/ping are never held up behind it.
- wait and the per-job runner: first claim wins. When the runner is installed it usually wins: its path unit claims within about a second of the record appearing, while a waiting agent first gets the job back and then has its model call `claim_job`. That claim then fails cleanly, and the agent waits again. A waiting agent takes the jobs the runner doesn't (runner not installed, or the job out of the runner's reach).
- `settings` shows no key file paths. Anything key-, token- or secret-like is shown only as "(set)" or "(not set)".

## Self-describing (J424): only the MCP config

A host agent needs only the MCP config; no long first prompt.

- The initialize result carries the rules as MCP `instructions`: register, list/claim/show, do only what's approved, ask_owner when unsure, report_job.
- With `DOORMAN_BRIDGE_AGENT` set in the server's `env`, the server registers the agent itself on connect, heartbeats, and unregisters when the client closes it.
  - Harness: `DOORMAN_BRIDGE_HARNESS`, else the client's own name from initialize (Claude Code says claude-code).
  - Optional: `DOORMAN_BRIDGE_SCOPE` (comma-separated sandboxes) and `DOORMAN_BRIDGE_CAPS` (one line).
  - These are cleaned to letters, digits and a few separators.
  - Without the variable nothing is automatic, and `register_agent` works as before.
- The MCP prompt `check` does the waiting jobs (list, claim, show, do it, report), then keeps watching with `wait_for_job` until stopped (J431): one check, no more nudging. In Claude Code it's the slash command `/mcp__doorman-bridge__check`.
- A per-job run (`DOORMAN_BRIDGE_JOB`) gets none of this: the runner registers and prompts it.
- `skill/doorman-bridge/SKILL.md` holds the same rules as a skill, for clients that don't show MCP instructions; pi passes only one line of them. It works as a Claude Code skill or a pi project skill (`.pi/skills/`).
- Registering still grants nothing new.
- Tests: `docker/bridge/test-self-describing-steps.sh` (isolated); `test-claude-check-steps.sh`, `test-claude-wait-steps.sh` (J431: two jobs a minute apart after one check) and `test-pi-check-steps.sh` (manual, real agents); `test/bridge-wait.mjs` (isolated).

## From Claude Code

```sh
claude -p "Work the Doorman bridge: list jobs, claim one, show it, do exactly what its approved text says and nothing more, then report what you ran and changed. Ask the owner only with ask_owner." \
  --mcp-config bridge-mcp.json --strict-mcp-config \
  --allowedTools "mcp__doorman-bridge__list_jobs,mcp__doorman-bridge__claim_job,mcp__doorman-bridge__show_job,mcp__doorman-bridge__renew_job,mcp__doorman-bridge__ask_owner,mcp__doorman-bridge__report_job,Read,Write" \
  --add-dir <the job's folders>
```

with `bridge-mcp.json`:

```json
{ "mcpServers": { "doorman-bridge": { "command": "/path/to/docker/bridge/doorman-bridge", "args": ["mcp"], "env": { "DOORMAN_BRIDGE_AGENT": "Doorman-Host" } } } }
```

Give the agent only the tools and folders the job names (`show` lists them). For anything that writes, a throwaway sandbox or a separate user is stronger than tool flags.

## The per-job runner (a fresh agent run for each job)

Instead of a long-running agent, the bridge can start one fresh, narrowly scoped run per approved job:

- `doorman-bridge runner --install` installs a systemd path unit that watches the job records. Whenever one changes, `doorman-bridge dispatch` starts `doorman-bridge run-job ID` for each waiting job, each in its own transient unit. Nothing runs between jobs, and two jobs get two runs. `--uninstall` and `--status` do the rest. It's off unless installed, and it only finds jobs once a Doorman has `host_agents: "bridge"`.
- `run-job` claims the job and starts the agent with only what the job allows. In a live test, the command was:

```
claude -p --output-format text --no-session-persistence --restricted --strict-mcp-config --mcp-config <temp>/mcp.json --tools Write --allowedTools mcp__doorman-bridge__list_jobs,mcp__doorman-bridge__show_job,mcp__doorman-bridge__renew_job,mcp__doorman-bridge__ask_owner,mcp__doorman-bridge__report_job,Write --permission-mode dontAsk --add-dir <the job's folder>
```

  - The bridge MCP is its only MCP server.
  - `--tools` holds exactly the job's built-in tools; it's empty if the job names none.
  - `--add-dir` holds exactly the job's folders.
  - No session is kept, and `--restricted` ignores the owner's own Claude settings and hooks.
  - The agent can't claim, release or touch settings.
  - The prompt arrives on stdin. It's the owner's approved text, marked as the task, plus any questions already answered.
- A question: the agent calls `ask_owner` and stops. The runner gives the claim back, so the job waits for the owner ("asked"). His answer puts the job back to waiting, and the path unit starts a new run, which sees the question and the answer.
- Failures:
  - A run that ends without a report is reported failed, with its last output.
  - A run that reaches 15 s before the job's time limit is stopped and reported failed.
  - If the runner itself dies, its unit ends and systemd stops the agent. The claim lapses, and the relay records the job as abandoned, or as no_report once the time limit is used up.
- Which agent: per world, see "Harness per world" below. `DOORMAN_RUNNER_CMD` (a JSON argv prefix) still overrides the claude-code command, and `DOORMAN_RUNNER_MODEL` is the default model. The runner logs each run (the harness, the exact command, the limits it can't enforce, its exit and the job's state) to `STATE/bridge/runner.jsonl`.

### Harness per world (J425)

The runner can start Claude Code, Codex or pi. Each world chooses in `~/.config/hyprpi/worlds/<w>.json`: `"gateway": { "host_runner": "codex" }`, or `{ "harness": "pi", "command": ["/path/to/pi"], "model": "provider/id" }`. The default is claude-code. Only Angus sets it: in the file, or with `research.mjs config-set host_runner=pi`. A sandbox can't propose it. An unknown harness or a bad command makes the runner unavailable for that world (fail closed): a free-form request is refused at once, and a job already waiting is reported failed.

| Limit           | claude-code | codex    | pi        |
| --------------- | ----------- | -------- | --------- |
| Tool list       | enforced    | advisory | enforced  |
| Writes, folders | if no Bash  | enforced | advisory  |
| Reads, folders  | if no Bash  | advisory | advisory  |
| Read-only dirs  | if no Bash  | enforced | advisory  |
| Hidden paths    | if no Bash  | advisory | advisory  |
| Network         | per tools   | off      | per tools |
| Only bridge MCP | yes         | yes      | yes       |
| No session kept | yes         | yes      | yes       |

- claude-code: `claude -p --restricted --strict-mcp-config --tools … --add-dir … --permission-mode dontAsk`, as before. `--restricted` and `--add-dir` confine its file tools only: a granted Bash (even a rule like `Bash(git status)`) runs outside them, so a job with Bash is labelled "limits advisory" (J425Review, confirmed with a forced Bash call).
- codex: `codex exec --ephemeral --ignore-user-config --ignore-rules --disable apps` with its OS sandbox: `read-only`, or `workspace-write` only when the job grants a writing tool and names folders. Writes are limited to those folders (`/tmp` excluded), and the network is off for its commands; its own web search tool is disabled too. The bridge is its only MCP server, with just the five job tools, pre-approved. Codex always has a shell, so the tool list is only read-only versus writing, and reads aren't limited.
- pi: `pi -p --no-session --no-skills --no-context-files --no-approve` with a private agent dir (`PI_CODING_AGENT_DIR`) whose only MCP server is the bridge. Your auth.json and models.json are symlinked in, so a token refresh writes through. `--tools` lists the bridge tools plus the job's tools mapped to pi's (Read→read, Write→write, Edit→edit, Bash→bash, Grep→grep, Glob→find, LS→ls). That is enforced: tested, bash is absent unless granted. pi has no sandbox, though, so once a file or shell tool is granted it reaches anything you can.
- J428's job scope (read-only folders, the sandbox's hidden paths) is worked out once (harness.mjs jobScope) and each adapter enforces what it can. claude-code: deny rules, as J428. codex: only read-and-write folders are writable, and one that overlaps a read-only folder (holds one, or sits inside one) is read-only for codex; hidden paths can't be hidden from it. pi: neither. The held item's runner line is judged with that draft's own tools and folders. A world-level line (the host card, `runner --install` / `--status`) can't know the draft, so it is judged with a draft's default tools (Read, Glob, Grep, Write, Edit over the shares), plus any tools a Doorman entry's old `bridge` defaults name, and says so. A worlds file that can't be read or parsed shows as ERROR there (it blocks every world's runner). A `model` in the setting must be a model id: false, 0, null or an empty string are refused.
- A tool an adapter can't express is dropped, never widened: a rule-scoped tool such as `Bash(git status)` on codex or pi, or a tool pi lacks (WebFetch).
- Where limits are advisory, the prompt tells the agent to keep to them. The held item and the host card say so: "the per-job runner (on demand): pi (limits advisory: …)". `runner --install` and `--status` list each world's harness, with WARNING for advisory and ERROR for invalid settings.
- The token reaches only the bridge MCP server, through a private 0700 wrapper script (codex, pi) or a 0600 config (claude-code): not the agent's own environment, argv or the log (anything the agent prints is redacted before it's logged or reported).
- A harness that isn't installed, or a worlds file that can't be read, makes the runner unavailable for that world, like an invalid setting.
- Tests: `node test/bridge-harness.mjs` (offline: settings, limits, argv, fail-closed cases, and a real `run-job` per harness with a stub agent); `node test/bridge-harness-codex-mock.mjs` (offline, the real codex binary against a localhost mock provider that forces writes: inside, outside, /tmp, a project `.codex` config, and read-only folders nested either way: proves codex's enforcement); `node test/bridge-harness-live.mjs` (manual, costs model calls: the real binaries do a job, plus a smoke probe that asks for a write outside the job's folder; an inconclusive probe fails).
- A read-and-write folder that overlaps a read-only one (either way) is not writable for codex, and unreadable worlds config (a file whose sandbox can't be known, the worlds folder, a non-object file or gateway) or a host levels module that is present but broken makes the runner unavailable.

## From anything else

Any harness that runs shell commands can use the CLI: `doorman-bridge list --json`, `claim`, `show`, `report`. Codex and other MCP clients use `doorman-bridge mcp` as a stdio server.

## How it works, and its limits

- The relay is the only writer of job records (`STATE/requests/<id>.json`). The bridge drops a request into `STATE/bridge/in` (host-only, 700), and the relay applies requests one at a time and writes the reply. That's why a claim is atomic.
- Everything runs as the owner's user on the host, and nothing in a sandbox can reach `STATE`. The protection is the user boundary: a hostile process running as the owner could write decision files directly, just as it could before the bridge.
- `DOORMAN_STATE` points the CLI and MCP server at another state folder.
- Job ids are `<sandbox>--<6 hex digits>` (the relay's held-item ids, e.g. `doorman-g--3b0f5e`). The relay makes them. A hand-made test record with another name is skipped by `list`, with a note on stderr.

## Sharing a project from an approved request (share_project)

When the owner approves sharing a project, the request carries the folder's real path and inode as shown to him. `addProject` refuses a folder that no longer matches. The entry then keeps that identity, and every plan checks it again, so a folder swapped after it was added is skipped and never mounted. One small window remains: a swap between the plan's check and the sbx mount itself, a few milliseconds later. Closing it would need sbx to mount a pinned directory.

## In pi-doorman (standalone)

pi-doorman ships the relay with the fixed request types, and agent-free (`host_agents: false`) by default. It also ships this bridge (the `docker/bridge/` files, generic, with no hyprpi names in the code) and this guide. The bridge stays off unless the owner sets `host_agents: "bridge"`. `settings` and `propose` call the host's own config commands, set with `DOORMAN_SETTINGS_CMD` and `DOORMAN_PROPOSE_CMD`. The bridge has no config writer of its own.


## The host-job test for world G (J432)

`node docker/bridge/host-job-test.mjs` runs the whole route as a test and prints PASS or FAIL per hop: it checks the setup (relay, Doorman-G, a host agent available, nothing else held, a fresh test file name, Alpha live in G), prompts Alpha to ask the Doorman for a host request that only a host agent can do (a new file in `~/Documents/doorman-g-jobs`, which is not shared into G), and then waits for Angus's 1 in the Doorman-G window. After the 1 it confirms: the request was held for the bridge, approved, claimed (by the per-job runner when it is installed; it claims within a second, so a Doorman-Host window gets nothing), the job done, the file on the host with the exact text, G's gate delivered the outcome to Alpha as a visible message, and Alpha answered it. It decides nothing. `--no-send` prints the prompt instead of sending it; `--wait N` sets the seconds to wait for the 1. `--check-alpha JOBID` is read-only: it tells whether an earlier job's outcome reached Alpha's session.
