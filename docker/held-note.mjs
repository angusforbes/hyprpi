// Angus's text after a decision key, why an item was held, and how a sent-back message links to its revision. J412 (spec 2): "2" always
// goes back to the asker with the hold's reason (and his text); "1 text" tells the asker his text with the approval. (The J370 "r" verb and
// the J365 edit are gone.) Shared by the relay (docker/sbx-relay.mjs), lib/held.mjs and the tests.
// Angus's text: his own words going INTO the sandbox, so it is cleaned like any host -> sandbox text (no control or format characters,
// whitespace collapsed to one line) and capped; an over-long one is refused, not cut.
export const NOTE_MAX = 500;
export function ownerNote(raw) {
  const t = String(raw ?? "").replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
  if (t.length > NOTE_MAX) return { ok: false, reason: `at most ${NOTE_MAX} characters (this one is ${t.length})` };
  return { ok: true, text: t };
}
// J412: a sandbox agent's own message (not a Doorman draft, GPU lease, task change, typed request, gateway change or research). When one
// is denied ("2", sent back), its revision is linked and no allow-similar rule applies meanwhile (J370b). A research plan links separately.
export function linkable(m) {
  if (!m || typeof m !== "object" || m.research) return false;
  return !m.gpu && !m.taskChange && !m.draft && !m.typed && !m.gatewayChange && !m.hostJob && (m.mode === "talk" || m.mode === "demand");
}
// The asking agent's label from the gate's "[Name, in world G]" prefix (unverified: used only to link a revision and to name it in notes).
export const senderLabel = (text) => ((/^\[([^\],\n]{1,40}), in world [A-I]\]/.exec(String(text ?? "")) || [])[1] || "").trim();
export const returnKey = (sandbox, m) => `${sandbox}|${senderLabel(m.text)}|${(Array.isArray(m.targets) ? m.targets.map((t) => t?.id) : m.to || []).map(String).sort().join(",")}`;

// J386 / J412: why an item was held, from the hold's own record, labelled with its source; every "2" forwards it to the asker. Model or code text going into the sandbox: control and format characters
// out, one line, capped (cut, with "…"). No recorded reason: says so, never invented.
export const REASON_MAX = 600;
const one = (t) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
export function holdReason(m) {
  let src = "", why = "";
  if (m?.research?.plan) {
    const ex = one(m.research.exception);
    if (ex) { src = /^no (research )?task/i.test(ex) ? "host" : "Doorman"; why = ex; }
    else if (m.research.mode === "strict") { src = "host"; why = "strict mode: every research plan waits for Angus before any search goes out"; }
  } else if (m?.research) { src = "relay"; why = "a research result waits for Angus's review before it reaches the sandbox";
  } else if (m?.gpu) { src = "relay"; why = "a GPU lease needs Angus's approval";
  } else if (m?.taskChange) { src = "relay"; why = "a change of the research task needs Angus's approval";
  } else if (m?.gatewayChange) { src = "relay"; why = "a change of the research gateway's settings needs Angus's approval";
  } else if (m?.typed) { src = "relay"; why = `a "${one(m.typed.type).replace(/_/g, " ")}" request needs Angus's approval`;
  } else if (m?.draft) { src = "relay"; why = "a free-form request the Doorman drafted needs Angus's approval";
  } else if (m && (m.mode === "talk" || m.mode === "demand")) {
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
