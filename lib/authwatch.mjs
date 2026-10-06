// J136 (Angus: "i was logged out of claude code for some reason so none of the agent windows were working.
// Is there a way to detect that? … can it be part of the hyprpi daemon itself?"): the daemon notices a lapsed
// model login from the errors agents and Thoughts already report, in plain code (no model call: the model is
// what's broken), tells Angus ONCE (a critical desktop notification + a red mark on the bar + one line to every
// world's Thoughts, with the fix), watches the credentials file for the login coming back (only each entry's
// type and expiry time are read; never a token), then clears the mark and tells every agent that failed
// mid-turn to carry on (a hyprpi prompt: held in its queue if it's busy, J133).
//
// Seen here (2026-10-06 08:58–09:10 CDT, every Claude agent):
//   OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/
//   v1/oauth/token; details=Error: HTTP request failed. status=400; …; body={"error": "invalid_grant",
//   "error_description": "Refresh token expired"}
// pi keeps the login in ~/.pi/agent/auth.json (anthropic: type oauth, a ~8 h access token that pi refreshes by
// itself; the refresh token's own lifetime isn't stored, so a lapse can't be predicted from the file).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Network trouble is not a lapsed login (a refresh that couldn't reach the server, timeouts, overload).
const NETWORK = /unable to connect|connectionrefused|failedtoopensocket|typo in the url|econn(?:refused|reset)|etimedout|enotfound|eai_again|timed out|socket connection was closed|network ?error|connection error|\b(?:429|5\d\d)\b|overloaded|rate.?limit/i;
const AUTH = [
  /invalid_grant|refresh token (?:has )?(?:expired|been revoked|is invalid)/i,
  /authentication_error|permission_error.*oauth|oauth token (?:has )?expired|invalid (?:x-)?api[- ]?key|incorrect api key|invalid bearer token|unauthori[sz]ed/i,
  /please (?:run \/login|log ?in|re-?authenticate|sign in)|not logged in|login (?:has )?expired|credentials? (?:not configured|expired|missing)|credentials_not_configured|no api key (?:found )?for/i,
  /\b401\b/,
];
const PROVIDER_WORDS = [[/anthropic|claude/i, "anthropic"], [/openai|codex|chatgpt/i, "openai-codex"], [/openrouter/i, "openrouter"]];

// An error text → { provider } when it means the login lapsed, else null. `provider` (from the failing
// message) wins over a guess from the text.
export function classifyAuthError(text, provider = "") {
  const t = String(text || "");
  if (!t) return null;
  const refresh = t.match(/oauth refresh failed for ([\w.-]+)/i);
  if (refresh) {
    // The refresh request itself got an HTTP answer (400 invalid_grant, 401) = the login is gone; one that
    // never reached the server is the network. An old extension cuts the text at 160 chars, right after
    // "HTTP request failed.": an HTTP failure of the token endpoint counts.
    if (NETWORK.test(t.replace(/HTTP request failed\.?/i, "")) && !/invalid_grant|status=40[013]/.test(t)) return null;
    if (!/HTTP request failed|invalid_grant|status=40[013]|expired|revoked/i.test(t)) return null;
    return { provider: refresh[1].toLowerCase() };
  }
  if (!AUTH.some((r) => r.test(t))) return null;
  if (/\b(?:429|529|503|502|500)\b|overloaded|rate.?limit/i.test(t)) return null;
  if (/auth context mismatch/i.test(t)) return null; // codex's scope mismatch: not a login
  let p = String(provider || "");
  if (!p) for (const [re, name] of PROVIDER_WORDS) if (re.test(t)) { p = name; break; }
  return { provider: p || "anthropic" };
}

const LABEL = { anthropic: "Claude", "openai-codex": "ChatGPT/Codex", openrouter: "OpenRouter" };
const label = (p) => LABEL[p] || p;

