// J370 (Angus: "shouldn't another option be to let the agent edit it?"): sending a held item back with a note, and a deny with a reason.
// Shared by the relay (docker/sbx-relay.mjs), lib/held.mjs (what the review offers) and the tests.
// J370: Angus's note (send back) or reason (deny): his own text going INTO the sandbox, so it is cleaned like any host -> sandbox text (no
// control or format characters, whitespace collapsed to one line) and capped; an over-long one is refused, not cut.
export const NOTE_MAX = 500;
export function ownerNote(raw) {
  const t = String(raw ?? "").replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
  if (t.length > NOTE_MAX) return { ok: false, reason: `at most ${NOTE_MAX} characters (this one is ${t.length})` };
  return { ok: true, text: t };
}
// What can be sent back (J370): a sandbox agent's own message (not a Doorman draft, GPU lease, task change or typed request) or a research plan.
export function returnable(m) {
  if (!m || typeof m !== "object") return false;
  if (m.research) return m.research.plan === true;
  return !m.gpu && !m.taskChange && !m.draft && !m.typed && (m.mode === "talk" || m.mode === "demand");
}
// The asking agent's label from the gate's "[Name, in world G]" prefix (unverified: used only to link a revision and to name it in notes).
export const senderLabel = (text) => ((/^\[([^\],\n]{1,40}), in world [A-I]\]/.exec(String(text ?? "")) || [])[1] || "").trim();
export const returnKey = (sandbox, m) => `${sandbox}|${senderLabel(m.text)}|${(Array.isArray(m.targets) ? m.targets.map((t) => t?.id) : m.to || []).map(String).sort().join(",")}`;

// J386 (Angus: "the note should be verbatim the response … I shouldn't have to provide a note"): why an item was held, from the hold's own
// record, labelled with its source, so a bare "r" can forward it. Model or code text going into the sandbox: control and format characters
// out, one line, capped (cut, with "…"). No recorded reason: says so, never invented.
export const REASON_MAX = 600;
const one = (t) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
export function holdReason(m) {
  let src = "", why = "";
  if (m?.research?.plan) {
    const ex = one(m.research.exception);
    if (ex) { src = /^no (research )?task/i.test(ex) ? "host" : "Doorman"; why = ex; }
    else if (m.research.mode === "doorman-strict") { src = "host"; why = "strict mode: every research plan waits for Angus before any search goes out"; }
  } else if (m && !m.research && !m.gpu && !m.taskChange && !m.draft && !m.typed && (m.mode === "talk" || m.mode === "demand")) {
    const to = (Array.isArray(m.shown) && m.shown.length ? m.shown : m.to || []).map((x) => one(x).replace(/ \(.*\)$/, "")).join(", ");
    src = "relay"; why = `a message from the sandbox to ${to || "a host agent"} waits for Angus's approval (no allow-similar rule covers it)`;
  }
  if (!why) return "held for review; no reason recorded";
  const t = `held because (${src}): ${why}`;
  return t.length > REASON_MAX ? t.slice(0, REASON_MAX - 1) + "…" : t;
}
// J378 (FlowRecheck #1): which connected relay sandboxes may message each other at once, with no hold. Only a Doorman and the one sandbox it serves
// (that IS the Doorman's job: G asks its front desk). Any other pair of relay sandboxes (another world, a probe) is gated like any message out of a
// sandbox: held for Angus, or sent under an allow-similar rule he made. (A pair involving someone else's Doorman stays refused, see pairOk.)
export const openPeer = (me, other) => !!me && !!other && me !== other && ((!!me.doormanFor && me.doormanFor === other.name) || (!!other.doormanFor && other.doormanFor === me.name));
