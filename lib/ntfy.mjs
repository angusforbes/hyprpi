// J528 (Angus: "maybe bonks and decisions should be sent" … "make the name of the ntfy topic be configurable in hyprpi
// configs … include helpful information in the notification as needed. if a user wants better security they can choose a
// more secure topic name"): push what needs Angus to his phone through ntfy (https://ntfy.sh, or your own server).
//
// Config: hyprpi.jsonc "phone": { "ntfy": { enabled, server, topic, kinds, maxPerHour, click } } (lib/policy.mjs). Read on
// every push, so an edit applies at once. brev-autostop reads the same topic and server (`hyprpi ntfy config`).
// Kinds: "bonk" (an agent needs Angus) and "decision" (a Decide item on a card, a held sandbox message waiting for
// 1/2/3). Never job reports, room chatter, stalls or upkeep: nothing else calls push().
// One push per item: every push has a key (the card item, the held message's id, the agent's block), and a key is sent at
// most once (remembered 7 days in STATE/phone-push.json). maxPerHour caps a burst (default 12; 0 = no cap); what goes over it is
// logged and dropped, never queued to arrive late. ntfy being down never holds anything up (10 s timeout, errors logged).
// J663 (no silent success, J662): push() hands the push to ntfy and returns { queued: true, confirmed } at once; `confirmed`
// resolves to { ok: true, status } only when ntfy answered 2xx, else { ok: false, why } (an error status, a network error, or
// no answer within the timeout: then it may or may not have arrived). Nothing here says "sent" before ntfy's answer. A failed
// or capped push also calls onTrouble({ kind: "failed" | "capped", why, key, world, count }) ONCE per spell of trouble (the
// daemon puts it in that world's Thoughts thread); later failures in the same spell are only logged and counted, and the next
// push ntfy confirms ends the spell (logged, with how many didn't get through). The spell is kept in STATE/phone-push.json.
// Tests: HYPRPI_PHONE_PUSH_LOG=FILE writes each push as a JSON line there instead of sending it (that file is the receiver).
import fs from "node:fs";
import path from "node:path";
import { loadPolicy } from "./policy.mjs";