// Only the shape of each entry (type, expiry, which fields exist), never a value of a secret.
export function readLoginMeta(file) {
  let st, raw;
  try { st = fs.statSync(file); raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  const out = { mtime: st.mtimeMs, providers: {} };
  for (const [k, v] of Object.entries(raw || {})) if (v && typeof v === "object") out.providers[k] = { type: String(v.type || ""), expires: Number(v.expires) || 0, hasRefresh: !!v.refresh, hasKey: !!(v.key || v.access) };
  raw = null;
  return out;
}

export function createAuthWatch({ stateDir, log = () => {}, policy, deps, now = () => Date.now() }) {
  const stateFile = path.join(stateDir, "auth.json");     // the watch's own state (who stalled)
  const alertFile = path.join(stateDir, "alert.json");    // what the bar widget shows (agf.hyprpi-login)
  let S = { lapses: {}, warned: {} };
  try { S = { lapses: {}, warned: {}, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch { /* first run */ }
  const recent = new Map(); // provider → [{ key, name, thoughts, ts }]
  const save = () => {
    try { fs.writeFileSync(stateFile + ".tmp", JSON.stringify(S, null, 1)); fs.renameSync(stateFile + ".tmp", stateFile); } catch (e) { log("auth: save", e.message); }
    writeAlert();
  };
  const P = () => { const a = policy() || {}; return { enabled: a.enabled !== false, minAgents: Math.max(1, Number(a.minAgents) || 2), windowSeconds: Math.max(10, Number(a.windowSeconds) || 120), thoughtsTrigger: a.thoughtsTrigger !== false, checkSeconds: Math.max(5, Number(a.checkSeconds) || 15), carryOn: a.carryOn !== false, notify: a.notify !== false, warnHours: Number(a.warnHours ?? 24), providers: Array.isArray(a.providers) ? a.providers : ["anthropic"], fix: a.fix || {}, authFile: a.authFile || "" }; };
  const authFile = () => {
    const f = P().authFile || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "auth.json");
    return f.replace(/^~(?=\/|$)/, os.homedir());
  };
  const fixFor = (p) => P().fix[p] || P().fix.default || `in any agent window type /login and choose ${label(p)} (then finish the sign-in in the browser)`;
  const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

  function writeAlert() {
    const items = Object.entries(S.lapses).map(([p, l]) => ({ kind: "login", provider: p, title: `${label(p)} login expired`, text: `${label(p)} login expired at ${hhmm(l.since)}: ${l.stalled.length} agent${l.stalled.length === 1 ? "" : "s"} stopped. Fix: ${fixFor(p)}.`, since: l.since }));
    for (const [p, w] of Object.entries(S.warned)) if (w.active) items.push({ kind: "warn", provider: p, title: `${label(p)} login expires soon`, text: `${label(p)} login expires ${new Date(w.expires).toLocaleString()}. Fix: ${fixFor(p)}.`, since: w.at });
    const v = { active: items.some((i) => i.kind === "login"), warn: items.some((i) => i.kind === "warn"), items, updated: now() };
    try { fs.writeFileSync(alertFile + ".tmp", JSON.stringify(v, null, 1)); fs.renameSync(alertFile + ".tmp", alertFile); } catch (e) { log("auth: alert file", e.message); }
  }

  function stall(l, who) {
    if (!l.stalled.some((s) => s.key === who.key)) l.stalled.push({ key: who.key, name: who.name, thoughts: !!who.thoughts, room: who.room || "", ts: now() });
  }

  // An error from an agent (who: { key: agent id, name, room }) or a Thoughts (who: { key: "thoughts:C", thoughts: true, room }).
  function report(who, text, provider = "") {
    const P0 = P();
    if (!P0.enabled) return null;
    const c = classifyAuthError(text, provider);
    if (!c) return null;
    const p = c.provider, t = now();
    const lapse = S.lapses[p];
    if (lapse) { stall(lapse, who); save(); return { provider: p, lapsed: true, already: true }; }
    const list = (recent.get(p) || []).filter((r) => t - r.ts <= P0.windowSeconds * 1000 && r.key !== who.key);
    list.push({ ...who, ts: t }); recent.set(p, list);
    const distinct = new Set(list.map((r) => r.key)).size;
    const byThoughts = P0.thoughtsTrigger && list.some((r) => r.thoughts);
    log(`auth: ${who.name || who.key} hit a ${p} login error (${distinct} in ${P0.windowSeconds} s)`);
    if (distinct < P0.minAgents && !byThoughts) return { provider: p, lapsed: false, count: distinct };
    // Declared: once per lapse.
    const l = S.lapses[p] = { since: t, stalled: [], notified: false };
    for (const r of list) stall(l, r);
    recent.delete(p);
    save();
    raise(p, l);
    return { provider: p, lapsed: true };
  }

  function raise(p, l) {
    const fix = fixFor(p), names = l.stalled.map((s) => s.name).join(", ") || "the login is gone from pi's auth.json";
    log(`auth: ${p} login LAPSED (${names})`);
    if (P().notify) deps.notify({ title: `${label(p)} login expired`, body: `Agents can't reach ${label(p)} (${names}). Fix: ${fix}. They carry on by themselves once you're logged in again.`, critical: true });
    for (const room of deps.rooms()) deps.note(room, `🔑 ${label(p)} login expired (${hhmm(l.since)}; seen by ${names}). Every agent on ${label(p)} is stuck until Angus logs in again: ${fix}. hyprpi has told him (notification + bar); once he's back in, the stuck agents are told to carry on automatically. Don't retry them yourself.`);
    l.notified = true; save();
  }

  // The login works again (seen from the credentials file, or an agent's successful turn after an auth error).
  function recover(p, how) {
    const l = S.lapses[p];
    if (!l) return null;
    delete S.lapses[p]; delete S.warned[p]; save();
    const P0 = P(), told = [], skipped = [];
    if (P0.carryOn) for (const s of l.stalled) {
      const text = `[hyprpi] The ${label(p)} login is back (it lapsed at ${hhmm(l.since)} and your turn stopped on a login error). Carry on with what you were doing; if it was finished, just say so in one line.`;
      try { if (deps.carryOn(s, text)) told.push(s.name); else skipped.push(s.name); } catch (e) { skipped.push(s.name); log("auth: carry on", s.name, e.message); }
    }
    log(`auth: ${p} login back (${how}); told to carry on: ${told.join(", ") || "none"}${skipped.length ? `; not told (gone or working): ${skipped.join(", ")}` : ""}`);
    if (P0.notify) deps.notify({ title: `${label(p)} login is back`, body: told.length ? `Told ${told.length} stopped agent${told.length === 1 ? "" : "s"} to carry on: ${told.join(", ")}.` : "No agent was waiting.", critical: false });
    for (const room of deps.rooms()) deps.note(room, `🔑 ${label(p)} login is back (${how}); told to carry on: ${told.join(", ") || "nobody"}.`);
    return { provider: p, told, skipped };
  }

  // A turn that worked: on the lapsed provider, the login is back.
  function ok(who, provider = "") {
    const p = String(provider || "");
    if (p && S.lapses[p]) return recover(p, `${who.name || who.key}'s turn worked`);
    return null;
  }

  let lastMeta = null;
  function tick() {
    const P0 = P();
    if (!P0.enabled) return;
    const meta = readLoginMeta(authFile()), t = now();
    // Recovery: the file was rewritten after the lapse and holds a live login for that provider (/login).
    for (const [p, l] of Object.entries(S.lapses)) {
      const e = meta?.providers?.[p];
      if (meta && e && meta.mtime > l.since && (e.type !== "oauth" || e.expires > t + 60e3)) recover(p, "new login in auth.json");
    }
    // Early warning: a login whose expiry is the real end (no refresh token to renew it) within warnHours.
    // Anthropic's entry has a refresh token (its 8 h access token renews itself), so no warning applies.
    for (const p of P0.providers) {
      const e = meta?.providers?.[p], w = S.warned[p];
      const soon = !!(e && e.type === "oauth" && !e.hasRefresh && e.expires && e.expires - t < P0.warnHours * 3600e3 && e.expires > t);
      if (soon && !(w?.active && w.expires === e.expires)) {
        S.warned[p] = { active: true, expires: e.expires, at: t }; save();
        if (P0.notify) deps.notify({ title: `${label(p)} login expires soon`, body: `It ends ${new Date(e.expires).toLocaleString()}. Fix ahead of time: ${fixFor(p)}.`, critical: false });
        for (const room of deps.rooms()) deps.note(room, `🔑 ${label(p)} login expires ${new Date(e.expires).toLocaleString()}; Angus is told.`);
      } else if (!soon && w?.active) { S.warned[p] = { active: false }; save(); }
      // Logged out (the entry vanished from the file) while agents use it: say so before they fail.
      const had = lastMeta?.providers?.[p];
      if (had && meta && !e && !S.lapses[p]) { S.lapses[p] = { since: t, stalled: [], notified: false }; save(); raise(p, S.lapses[p]); }
    }
    if (meta) lastMeta = meta;
  }

  writeAlert();
  return {
    report, ok, tick, recover,
    status: () => ({ lapses: S.lapses, warned: S.warned, recent: Object.fromEntries([...recent].map(([p, l]) => [p, l.map((r) => r.name || r.key)])), authFile: authFile(), alertFile }),
    checkMs: () => P().checkSeconds * 1000,
  };
}
