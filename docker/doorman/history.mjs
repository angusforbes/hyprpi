// J373 (Angus chose a stateless Doorman): the only memory a Doorman call gets is what the relay supplies with each message.
// Every message to a Doorman is answered in a FRESH pi session (docker/doorman/doorman-rpc.mjs starts a new one after each turn;
// the drop-box extension hands it one message per session), and this module is the relay's record of what that message may
// carry along: the SAME asker's last few exchanges with the Doorman, and the receipts for what the Doorman drafted while
// answering that asker. Nothing from any other asker ever goes in.
//
// The bound, and why (J373 W2):
//   - at most HIST_EXCHANGES (3) question/answer pairs and HIST_RECEIPTS (3) receipts, from the last HIST_TTL_MS (24 h):
//     enough for a follow-up ("I asked you about pypi.org earlier") and to know a draft was decided, small enough that one
//     long thread can't steer the Doorman or crowd out the host card, and short-lived so yesterday's work doesn't leak in;
//   - each question and answer cut to Q_MAX / A_MAX characters, each receipt to NOTE_MAX: the whole block stays under ~9 kB
//     (inside the extension's 64 kB inbox-file limit next to an 8 kB message).
// The asker key is the sender as the relay sees it (the served sandbox's relay agent, or the host Thoughts) plus the
// "[Name, in world G]" label the sandbox's gate signs messages with. That label is the sandbox's own claim, so one agent of a
// sandbox could pose as another of the SAME sandbox; it never crosses sandboxes, and the Doorman sees only what that sandbox's
// agents already sent it.
import fs from "node:fs";
import path from "node:path";

export const HIST_EXCHANGES = 3, HIST_RECEIPTS = 3, HIST_TTL_MS = 24 * 3600e3;
export const Q_MAX = 1200, A_MAX = 1200, NOTE_MAX = 400;
const ASK_TTL_MS = 2 * 3600e3, LINK_TTL_MS = 7 * 24 * 3600e3; // an unanswered question / a held id's asker are forgotten after this
const MAX_KEYS = 100, MAX_ASKS = 300, MAX_LINKS = 300;

const clean = (s, max) => {
  let t = String(s ?? "").replace(/[\u2028\u2029]/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, "").trim();
  if (t.length > max) t = t.slice(0, max) + "… [cut]";
  return t;
};
// "[Alpha, in world G] question…" → "Alpha" (the gate's signature; unverified, see above)
export const askerLabel = (text) => ((/^\[([^\],\n]{1,40}), in world [A-I]\]/.exec(String(text ?? "")) || [])[1] || "").trim();
export const askerKey = (from, text) => `${String(from || "?").slice(0, 64)}|${askerLabel(text)}`;
// the question as recorded: without the signature (the key already says who asked)
const question = (text) => String(text ?? "").replace(/^\[[^\],\n]{1,40}, in world [A-I]\]\s*/, "");