const WEEK = 7 * 864e5;
export const ntfyConfig = (pol = loadPolicy()) => {
  const n = { enabled: false, server: "https://ntfy.sh", topic: "", kinds: ["bonk", "decision"], maxPerHour: 12, click: "", ...((pol.phone || {}).ntfy || {}) };
  n.server = String(n.server || "https://ntfy.sh").replace(/\/+$/, "");
  n.topic = String(n.topic || "").trim();
  n.kinds = Array.isArray(n.kinds) ? n.kinds.map(String) : ["bonk", "decision"];
  n.maxPerHour = Math.max(0, Number(n.maxPerHour ?? 12) || 0);
  return n;
};
const clip = (s, n) => { const t = String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// The message: who and where first, then the question, then its options (numbered as Angus answers them).
export function phoneMessage(kind, { world = "", agent = "", project = "", text = "", options = [], recommend = "", hint = "", title: own = "" } = {}) {
  const where = [world && `World ${world}`, agent, project && `@${String(project).replace(/^@/, "")}`].filter(Boolean).join(" · ");
  // every option (a long list is shortened per option, never cut off: the recommended one may be last)
  const all = options || [], each = all.length > 8 ? 60 : 120; // (the 3500-character message cap still applies)
  const opts = all.map((o, i) => { const k = String(o?.key ?? i + 1); return `${k}. ${clip(o?.text ?? o, each)}${recommend && String(recommend) === k ? " (recommended)" : ""}`; });
  const body = [where, clip(text, own ? 3000 : 700), ...opts, hint].filter(Boolean).join("\n");
  const title = own ? String(own) /* J650: a reminder round names itself */ : kind === "decision" ? `🔔 Decision${world ? ` (world ${world})` : ""}: ${clip(text.split("\n")[0], 70)}` : `❗ ${agent || "An agent"} needs you${world ? ` (world ${world})` : ""}`;
  return { title: clip(title, 120), message: clip(body, 3500) };
}

export function createPhonePush({ stateDir, log = () => {}, policy = loadPolicy, fetchImpl = globalThis.fetch, now = () => Date.now(), env = process.env, onTrouble = () => {}, timeoutMs = Number(env.HYPRPI_NTFY_TIMEOUT_MS) || 10000 }) {
  const file = path.join(stateDir, "phone-push.json");
  let st = { sent: {}, recent: [] };
  try { st = { sent: {}, recent: [], ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { /* first push */ }
  const save = () => { try { fs.writeFileSync(file + ".tmp", JSON.stringify(st)); fs.renameSync(file + ".tmp", file); } catch (e) { log("phone push: state not saved:", e.message); } };
  // J663: a failed or capped push: counted in this spell of trouble; the first one of the spell is told (onTrouble), once.
  function trouble(kind, why, key, info) {
    const t = now(), tr = (st.trouble ||= { since: t, count: 0, told: false });
    tr.count++; tr.last = t; tr.why = why; tr.kind = kind; tr.key = key;
    const first = !tr.told; tr.told = true; save();
    if (first) { try { onTrouble({ kind, why, key, world: String(info.world || ""), count: tr.count }); } catch (e) { log("phone push: trouble note failed:", e.message); } }
  }
  function confirmedOk(key, status) {
    st.lastOk = now();
    if (st.trouble) { log(`phone push: pushes get through again (${st.trouble.count} didn't since ${new Date(st.trouble.since).toISOString()}; last: ${st.trouble.why})`); delete st.trouble; }
    save(); log(`phone push: sent ${key} (ntfy answered ${status})`);
    return { ok: true, status };
  }
  // -> { sent: false, why } (not handed over), or { queued: true, confirmed: Promise<{ ok: true, status } | { ok: false, why }> }
  function push(kind, info = {}) {
    const n = ntfyConfig(policy());
    if (!n.enabled) return { sent: false, why: "phone.ntfy.enabled is false" };
    if (!n.topic) return { sent: false, why: "no phone.ntfy.topic" };
    if (!n.kinds.includes(kind)) return { sent: false, why: `kind ${kind} isn't in phone.ntfy.kinds` };
    const t = now(), key = `${kind}:${String(info.key || info.text || "").slice(0, 300)}`;
    for (const [k, v] of Object.entries(st.sent)) if (t - v > WEEK) delete st.sent[k];
    st.recent = (st.recent || []).filter((x) => t - x < 3600e3);
    if (st.sent[key]) return { sent: false, why: "already sent (one push per item)" };
    if (n.maxPerHour > 0 && st.recent.length >= n.maxPerHour) { /* 0 = no cap */ log(`phone push: over ${n.maxPerHour}/hour, dropped ${key}`); st.sent[key] = t; save(); const why = `over maxPerHour (${n.maxPerHour})`; trouble("capped", why, key, info); return { sent: false, why }; }
    st.sent[key] = t; st.recent.push(t); save();
    const { title, message } = phoneMessage(kind, info);
    const body = { topic: n.topic, title, message, tags: [kind === "decision" ? "bell" : "exclamation"], priority: kind === "decision" ? 4 : 4, ...(n.click || info.click ? { click: info.click || n.click } : {}) };
    if (env.HYPRPI_PHONE_PUSH_LOG) { // the test log is the receiver: written = confirmed
      try { fs.appendFileSync(env.HYPRPI_PHONE_PUSH_LOG, JSON.stringify({ kind, key, server: n.server, ...body }) + "\n"); return { queued: true, test: true, confirmed: Promise.resolve({ ok: true, test: true }) }; }
      catch (e) { log("phone push log:", e.message); return { queued: true, test: true, confirmed: Promise.resolve({ ok: false, why: e.message }) }; }
    }
    const ac = new AbortController(); let timedOut = false;
    const to = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs); to.unref?.();
    const fail = (why) => { log(`phone push: NOT sent ${key}: ${why}`); trouble("failed", why, key, info); return { ok: false, why }; };
    let confirmed;
    try {
      confirmed = Promise.resolve(fetchImpl(n.server, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ac.signal }))
        .then((r) => { clearTimeout(to); return r.ok ? confirmedOk(key, r.status) : fail(`${n.server} answered ${r.status}`); },
          (e) => { clearTimeout(to); return fail(timedOut ? `no answer from ${n.server} within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} (it may or may not have arrived)` : `${n.server}: ${e?.cause?.code || e?.message || e}`); });
    } catch (e) { clearTimeout(to); confirmed = Promise.resolve(fail(`${n.server}: ${e.message}`)); }
    return { queued: true, confirmed };
  }
  return { push, config: () => ntfyConfig(policy()) };
}
