# The Doorman bridge

A sandboxed agent asks for something on the host that no fixed request type covers ("set up X", "find this in my notes"). The Doorman drafts it, the owner approves it in the Doorman window (as is, or edited), and it becomes a host job. The bridge lets any host agent work that job: Claude Code, Codex, pi, or a script. The bridge is a CLI, `doorman-bridge`, plus an MCP server with the same operations.

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

- show gives only the owner's approved (possibly edited) text, the tools and folders he allowed, the time limit, and questions with their answers. It never gives the sandbox's own words, unless he approved them as they were.
- claim: one claimer. The lease (30 minutes by default, never past the job's time limit) runs out unless renewed; then the job is waiting again ("abandoned" in its history). A job with no report when its time limit is used up ends as no_report.
- ask: the question becomes a held item in the owner's Doorman window, and the job waits. Read his answer with show. Ask the owner nowhere else.
- report: done, failed or partial, a summary, and exactly what you ran (`--ran`) and changed (`--changed`). The relay records it, tells the agent that asked and its coordinator, and the Doorman's archive keeps it.
- propose: the change waits in the Doorman window. The owner approves it with 1, and the host applies it, only if nothing changed meanwhile.
- `--json` gives machine output. A claim's token is kept in `~/.cache/doorman-bridge` for its later commands.

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

## From anything else

Any harness that runs shell commands can use the CLI: `doorman-bridge list --json`, `claim`, `show`, `report`. Codex and other MCP clients use `doorman-bridge mcp` as a stdio server.

## How it works, and its limits

- The relay is the only writer of job records (`STATE/requests/<id>.json`). The bridge drops a request into `STATE/bridge/in` (host-only, 700), and the relay applies requests one at a time and writes the reply. That's why a claim is atomic.
- Everything runs as the owner's user on the host, and nothing in a sandbox can reach `STATE`. The protection is the user boundary: a hostile process running as the owner could write decision files directly, just as it could before the bridge.
- `DOORMAN_STATE` points the CLI and MCP server at another state folder.

## In pi-doorman (standalone)

pi-doorman ships the relay with the fixed request types, and agent-free (`host_agents: false`) by default. It also ships this bridge (the `docker/bridge/` files, generic, with no hyprpi names in the code) and this guide. The bridge stays off unless the owner sets `host_agents: "bridge"`. `settings` and `propose` call the host's own config commands, set with `DOORMAN_SETTINGS_CMD` and `DOORMAN_PROPOSE_CMD`. The bridge has no config writer of its own.
