# Agent resource snapshot

`hyprpi top` is a Linux-only view of agent activity on the machine where it runs: every hyprpi agent by world, plus the other coding agents running here (plain pi, Claude Code, Codex, Gemini CLI, aider and the like). It connects to the existing hyprpi daemon; it does not start it. `--once` and `--json` only report. The live view (J564) can also act on the highlighted row, and only after you confirm: focus its window, or close it.

## Run it

`hyprpi top`

`hyprpi top --once`

`hyprpi top --once --json`

`hyprpi top --sort priority`

`hyprpi top --json --samples 10 --interval 2`

Live refresh defaults to two seconds. Without a terminal, or with JSON, the default is one snapshot; --samples requests a bounded sequence (JSON Lines with --json). CPU counters are primed for half a second before the first output. --interval accepts 0.5–60 seconds. All agents remain grouped by world; sorting applies within each world.

Keys: up/down or j/k move the highlight through the rows of all worlds; PgUp/PgDn move a page, Home/End to the first and last row; left/right pan across the wide table; c CPU, m memory, u uptime, p priority sort within each world; Enter focuses the highlighted agent's window; x or Delete closes it after a y/N confirm; q, Escape or Ctrl+C quit. The highlight stays on the same agent across refreshes and re-sorts; if that agent disappears it moves to the nearest row and says so. The normal terminal screen and cursor are restored on exit. Nothing takes desktop focus except Enter.

## Acting on a row (J564)

