// node test/held-review-gate.mjs  (J356: a typed choice is never silently lost)
import assert from "node:assert/strict";
import fs from "node:fs";
import { clickAction, reviewGate, parseChoice, REVIEW_EARLY_MS, bareChoice, cardForBareNumber, statusText, heldStatus } from "../lib/held.mjs";

const now = Date.now(), old = now - 10_000;
// An auto-opened review (J301) that recorded "1" from the box, as with world-g--3b0f5e
const auto = { id: "world-g--3b0f5e", auto: true, typed: "1", shownAt: old };
assert.deepEqual(reviewGate(auto, "1", { now }), { ok: false, reason: "stale" }, "before the fix this was a silent return");
// (a) a Review click on that same review re-arms it; then a plain "1" answers it and means approve
assert.equal(clickAction(auto, "world-g--3b0f5e"), "rearm");
const rearmed = { ...auto, auto: false, typed: "", shownAt: old };
assert.deepEqual(reviewGate(rearmed, "1", { now }), { ok: true });
assert.equal(parseChoice("1").verdict, "approve");
// other click cases
assert.equal(clickAction(null, "x--aaaaaa"), "open");
assert.equal(clickAction(auto, "other--bbbbbb"), "replace");
assert.equal(clickAction({ ...auto, auto: false }, auto.id), null, "an already clicked review stays as it is");
assert.equal(clickAction(auto, null), null);
// (c) every other reason
assert.deepEqual(reviewGate(null, "1", { now }), { ok: false, reason: "no-review" });
assert.deepEqual(reviewGate(rearmed, "1", { now, exists: false }), { ok: false, reason: "gone" });
assert.deepEqual(reviewGate({ ...rearmed, shownAt: now - REVIEW_EARLY_MS + 200 }, "1", { now }), { ok: false, reason: "early" });
assert.deepEqual(reviewGate(auto, "2", { now }), { ok: true }, "other text than what was in the box answers");
// the panel wires them in: every early return logs, stale doesn't go to Thoughts
const tui = fs.readFileSync(new URL("../mockups/search-tui.mjs", import.meta.url), "utf8");
const body = tui.slice(tui.indexOf("function reviewKey("), tui.indexOf("function enter("));
assert.ok(/reviewGate\(review, raw/.test(body) && /stage: gate\.reason === "stale" \? "stale" : "early-return", reason: gate\.reason/.test(body), "reviewKey logs each gate reason");
assert.ok(/gate\.reason === "stale"\) \{[^}]*review\.typed = ""[\s\S]{0,300}can't answer it: type [\s\S]{0,80}return true;\s*\}/.test(body), "stale shows the notice and returns true (not sent to Thoughts)");
assert.ok(/reason: "empty"/.test(body), "the empty-line return logs");
assert.ok(!/return false; \/\/ \(J301: already in the box/.test(tui), "the old silent stale return is gone");
assert.ok(/clickAction\(review, clicked\)/.test(tui) && /act === "rearm"/.test(tui), "pollReview re-arms on a same-id click");
// (2a) bare numbers, the card they're aimed at, and the status text
for (const x of ["1", "2", "1+", " 1 ", "1.", "2)"]) assert.ok(bareChoice(x), x);
for (const x of ["12", "1 yes", "a", "", "4", "3", "e", "r"]) assert.ok(!bareChoice(x), x);
const card = { role: "held", kind: "request", id: "world-g--aaaaaa", ts: 1000 };
assert.equal(cardForBareNumber([card], [{ role: "thoughts", ts: 900, text: "1. a\n2. b" }]), card, "card newer than Thoughts' last numbered question: the number is for the card");
assert.equal(cardForBareNumber([card], [{ role: "thoughts", ts: 1100, text: "Which one?\n1. Keep it\n2. Drop it" }]), null, "Thoughts asked a numbered question after the card: the number is for Thoughts");
for (const q of ["**1.** Keep\n**2.** Drop", "## 1. First\n## 2. Second", "> 1. a\n> 2. b", "Pick:\n1) a\n2) b", "  1. indented"]) assert.equal(cardForBareNumber([card], [{ role: "thoughts", ts: 1100, text: q }]), null, `numbered question after the card (${JSON.stringify(q)}) → Thoughts (HeldRecheck)`);
assert.equal(cardForBareNumber([card], [{ role: "thoughts", ts: 1100, text: "OK" }]), card, "a hidden OK acknowledgement after the card doesn't count");
assert.equal(cardForBareNumber([card], [{ role: "thoughts", ts: 1100, text: "⚠ Alpha says you asked for this; only approve if you did." }]), card, "a one-line review flag doesn't count");
assert.equal(cardForBareNumber([{ role: "held", ts: 1000, id: "x--bbbbbb" }], []), null, "a decision turn isn't a card");
assert.match(statusText({ state: "approved", at: Date.parse("2026-10-09T22:57:00Z") }), /^✓ Approved at \d/);
assert.match(statusText({ state: "denied", at: 1 }), /^✗ Denied at/);
assert.equal(statusText({ state: "gone" }), "no longer waiting (expired or withdrawn)");
assert.equal(heldStatus("not an id").state, "gone");
assert.ok(/heldStatus\(e\.id\)/.test(tui) && /type 1, 2 or 3 here \+ ⏎/.test(tui) && /type 1 or 2 here \+ ⏎/.test(tui), "cards show how to answer while pending");
assert.ok(/stage: "decided-card"/.test(body) && /already \$\{st\.state\}/.test(body), "a bare number at a decided card says so");
assert.ok(body.includes("if (parseChoice(raw)) { setBox(\"\"); note = `🐳 the review just opened"), "an early choice is held back with a notice, not sent to Thoughts");
assert.ok(/reason: "not-armed-yet"/.test(body), "a number at a pending card not yet armed is held back");
assert.ok(/if \(st && st\.state === "pending"\) \{/.test(body), "held back after a gone review too (HeldRecheck), not only with no review");
// (2b)
const th = fs.readFileSync(new URL("../lib/thoughts.mjs", import.meta.url), "utf8");
assert.ok(/a bare 1, 2 or 3[\s\S]{0,200}the panel missed it[\s\S]{0,120}type it again here, in this panel/.test(th), "Thoughts' prompt line");
console.log("held-review-gate: all pass");
