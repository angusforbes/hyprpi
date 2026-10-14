#!/usr/bin/env node
// test-guard: skip J565 quarantine (J564 v3 replaces it; it then runs, inside the guard)
// J565 incident quarantine. The previous test mixed an isolated daemon with live /proc and real signals.
// It must not be restored until process discovery is synthetic, every action uses a fake signal seam,
// and failed selection/assertions abort before confirmation. No test body here.
// J566: the quarantine is lifted only through the test guard: whatever replaces this file (J564 v3) keeps these two lines first,
// so it can only ever run inside the guard's sandbox (own pid namespace, live runtime folder masked, kill-guard preload).
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
throw new Error("J565 QUARANTINED: top-tui integration test disabled; synthetic /proc and fake signalling are required before it may run again. See git history for the original test.");
