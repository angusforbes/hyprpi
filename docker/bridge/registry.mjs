// Host-agent registration for the Doorman bridge (J407, Angus: "if a claude code agent registers to connect to the Doorman/relay then that
// can be what's used to process the job on the host … we may not know if we have agents on the host side, so have to check if someone has
// registered"). A host agent (Claude Code, Codex, a script) registers with a name, its harness, a capability summary and optionally the
// sandboxes it serves, then heartbeats; one that stops heartbeating expires. The relay is the only writer of the registry
// (STATE/bridge/agents.json, host-only): it applies register / heartbeat / unregister one at a time like the job operations.
// Registration grants nothing new: it only lets an agent CLAIM a job (the bridge's existing powers), and tells the relay and the
// sandbox whether anyone is there. A token is returned once at register and stored only as its hash.
import crypto from "node:crypto";
import { cleanText } from "./core.mjs";

export const TTL_S = 120, HEARTBEAT_S = 30, MAX_AGENTS = 20;
export const REG_OPS = new Set(["register", "heartbeat", "unregister"]);
const SB_RE = /^[A-Za-z0-9._-]{1,60}$/;
const hash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const one = (s, max) => { const c = cleanText(s, max); return c == null ? null : c.replace(/\s+/g, " "); };
// a name or harness shown to the owner and on the sandbox's card: letters, digits and a few separators only (no Markdown, links or brackets)
const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._:@-]{0,59}$/u;

export const empty = () => ({ agents: {} });
// a registration that is still alive (heartbeat within TTL_S)
// (RegReview) a registration's full shape: anything else is dropped as malformed, never live
export const wellFormed = (k, a) => /^[0-9a-f]{64}$/.test(String(k)) && !!a && typeof a === "object" && !Array.isArray(a) && WORD_RE.test(String(a.name)) && WORD_RE.test(String(a.harness))
  && typeof a.caps === "string" && Array.isArray(a.scope) && a.scope.length <= 10 && a.scope.every((x) => SB_RE.test(String(x))) && Number.isFinite(Date.parse(a.since)) && Number.isFinite(Date.parse(a.last)) && typeof a.on_demand === "boolean";
export const sanitize = (reg) => ({ agents: Object.fromEntries(Object.entries(reg && typeof reg.agents === "object" && reg.agents && !Array.isArray(reg.agents) ? reg.agents : {}).filter(([k, a]) => wellFormed(k, a))) });
export const isLive = (a, nowMs = Date.now()) => !!a && typeof a === "object" && typeof a.name === "string" && nowMs - Date.parse(a.last) < TTL_S * 1000; // (a malformed entry is never live)
export function lookup(reg, token, nowMs = Date.now()) { const a = token ? sanitize(reg).agents[hash(token)] : null; return a && isLive(a, nowMs) ? a : null; }

// The live agents that serve a sandbox (no scope = all), oldest first: what the relay shows on a held item and the card.
export function liveFor(reg, sandbox, nowMs = Date.now()) {
  return Object.values(sanitize(reg).agents).filter((a) => isLive(a, nowMs) && (!a.scope?.length || a.scope.includes(sandbox)))
    .sort((x, y) => String(x.since).localeCompare(String(y.since)));
}
export const label = (a) => `${a.name} (${a.harness}${a.on_demand ? ", on demand" : ""})`;

// Drop expired registrations. → { reg, removed: [names] }
export function prune(reg, nowMs = Date.now()) {
  const agents = {}, removed = [];
  for (const [k, a] of Object.entries(sanitize(reg).agents)) (isLive(a, nowMs) ? (agents[k] = a) : removed.push(a.name));
  return { reg: { agents }, removed };
}

// One registry operation. op = { op: register|heartbeat|unregister, name, harness, caps, scope, on_demand, agent_token }.
// → { reply, reg? } (no reg = nothing changes)
export function applyReg(reg, op, nowMs = Date.now()) {
  const no = (text) => ({ reply: { ok: false, text } });
  if (!op || !REG_OPS.has(op.op)) return no("unknown registration operation");
  const cur = prune(reg || empty(), nowMs).reg;
  if (op.op === "register") {
    const name = one(op.name, 60), harness = one(op.harness || "unknown", 40), caps = one(op.caps || "", 300);
    if (!name || !harness || caps == null) return no("register needs a name (60 bytes), a harness (40) and an optional capability summary (300)");
    if (!WORD_RE.test(name) || !WORD_RE.test(harness)) return no("name and harness: letters, digits, spaces and . _ : @ - only");
    const scope = op.scope == null ? [] : Array.isArray(op.scope) && op.scope.length <= 10 && op.scope.every((s) => SB_RE.test(String(s))) ? op.scope.map(String) : null;
    if (!scope) return no("scope: a list of sandbox names (at most 10)");
    if (Object.keys(cur.agents).length >= MAX_AGENTS) return no(`at most ${MAX_AGENTS} host agents can be registered at once`);
    if (Object.values(cur.agents).some((a) => a.name === name)) return no(`a live host agent is already registered as "${name}"; pick another name or wait for it to expire (${TTL_S} s without a heartbeat)`);
    const token = crypto.randomBytes(16).toString("hex");
    const a = { name, harness, caps, scope, on_demand: op.on_demand === true, since: iso(nowMs), last: iso(nowMs) };
    return { reply: { ok: true, text: `registered as ${label(a)}; heartbeat at least every ${HEARTBEAT_S} s (it expires after ${TTL_S} s without one)`, agent_token: token, ttl_s: TTL_S, heartbeat_s: HEARTBEAT_S }, reg: { agents: { ...cur.agents, [hash(token)]: a } } };
  }
  const k = op.agent_token ? hash(op.agent_token) : "", a = k && cur.agents[k];
  if (!a) return no("not registered (unknown or expired agent token): register again");
  if (op.op === "heartbeat") return { reply: { ok: true, text: `alive until ${iso(nowMs + TTL_S * 1000)}` }, reg: { agents: { ...cur.agents, [k]: { ...a, last: iso(nowMs) } } } };
  const { [k]: _gone, ...rest } = cur.agents; // unregister
  return { reply: { ok: true, text: `unregistered ${a.name}` }, reg: { agents: rest } };
}

// The mode for a sandbox whose Doorman uses the bridge: who would do a free-form job now. runnerOn = the per-job runner is installed
// (an on-demand agent that starts when a job is approved).
export function modeFor(reg, sandbox, { runnerOn = false, nowMs = Date.now() } = {}) {
  const live = liveFor(reg, sandbox, nowMs).map(label);
  if (runnerOn) live.push("the per-job runner (on demand)");
  return { mode: live.length ? "host agent available" : "agent-free", agents: live };
}
// The host card's line for it (J407 (3)): what a sandbox agent and its Doorman should know before asking.
export function cardLine(m) {
  return m.mode === "agent-free"
    ? "Host agents: none available right now (agent-free). Fixed request types (a note for Angus, share a project, send a host file, allow a web host), research, GPU leases and task changes still work; a free-form request is refused at once with \"no host agent available\"."
    : `Host agents: available (${m.agents.join(", ")}). A free-form request your Doorman drafts waits for Angus's approval, then one of them does it and the outcome comes back to you.`;
}
