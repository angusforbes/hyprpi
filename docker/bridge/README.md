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

## The operations

| CLI                      | MCP tool         | what it does            |
|--------------------------|------------------|-------------------------|
| list [--all]             | list_jobs        | jobs waiting for an agent |
| show ID                  | show_job         | approved text and limits |
| claim ID [--lease S]     | claim_job        | take it, with a lease   |
| renew ID                 | renew_job        | keep the claim          |
| ask ID TEXT              | ask_owner        | a question; the job waits |
| report ID STATE          | report_job       | done, failed or partial |
| release ID               | release_job      | give it back            |
| settings SANDBOX         | read_settings    | settings, read-only     |
| propose SANDBOX k=v      | propose_settings | wait for the owner's OK |

- show gives only the owner's approved text, the tools and folders he allowed, the time limit, and questions with their answers. It never gives the sandbox's own words, unless he approved them as they were.
- claim: one claimer. The lease (30 minutes by default, never past the job's time limit) runs out unless renewed; then the job is waiting again ("abandoned" in its history). A job with no report when its time limit is used up ends as no_report.
- ask: the question becomes a held item in the owner's Doorman window, and the job waits. Read his answer with show. Ask the owner nowhere else.
- report: done, failed or partial, a summary, and exactly what you ran (`--ran`) and changed (`--changed`). The relay records it, tells the agent that asked and its coordinator, and the Doorman's archive keeps it.
- propose: the change waits in the Doorman window. The owner approves it with 1, and the host applies it, only if nothing changed meanwhile.
- `--json` gives machine output. `claim` prints a token. Pass it with `--token` to renew, ask, report or release. There is no shared token cache, so one agent can't pick up another's claim by accident. The MCP server keeps the tokens of its own claims in memory, and a per-job run gets its own token in `DOORMAN_BRIDGE_TOKEN`. The tokens do live in host-only state (the job records, the bridge's request files, a run's 0600 MCP config), so a hostile process running as the owner could still read them. The boundary is the user account, as for the decision files.
- The job's action is stored as its own field (`approved.action_line`, taken from the Doorman's draft), never parsed out of the text, so a line inside the sandbox's "why" can't pose as the action.
- `settings` shows no key file paths. Anything key-, token- or secret-like is shown only as "(set)" or "(not set)".

## From Claude Code

```sh
claude -p "Work the Doorman bridge: list jobs, claim one, show it, do exactly what its approved text says and nothing more, then report what you ran and changed. Ask the owner only with ask_owner." \
  --mcp-config bridge-mcp.json --strict-mcp-config \
  --allowedTools "mcp__doorman-bridge__list_jobs,mcp__doorman-bridge__claim_job,mcp__doorman-bridge__show_job,mcp__doorman-bridge__renew_job,mcp__doorman-bridge__ask_owner,mcp__doorman-bridge__report_job,Read,Write" \
  --add-dir <the job's folders>
```

with `bridge-mcp.json`:

```json
{ "mcpServers": { "doorman-bridge": { "command": "/path/to/docker/bridge/doorman-bridge", "args": ["mcp"], "env": { "DOORMAN_BRIDGE_AGENT": "claude-code" } } } }
```

Give the agent only the tools and folders the job names (`show` lists them). For anything that writes, a throwaway sandbox or a separate user is stronger than tool flags.

## The per-job runner (a fresh Claude Code run for each job)

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
- Another agent: `DOORMAN_RUNNER_CMD` (a JSON argv prefix, default `["claude"]`) and `DOORMAN_RUNNER_MODEL`. The runner logs each run (the exact command, its exit and the job's state) to `STATE/bridge/runner.jsonl`.

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