export function openStore(file) {
  const load = () => {
    try { const a = JSON.parse(fs.readFileSync(file, "utf8")); return a && typeof a === "object" && !Array.isArray(a) ? a : {}; } catch { return {}; }
  };
  const save = (a) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(a), { mode: 0o600 }); fs.renameSync(tmp, file);
  };
  const of = (a, d) => { const x = (a[d] ||= {}); x.hist ||= {}; x.asks ||= {}; x.links ||= {}; return x; };
  const prune = (x, now) => {
    for (const k of Object.keys(x.hist)) {
      const keep = (x.hist[k] || []).filter((e) => now - Number(e.t) < HIST_TTL_MS);
      const ex = keep.filter((e) => !e.note).slice(-HIST_EXCHANGES), rc = keep.filter((e) => e.note).slice(-HIST_RECEIPTS);
      const both = [...ex, ...rc].sort((p, q) => p.t - q.t);
      if (both.length) x.hist[k] = both; else delete x.hist[k];
    }
    const newest = (o, max, ttl) => { for (const k of Object.keys(o)) if (!(now - Number(o[k]?.t) < ttl)) delete o[k]; for (const k of Object.keys(o).sort((p, q) => o[p].t - o[q].t).slice(0, Math.max(0, Object.keys(o).length - max))) delete o[k]; };
    newest(x.asks, MAX_ASKS, ASK_TTL_MS); newest(x.links, MAX_LINKS, LINK_TTL_MS);
    const ks = Object.keys(x.hist); if (ks.length > MAX_KEYS) for (const k of ks.sort((p, q) => x.hist[p].at(-1).t - x.hist[q].at(-1).t).slice(0, ks.length - MAX_KEYS)) delete x.hist[k];
  };
  const edit = (d, fn) => { const a = load(), x = of(a, d), now = Date.now(); const r = fn(x, now); prune(x, now); save(a); return r; };
  return {
    // what goes along with a message from this asker (oldest first), already bounded and cleaned
    context(d, key, now = Date.now()) {
      const x = of(load(), d); prune(x, now);
      return (x.hist[key] || []).map((e) => e.note ? { t: e.t, note: e.note } : { t: e.t, q: e.q, a: e.a });
    },
    // a message reached the Doorman: remember who asked what, until it answers
    asked(d, rid, from, text) {
      if (!rid) return;
      edit(d, (x, now) => { x.asks[String(rid).slice(0, 64)] = { t: now, key: askerKey(from, text), q: clean(question(text), Q_MAX) }; });
    },
    // the Doorman answered rid: one exchange in that asker's history (a second answer to the same rid is ignored)
    answered(d, rid, text) {
      return edit(d, (x, now) => {
        const k = String(rid || "").slice(0, 64), ask = x.asks[k]; if (!ask) return false;
        delete x.asks[k];
        (x.hist[ask.key] ||= []).push({ t: now, q: ask.q, a: clean(text, A_MAX) });
        return true;
      });
    },
    // the Doorman drafted heldId while answering rid: its receipt later goes to that asker
    link(d, heldId, rid) {
      edit(d, (x, now) => { const ask = x.asks[String(rid || "").slice(0, 64)]; if (ask && heldId) x.links[String(heldId).slice(0, 64)] = { t: now, key: ask.key }; });
    },
    // Angus decided heldId: a receipt in the history of the asker it was drafted for (none if it can't be tied to one)
    receipt(d, heldId, note) {
      return edit(d, (x, now) => {
        const l = x.links[String(heldId || "").slice(0, 64)]; if (!l) return false;
        delete x.links[String(heldId).slice(0, 64)];
        (x.hist[l.key] ||= []).push({ t: now, note: clean(note, NOTE_MAX) });
        return true;
      });
    },
  };
}

// The relay's inbox items for a Doorman, as one fresh call each sees them (used by docker/sbx-relay.mjs inboxWrite):
//   a message / reply → it carries `history` (this asker's bounded context) and is recorded as asked;
//   a receipt (decision, task_change, typed) → filed in the asker's history; the Doorman gets no separate turn for it.
export function forDoorman(store, doorman, obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.type === "message" || obj.type === "reply") {
    const key = askerKey(obj.from, obj.text);
    const history = store.context(doorman, key);
    if (obj.type === "message") store.asked(doorman, obj.request_id, obj.from, obj.text);
    return history.length ? { ...obj, history } : obj;
  }
  const r = receiptText(obj);
  if (r) store.receipt(doorman, obj.id, r);
  return obj;
}
export function receiptText(obj) {
  const id = clean(obj?.id, 40);
  if (obj?.type === "decision") return `Angus ${obj.decision === "approved" ? "approved" : obj.decision === "returned" ? "sent back" : "denied"} ${id}${obj.note ? ` (his note: ${clean(obj.note, 300)})` : ""}.`;
  if (obj?.type === "task_change") return `Angus ${obj.status === "applied" ? "approved the task change" : obj.status === "denied" ? "denied the task change" : "approved the task change, but it wasn't applied"} ${id}: ${clean(obj.outcome, 300)}`;
  if (obj?.type === "typed") return `Angus decided the typed request ${id}: ${clean(obj.outcome || obj.status || obj.decision, 300)}`;
  return "";
}
