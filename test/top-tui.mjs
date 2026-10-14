#!/usr/bin/env node
// J565 incident quarantine. The previous test mixed an isolated daemon with live /proc and real signals.
// It must not be restored until process discovery is synthetic, every action uses a fake signal seam,
// and failed selection/assertions abort before confirmation. No imports or executable test body here.
throw new Error("J565 QUARANTINED: top-tui integration test disabled; synthetic /proc and fake signalling are required before it may run again. See git history for the original test.");
