// "Allow similar" rules for messages held by the sandbox relay (J274, Angus's pick 1b of the J273 note).
//
// A rule lets talks from one sandbox to one recipient (exact agent id, or Thoughts-X) through without
// asking, until it expires and while it stays under its rate cap. Keyed only on what the relay knows for
// certain: the sandbox, the recipient and the kind. The sender name inside the sandbox ("[Alpha, in world G]")
// is written by the sandbox itself, so it is never part of the key.
//
//   kind       talk only (a demand, which waits for an answer, is always held)
//   duration   once (no rule), minutes / hours, or "today" (until local midnight); no "always":
//              agents at most MAX_AGENT_MS, Thoughts-X recipients at most until midnight
//   rate cap   CAP_PER_HOUR messages per rule per hour; beyond that the message is held as before
//
// Rules live in one host-only file (mode 600, in the relay's state folder, which the sandbox can't reach).
// Creating a rule goes through the relay's guarded decision path (like approve); revoking is open to anyone.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MS = 3600 * 1000;          // Angus: the default is 1 hour
export const MAX_AGENT_MS = 24 * 3600 * 1000;   // no "always": a day at most
export const CAP_PER_HOUR = 30;

const midnight = (now) => { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); };

// "once" | "today" | "90m" | "2h" | "2 hours" | "1.5 hrs" | "45 minutes" → { once } | { ms } | { today } | null
export function parseDuration(s) {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return { ms: DEFAULT_MS };
  if (/^(once|just this one|this one)$/.test(t)) return { once: true };
  if (/^(today|for today|rest of (the )?day|till midnight|until midnight)$/.test(t)) return { today: true };
  const m = /^(?:for\s+)?(an?|\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)$/.exec(t);
  if (!m) return null;
  const n = /^an?$/.test(m[1]) ? 1 : Number(m[1]);
  const ms = n * (m[2].startsWith("m") ? 60000 : 3600000);
  return ms >= 60000 ? { ms } : null;
}

// The rule's end time for a recipient, with the caps applied. Returns { until, capped }.
export function ruleEnd(dur, recipientKind, now = Date.now()) {
  const mid = midnight(now);
  let until = dur.today ? mid : now + (dur.ms || DEFAULT_MS);
  let capped = "";
  if (recipientKind === "thoughts" && until > mid) { until = mid; capped = "Thoughts: until midnight at most"; }
  if (recipientKind !== "thoughts" && until > now + MAX_AGENT_MS) { until = now + MAX_AGENT_MS; capped = "24 hours at most"; }
  return { until, capped };
}

export function rulesFile(stateDir) { return path.join(stateDir, "rules.json"); }

// Every read-modify-write holds a lock (review J274 #4: a revoke racing a use could bring a rule back).
// mkdir is atomic; a lock older than 5 s is a crashed holder's and is broken. Fails closed: no lock, no change.
function withLock(stateDir, fn) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, "rules.lock"), wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.rmdirSync(lock); continue; } } catch { continue; }
      if (i > 200) throw new Error("rules are locked (try again)");
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* gone */ } }
}
const kindOf = (t) => (t.kind === "thoughts" ? "thoughts" : "agent"); // the relay's resolved kind, never the id's spelling (review #5)

export function loadRules(stateDir, now = Date.now()) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(rulesFile(stateDir), "utf8")); } catch { return []; }
  return (Array.isArray(list) ? list : []).filter((r) => r && Number(r.until) > now && typeof r.sandbox === "string" && typeof r.recipient === "string");
}

export function saveRules(stateDir, list) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const f = rulesFile(stateDir), tmp = f + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// Add (or extend) one rule per recipient. targets: [{ kind: "agent"|"thoughts", id, shown }]
export function addRules(stateDir, { sandbox, targets, dur, from = "", now = Date.now() }) { return withLock(stateDir, () => {
  const list = loadRules(stateDir, now);
  let n = list.reduce((m, r) => Math.max(m, r.n || 0), 0);
  const made = [];
  for (const t of targets) {
    const kind = kindOf(t);
    const { until, capped } = ruleEnd(dur, kind, now);
    const old = list.find((r) => r.sandbox === sandbox && r.recipient === t.id && r.recipientKind === kind && r.kind === "talk");
    if (old) { old.until = Math.max(old.until, until); old.capped = capped; made.push(old); continue; }
    const r = { n: ++n, sandbox, recipient: t.id, shown: t.shown || t.id, recipientKind: kind, kind: "talk", until, capped, created: now, from, sent: [] };
    list.push(r); made.push(r);
  }
  saveRules(stateDir, list);
  return made;
}); }

// Every recipient covered by a live rule with room under its cap? Then [rules], else null. Records the use.
export function useRules(stateDir, { sandbox, targets, mode, now = Date.now() }) {
  if (mode !== "talk" || !targets.length) return null;
  try { return withLock(stateDir, () => useLocked(stateDir, { sandbox, targets, now })); } catch { return null; } // locked: hold it (fail closed)
}
function useLocked(stateDir, { sandbox, targets, now }) {
  const list = loadRules(stateDir, now);
  const hits = [];
  for (const t of targets) {
    const r = list.find((x) => x.sandbox === sandbox && x.recipient === t.id && x.recipientKind === kindOf(t) && x.kind === "talk");
    if (!r) return null;
    r.sent = (r.sent || []).filter((ts) => now - ts < 3600 * 1000);
    if (r.sent.length >= CAP_PER_HOUR) return null;
    hits.push(r);
  }
  for (const r of hits) r.sent.push(now);
  saveRules(stateDir, list);
  return hits;
}

// revoke N (one rule by number) or "all"; clear SANDBOX (all of one sandbox's, when its world stops). (review #7)
export function revokeRules(stateDir, which, { sandbox = false } = {}) { return withLock(stateDir, () => {
  const list = loadRules(stateDir);
  const keep = which === "all" ? [] : sandbox ? list.filter((r) => r.sandbox !== which) : list.filter((r) => String(r.n) !== String(which));
  saveRules(stateDir, keep);
  return list.length - keep.length;
}); }

export function describeRule(r, now = Date.now()) {
  const left = Math.max(0, r.until - now), h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  const used = (r.sent || []).filter((ts) => now - ts < 3600 * 1000).length;
  return `${r.n}. ${r.sandbox} → ${r.shown}, talk, ${h ? h + " h " : ""}${m} min left, ${used}/${CAP_PER_HOUR} this hour${r.capped ? ` (${r.capped})` : ""}`;
}
