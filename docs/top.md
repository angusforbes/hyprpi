# Agent resource snapshot

`hyprpi top` is a read-only, Linux-only snapshot of agent activity on the machine where it runs. It connects to the existing hyprpi daemon; it does not start it, send agents work, open windows, change process priorities, or stop anything.

## Run it

`hyprpi top`

`hyprpi top --once`

`hyprpi top --once --json`

`hyprpi top --sort priority`

`hyprpi top --json --samples 10 --interval 2`

Live refresh defaults to two seconds. Without a terminal, or with JSON, the default is one snapshot; --samples requests a bounded sequence (JSON Lines with --json). CPU counters are primed for half a second before the first output. --interval accepts 0.5–60 seconds. All agents remain grouped by world; sorting applies within each world.

Keys: c CPU, m memory, u uptime, p priority; j/k or up/down to scroll; PgUp/PgDn to page; left/right to pan across the wide table; Home to return to the top-left; q, Escape or Ctrl+C to quit. No key controls another process. The normal terminal screen and cursor are restored on exit. Nothing takes desktop focus.

## Read the numbers

- CPU% is an interval measurement of process CPU time, including attributed descendants. 100% means one logical CPU, as in top's usual per-core mode; a busy agent tree can exceed 100%. The host CPU percentage is normalized to the whole machine. ps %cpu is generally a lifetime average, so compare interval counters or top's second refresh rather than expecting those two different averages to match.
- RSS is the sum of resident memory of attributed processes, not unique physical memory. Shared pages can be counted more than once across processes; this is not proportional set size (PSS). Host RAM uses MemTotal minus MemAvailable, and swap uses SwapTotal minus SwapFree.
- Uptime is the local root process's age, not the conversation's age. SESSION is the session age separately. Remote rows represent only laptop-side clients and transports, never CPU or memory on another machine.
- H/P shows helpers/processes. Separate registered child agents have their own rows and their CPU/RSS is not also charged to the parent's row. In-process/headless workers and ordinary tool descendants are rolled into their owner where attribution is possible.
- CTX shows reported context tokens, the declared model window, a percentage and a five-cell bar. It is a token measurement, not a conversion from session-file bytes. CMP is the daemon's current-session compaction count; DUE is its refresh-due flag. Unknown or inaccessible data is shown as ?, not invented as zero.
- RST/RF shows observed restart/upkeep-refresh counts; these are not lifetime counts when their source logs/history are bounded. BUDGET is a spawned helper's fresh-token usage/limit, not its context-window occupancy. Model names are abbreviated in the table; JSON preserves the full identifier and metric provenance.
- The header reports local agent-related CPU/RSS totals and the monitor's own CPU/RSS in JSON. Collection time appears as sample milliseconds. A busy machine may delay a refresh; samples never overlap.

## Attribution and limits

Agent names, worlds, status, models and registered identities come from hyprpi. Local root PIDs and the nearest registered ancestor take precedence. Detached helpers can be linked by an explicit agent identity in their environment. A nested registered agent is a separate owner; no process is charged to two rows. Recognizable unowned Pi process trees are shown as Unattributed instead of silently discarded or assigned by a similar-looking name.

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
