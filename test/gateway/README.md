# Gateway end-to-end tests (J376)

Run from the hyprpi checkout after a deploy:

`node test/gateway-e2e.mjs`

Save a machine-readable report:

`node test/gateway-e2e.mjs --report /tmp/gateway-e2e-report.json`

Once all incoming implementations have landed, make missing coverage fail too:

`node test/gateway-e2e.mjs --require-complete`

## Prerequisites

Linux, Node, Python, working Docker and the locally cached pi-sandbox image. The suite never pulls an image. The pi-doorman source checkout must be alongside hyprpi (or in ~/Harness/pi-doorman). J373's stateless fixture also needs the installed Pi CLI; it uses a local fake model server, not an API key.

## Isolation and decisions

Every run creates a fresh temporary HOME, config, research state, relay state and daemon socket. Its synthetic world I belongs only to the private test daemon. No live world G, relay state or daemon socket is passed to the tested processes or mounted in a test container. The worker is a disposable, network-disabled Docker container, not an ASR-approved Docker Sandboxes VM. It has only the fixture outboxes writable and the host-produced inboxes read-only.

Owner decisions use the unchanged product CLI in a separate disposable container, with a genuine Python PTY. Only scratch config/state/research/edit folders and read-only source are mounted there; no live HOME, daemon socket, Docker socket, Wayland or D-Bus is exposed. The harness validates its scratch paths, fixture config, sandbox names, pending IDs and edit paths before mounting them. Agent-marked and pipe-input decisions must still be refused. These cases test the HYPRPI_AGENT_ID and TTY checks; they do not independently test the pi/script ancestor-chain refusal.

A fresh PID namespace has no agent ancestor, so it passes the product's accident-prevention guard. This is not authentication or a claim that a malicious same-user host process cannot write decision files. The test helper cannot reach live decision files through its container mounts. It does not add a guard-bypass flag or write approval files directly.

The private daemon, relay, CLI/MCP, read-only tracker and real-Pi stateless fixture run on the host, with its uid and network access. Their isolation is a fresh environment, validated scratch paths and inert PATH commands, not a kernel boundary. Only the Docker worker, owner-decision and window containers are kernel-enforced boundaries. The model fixture uses a local fake SSE server, not an external API.

The product subprocess PATH also stubs Docker: relay startup and shutdown reconcile globally labelled GPU workers, so merely changing XDG paths would not isolate that cleanup. The suite's own container lifecycle uses the real Docker binary separately, and removes only containers it owns.

## Coverage

- On-task research reaches the synthetic reader; off-task research is held before any outgoing search.
- Strict research plans exercise 1, 2, e and r through the real guarded CLI, including deny reasons, revised plans and original/edited archives.
- Full deliverables wait for review, are delivered only after approval, and have cleaned, deduplicated HTTPS sources.
- The real Doorman archive window is driven in a PTY: chat is ignored both when empty and with a held request, and a <answer> reaches only the selected synthetic question's review hook.
- J368 typed requests check fixed handlers and outcome routing envelopes addressed to the asker and synthetic coordinator, plus the durable archive and real tracker. Reviewed file bytes come from a host-only snapshot, not the later contents of the source. J393 opening checks the real handler's exact service-manager handoff; the fixture manager records acceptance and starts no service or browser. No coordinator model is started; its unprefixed inbox envelope is asserted.
- J371 bridge CLI/MCP check job lifecycle, claim-token enforcement, structured approved actions, owner questions including guarded free-text answers, settings/proposals and refusal of direct decisions/config writes.
- J372 settings exercise effective config, refusal of non-owner writes, proposals, approval/denial and stale/tampered proposals.
- J373/J395 reuse the real-Pi/local-fake-model fixture: every question call contains the system rules and one message, with no earlier same-asker or other-asker exchanges or receipts. Actual private-relay cases check that outcomes reach the message's bound asker rather than the model's chosen name, including drafts made after the reply. These are routing-envelope assertions, not an inner agent model's consumption of them.
- The command also runs all 26 negative isolation/owner-guard checks from rig-safety.mjs.

Missing incoming implementations are explicitly PENDING, never PASS. The report records complete=false and prints INCOMPLETE when anything is pending. It identifies the product commit, dirty status and SHA-256 of the test sources. By default pending coverage permits exit 0 while builds land; --require-complete turns it into a failure. Any failed case, missing prerequisite or failed cleanup exits nonzero. Operations are checked with bounded waits. A Docker removal stall in the negative-isolation check permits one retry only after exact-label cleanup is verified; both attempts are retained in the report. Assertion failures are not retried. The window answer test explicitly waits out the two-second review guard before typing; it then verifies the exact review-hook arguments.

## What this does not prove

Providers, browser opening, network policy changes and share mounting are synthetic recorded effects. The production checks, relay, daemon, handlers, guarded CLI and window still run; the suite does not claim live-model semantic accuracy, real Internet availability, actual browser rendering, ASR compliance or a GPU lease. Existing unit/red-team suites and explicit live checks remain complementary.

Cleanup tracks every nested rig and the window container, not only the outer worker. A timed-out Docker create remains uncertain until its exact labelled container is observed and removed; an empty early lookup is not cleanup proof. If creation cannot be settled within the bounded wait, cleanup is reported failed and scratch is retained instead of claiming success. Late-create, never-observed-create and partial-constructor cleanup have deterministic regression checks. A constructor error removes its original scratch inode before returning; an unconfirmed removal also makes cleanup fail.

The suite destroys scratch state and owned containers when cleanup is proven. SIGKILL cannot run cleanup and can leave labelled scratch resources; normal signals and exceptions do run it. A saved report retains only synthetic diagnostics and the tested commit. Do not use broad docker prune or kill commands to clean up a test.