- Enter: a hyprpi agent's window is focused through the daemon (as `hyprpi focus` does, remote worlds included); another CLI's terminal window is found from its process (the nearest terminal ancestor) and focused. A Thoughts agent has no window of its own.
- x or Delete: the footer asks "Close NAME (world X)? [y/N]" and lists warnings: running briefs, owned projects, live helpers, working right now. y closes it; anything else cancels and nothing happens.
  - A hyprpi agent is closed the way a person would close it: its window is closed (no window: SIGTERM to its own pi). The daemon records that as a deliberate close; top waits until the daemon no longer lists it and says how it went.
  - An Other agents row (a CLI that isn't a hyprpi agent) gets SIGTERM on exactly the processes of its tree as shown when you confirmed. If any are still running a few seconds later, a second confirm offers SIGKILL for those exact processes.
  - Thoughts agents, sandboxed world G's processes and remote world H/I agents aren't closed from top: the footer says where to do it instead.
- Safety: the target is fixed when you press x (its agent id, and every pid with its start time); a refresh or re-sort during the confirm can't change what is closed. Before any signal each pid's start time is checked again, so a pid that was reused by another process is never touched. There are no name or pattern kills, and top never signals itself, pid 1 or any process it didn't show in that row.

## Other agents

Processes of coding-agent CLIs that aren't hyprpi agents are grouped by their CLI process into rows in the "Other agents" section (JSON: world "Unattributed", with tool, cwd, terminal and terminalPid). A CLI is recognised by its executable or CLI script only: pi; claude (Claude Code), codex (including its native per-platform binary), gemini, aider, opencode, goose, cursor-agent, amp, crush, qwen; or node/bun/python running one of their package entry points; or a launcher script with that exact name. A wrapper and the binary it starts are one row. Never a substring of the command line: `bash -c claude`, `vim claude.md` or `claudette` are not agents. Each row shows the tree's CPU, RSS, uptime and process count, and in JOB / TOPIC its working folder and terminal. Its session or model isn't read.

## Read the numbers

- CPU% is an interval measurement of process CPU time, including attributed descendants. 100% means one logical CPU, as in top's usual per-core mode; a busy agent tree can exceed 100%. The host CPU percentage is normalized to the whole machine. ps %cpu is generally a lifetime average, so compare interval counters or top's second refresh rather than expecting those two different averages to match.
- RSS is the sum of resident memory of attributed processes, not unique physical memory. Shared pages can be counted more than once across processes; this is not proportional set size (PSS). Host RAM uses MemTotal minus MemAvailable, and swap uses SwapTotal minus SwapFree.
- Uptime is the local root process's age, not the conversation's age. SESSION is the session age separately. Remote rows represent only laptop-side clients and transports, never CPU or memory on another machine.
- H/P shows helpers/processes. Separate registered child agents have their own rows and their CPU/RSS is not also charged to the parent's row. In-process/headless workers and ordinary tool descendants are rolled into their owner where attribution is possible.
- CTX shows reported context tokens, the declared model window, a percentage and a five-cell bar. It is a token measurement, not a conversion from session-file bytes. CMP is the daemon's current-session compaction count; DUE is its refresh-due flag. Unknown or inaccessible data is shown as ?, not invented as zero.
- RST/RF shows observed restart/upkeep-refresh counts; these are not lifetime counts when their source logs/history are bounded. BUDGET is a spawned helper's fresh-token usage/limit, not its context-window occupancy. Model names are abbreviated in the table; JSON preserves the full identifier and metric provenance.
- The header reports local agent-related CPU/RSS totals and the monitor's own CPU/RSS in JSON. Collection time appears as sample milliseconds. A busy machine may delay a refresh; samples never overlap.

## Attribution and limits

Agent names, worlds, status, models and registered identities come from hyprpi. Local root PIDs and the nearest registered ancestor take precedence. Detached helpers can be linked by an explicit agent identity in their environment. An unknown explicit agent ID cannot fall through to another agent with a reused name; a matching world marker can still identify that world's aggregate transport. A nested registered agent is a separate owner; no process is charged to two rows. Recognizable unowned Pi process trees are shown as Unattributed instead of silently discarded or assigned by a similar-looking name.

Only selected identity markers are read from process environments; full environments and command lines, including prompts and credentials, are not included in the output. Permission errors, disappearing processes and missing telemetry do not turn into fabricated measurements. Unidentifiable orphan processes without an agent marker cannot be proved to be agent work; the host-wide header still includes their machine load.

## Priority formula

PRI is the sum of these components, capped at 100. It is a heuristic, not an OS scheduling priority or a judgment of the value of an agent's work:

- Active now: 35 for working; 15 for background (its turn ended but helpers remain); otherwise 0.
- Recency: 15 if its latest completed turn was within 5 minutes; 8 within 30 minutes; otherwise 0.
- Recent turns: 2 per completed turn in the last hour, capped at 10.
- Project ownership: 5 per non-archived project it owns, capped at 10.
- Running briefs: 5 per assigned running job, capped at 10.
- Waiting on the user: 8 when blocked or the author of an open decide item.
- Incoming demands: 6 when an unanswered, uncancelled demand is at most 60 minutes old. The caller may already have timed out; this is pending-request evidence, not a proven live waiter.
- Parent of live helpers: 6.

A missing source contributes no points and is listed in priorityDetails.missing in JSON. Unknown activity, for example on a remote mirror or Thoughts process, is not silently treated as a measured idle period. The score uses status, turn recency and turn counts, not a guessed fraction of the previous hour spent working. JSON includes the complete formula and each component's value and points.

## Data freshness

Normal-agent compactions, session start and refresh-due flags come directly from the daemon's list. Helper budgets come from orch.all. Project ownership, running briefs, pending demands and upkeep history come from the daemon's persisted state; these slower sources refresh every 10 seconds. Restart counts use the available activity-log tail, at most 7 days; upkeep refresh history is retained for 7 days.

Context uses the last valid assistant response on the active session branch, including the provider's input/output/cache token accounting. It is unknown after compaction until the next response. Later tool/user messages are recorded as trailingMessages in JSON but no characters-to-tokens estimate is added. Model windows are matched by exact provider/model in Pi's configured catalog; an unknown model window stays unknown. Sessions are cached and read incrementally, with bounded tails rather than a full re-read every refresh.

The already-attributed process trees, new processes and monitor PID are sampled every refresh. Old unrelated processes are rediscovered in a full scan every 15 samples (30 seconds at the default cadence); a formerly unrelated process that changes role can take that long to appear. CPU for a newly discovered old process is unknown until another sample supplies a baseline. Processes that start and finish entirely between samples cannot be attributed by this sampler; host-wide CPU still includes that work.

Sandbox and remote identities come from the laptop's existing world mirrors. A mirror older than 120 seconds is flagged stale. Remote PIDs are never treated as laptop PIDs; H/I costs are collected into a separate local-transport row when individual attribution is unavailable. Guest-only context and processes that the laptop cannot inspect remain unknown. The agent subtotal covers observed, attributable local process trees plus recognized unattributed Pi trees; it cannot claim invisible VM-guest resource usage. No remote commands or credentials are used to fill these gaps.
