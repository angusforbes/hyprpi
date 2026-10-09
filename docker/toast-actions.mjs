// J355 (Angus: "1a"): a held-message toast offers only Review and Deny. Approve, and "allow similar", happen only by typing the
// choice in the Thoughts panel (or the host terminal) after the whole request is shown. This module is the one list of what a
// toast may do; the relay refuses anything else, even from a stale toast (one sent before this change, still on screen) or a
// forged ActionInvoked.
export const ACTION_KEYS = { deny: "Deny", review: "Review" };
const LINE = /^\/org\/freedesktop\/Notifications: org\.freedesktop\.Notifications\.ActionInvoked \(uint32 (\d+), '([a-z]+):([0-9a-f]{16})'\)\s*$/;
// An ActionInvoked line -> { n, key, nonce } or null.
export function parseActionLine(line) { const m = LINE.exec(line); return m ? { n: Number(m[1]), key: m[2], nonce: m[3] } : null; }
export const toastMayDo = (key) => Object.hasOwn(ACTION_KEYS, key);
