# Gateway end-to-end tests (J376 / J412)

Expectations follow simplification-spec.md v3. This is a test-only suite; it does not deploy or change world G. The later decision to keep changes of the mode key held even in yolo is included.

Run from the hyprpi checkout after a deploy:

`node test/gateway-e2e.mjs`

Save a machine-readable report:

`node test/gateway-e2e.mjs --report /tmp/gateway-e2e-report.json`

Once all incoming implementations have landed, make missing coverage fail too:

`node test/gateway-e2e.mjs --require-complete`

During a separate pi-doorman branch review, explicitly select its source checkout (the report records that viewer's own commit, source hash and dirty status):

`node test/gateway-e2e.mjs --viewer-repo /home/agf/Harness/pi-doorman-keys --report /tmp/gateway-e2e-report.json`

## Prerequisites

Linux, Node, Python, working Docker and the locally cached pi-sandbox image. The suite never pulls an image. The pi-doorman source checkout must be alongside hyprpi (or in ~/Harness/pi-doorman). Its new-key implementation must land as well; an old viewer is pending, not evidence for the new vocabulary. J373's stateless fixture also needs the installed Pi CLI; it uses a local fake model server, not an API key.

## Isolation and decisions

Every run creates a fresh temporary HOME, config, research state, relay state and daemon socket. Its synthetic world I belongs only to the private test daemon. No live world G, relay state or daemon socket is passed to the tested processes or mounted in a test container. The worker is a disposable, network-disabled Docker container, not a Docker Sandboxes (sbx) microVM. It has only the fixture outboxes writable and the host-produced inboxes read-only.

Owner decisions use the unchanged product CLI in a separate disposable container, with a genuine Python PTY. Only scratch config/state/research/edit folders and read-only source are mounted there; no live HOME, daemon socket, Docker socket, Wayland or D-Bus is exposed. The harness validates its scratch paths, fixture config, sandbox names, pending IDs and scalar decision options before mounting them. Editing is not an approved option. Agent-marked and pipe-input decisions must still be refused. These cases test the HYPRPI_AGENT_ID and TTY checks; they do not independently test the pi/script ancestor-chain refusal.

A fresh PID namespace has no agent ancestor, so it passes the product's accident-prevention guard. This is not authentication or a claim that a malicious same-user host process cannot write decision files. The test helper cannot reach live decision files through its container mounts. It does not add a guard-bypass flag or write approval files directly.

The private daemon, relay, CLI/MCP, read-only tracker and real-Pi stateless fixture run on the host, with its uid and network access. Their isolation is a fresh environment, validated scratch paths and inert PATH commands, not a kernel boundary. Only the Docker worker, owner-decision and window containers are kernel-enforced boundaries. The model fixture uses a local fake SSE server, not an external API.

The product subprocess PATH also stubs Docker: relay startup and shutdown reconcile globally labelled GPU workers, so merely changing XDG paths would not isolate that cleanup. The suite's own container lifecycle uses the real Docker binary separately, and removes only containers it owns.

## Coverage

- Research exercises strict / safe / open / yolo: strict holds plans; safe holds off-task exceptions; open sends even off-task plans but holds summaries; yolo delivers cleaned, labelled NOT reviewed results. Code checks and durable logging still apply.
- New decisions are 1, 1 text, 1+, 1+ duration and 2. An actual private-daemon peer captures the exact approved text, proves the owner note stays with the asker, and exercises one-hour defaults, 5-minute minimums, 2-hour selection, 8-hour caps, subsequent rule use and denial/revision quarantine. A denied plan goes back with its reason and a checked suggestion, without starting a search or silently resubmitting. Removed e / r / 3 / a are negative cases, never positive flows.
- The real Doorman window is driven in an isolated PTY: chat is ignored and 1 text answers only the selected host question. The look-first guard and removed-key refusals remain checks.
- Typed requests exercise mode-dependent fixed handlers, durable archives and the real tracker. Decision receipts go to the exact asker only, without the old Thoughts copy. Reviewed file bytes come from a host-only snapshot, not later source contents. Retired open_for_owner requests remain refused.
- The fixture registers host agents through the actual bridge API. Free-form drafts need a live registration and become bridge jobs only; they are never delivered to Thoughts-A. CLI/MCP checks cover job lifecycle, registered claims, claim-token enforcement, structured approved actions, owner questions and forbidden direct decisions/config writes.
- Settings exercise all four modes and derived levels, legacy reads with warnings, fail-closed unknown/ambiguous modes, refusal of non-owner writes, proposals, approval/denial, stale/tampered proposals and yolo auto settings. A proposal touching the mode key is still held in yolo.
- J373/J395 reuse the real-Pi/local-fake-model fixture: every question call contains the system rules and one message, with no earlier same-asker or other-asker exchanges or receipts. Actual private-relay cases check that outcomes reach the message's bound asker rather than the model's chosen name, including drafts made after the reply. These are routing-envelope assertions, not an inner agent model's consumption of them.
- The command also runs all 26 negative isolation/owner-guard checks from rig-safety.mjs.

Missing incoming implementations are explicitly PENDING, never PASS. J412 key cases activate automatically when the new approve --allow-similar CLI surface lands; once active, a failing removal, receipt or duration assertion is a failure, not a pending excuse. The report records complete=false and prints INCOMPLETE when anything is pending. It identifies the product commit, dirty status and SHA-256 of the test sources. By default pending coverage permits exit 0 while builds land; --require-complete turns it into a failure. Any failed case, missing prerequisite or failed cleanup exits nonzero. Operations are checked with bounded waits. Research uses explicit fresh scratch-budget segments, resetting only its own caps/exceptions files and restarting only its private relay between segments. The open/yolo segment verifies refusal of a fourth off-task request; limits are not disabled or altered in product code. Worker and owner creation each get one 90-second deadline, accommodating observed 30-second host storage-completion stalls without retrying or skipping a guard; their Docker operation names, times, results and cleanup calls are retained in ownedScratch.dockerTrace. A Docker removal stall in the negative-isolation check permits one retry only after exact-label cleanup is verified; both attempts are retained in the report. Assertion failures are not retried. The window test explicitly waits out the two-second review guard before typing; it then verifies the exact review-hook arguments.

## What this does not prove

Providers, browser opening, network policy changes and share mounting are synthetic recorded effects. The production checks, relay, daemon, handlers, guarded CLI and window still run; the suite does not claim live-model semantic accuracy, real Internet availability, actual browser rendering, compliance with any security review or a GPU lease. Existing unit/red-team suites and explicit live checks remain complementary.

Cleanup tracks every nested rig and the window container, not only the outer worker. A timed-out Docker create remains uncertain until its exact labelled container is observed and removed; an empty early lookup is not cleanup proof. If creation cannot be settled within the bounded wait, cleanup is reported failed and scratch is retained instead of claiming success. Late-create, never-observed-create and partial-constructor cleanup have deterministic regression checks. A constructor error removes its original scratch inode before returning; an unconfirmed removal also makes cleanup fail.

The suite destroys scratch state and owned containers when cleanup is proven. SIGKILL cannot run cleanup and can leave labelled scratch resources; normal signals and exceptions do run it. A saved report retains only synthetic diagnostics and the tested commit. Do not use broad docker prune or kill commands to clean up a test.
