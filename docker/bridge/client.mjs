// The Doorman bridge's client side (J371), used by the CLI and the MCP server: it READS job records and asks the relay
// to change them by dropping a request into STATE/bridge/in and waiting for the reply. It never writes a record, a
// decision or a config file itself. The state folder: DOORMAN_STATE, else $XDG_STATE_HOME/hyprpi/sbx-relay (the hyprpi
// relay; pi-doorman sets its own default).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { view, validId } from "./core.mjs";

export const stateDir = () => process.env.DOORMAN_STATE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "hyprpi", "sbx-relay");
const reqDir = () => path.join(stateDir(), "requests");
const readRec = (id) => { if (!validId(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(reqDir(), `${id}.json`), "utf8")); } catch { return null; } };

// jobs for a host agent; by default the ones it can claim (waiting)
export function list({ all = false, quiet = false } = {}) {
  let names = []; try { names = fs.readdirSync(reqDir()).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out = []; let bad = 0;
  for (const n of names) { if (!validId(n.slice(0, -5))) { bad++; continue; } const r = readRec(n.slice(0, -5)); if (r?.type !== "host_job") continue; const v = view(r); if (all || v.state === "waiting") out.push(v); }
  // (Pkgsort) a record whose name isn't a job id (<sandbox>--<6 hex>, as the relay makes them) is skipped, but said
  if (bad && !quiet) process.stderr.write(`doorman-bridge: skipped ${bad} record(s) in ${reqDir()} whose name isn't a job id (<sandbox>--<6 hex digits>)\n`);
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
export function show(id) { const r = readRec(id); return r?.type === "host_job" ? view(r) : null; }

// one change, applied by the relay; resolves to its reply { ok, text, ... }
export async function request(op, { timeoutMs = 15000 } = {}) {
  const IN = path.join(stateDir(), "bridge", "in"), OUT = path.join(stateDir(), "bridge", "out");
  if (!fs.existsSync(IN)) return { ok: false, text: `no bridge at ${stateDir()} (is the relay running with the bridge on?)` };
  const rid = crypto.randomBytes(12).toString("hex"), f = path.join(IN, `${rid}.json`), o = path.join(OUT, `${rid}.json`);
  fs.writeFileSync(f + ".tmp", JSON.stringify(op), { mode: 0o600 }); fs.renameSync(f + ".tmp", f);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = JSON.parse(fs.readFileSync(o, "utf8")); try { fs.unlinkSync(o); } catch { /* */ } return r; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  try { fs.unlinkSync(f); } catch { /* the relay took it after all */ }
  return { ok: false, text: "the relay didn't answer in time (is it running?)" };
}

// (J379 red team) claim tokens are NOT cached for the user: any process of the user could have used another agent's claim.
// The caller keeps the token claim returned and passes it back; a per-job run (runner.mjs) gets its own in DOORMAN_BRIDGE_TOKEN.
const tok = (id, token) => token || (process.env.DOORMAN_BRIDGE_JOB === id && process.env.DOORMAN_BRIDGE_TOKEN) || "";
const vid = (id) => (validId(id) ? null : { ok: false, text: "bad job id" });

// the five operations, as the CLI and MCP tools call them
// J407: a claim needs a live registration (agent token from register); it is made in the registered name
export async function claim(id, by, leaseS, agentToken = process.env.DOORMAN_BRIDGE_AGENT_TOKEN || "") { return vid(id) || request({ op: "claim", id, by, lease_s: leaseS, agent_token: agentToken }); }
// J407: registration (the relay keeps the registry; the token is returned once by register)
export async function register({ name, harness, caps = "", scope, onDemand = false }) { return request({ op: "register", name, harness, caps, ...(scope ? { scope } : {}), on_demand: !!onDemand }); }
export async function heartbeat(agentToken) { return request({ op: "heartbeat", agent_token: agentToken }); }
export async function unregister(agentToken) { return request({ op: "unregister", agent_token: agentToken }); }
// the live registrations and each sandbox's mode, read-only (no tokens: the registry holds only their hashes)
export function agents() {
  let reg = {}, mode = {}; try { reg = JSON.parse(fs.readFileSync(path.join(stateDir(), "bridge", "agents.json"), "utf8")); } catch { /* */ } try { mode = JSON.parse(fs.readFileSync(path.join(stateDir(), "bridge", "mode.json"), "utf8")).sandboxes || {}; } catch { /* */ }
  const live = Object.values(reg.agents || {}).filter((a) => Date.now() - Date.parse(a.last) < 120000).map(({ name, harness, caps, scope, on_demand, since, last }) => ({ name, harness, caps, scope, on_demand, since, last }));
  return { ok: true, agents: live, modes: mode };
}
export async function renew(id, by, leaseS, token) { return vid(id) || request({ op: "renew", id, by, lease_s: leaseS, token: tok(id, token) }); }
export async function release(id, by, token) { return vid(id) || request({ op: "release", id, by, token: tok(id, token) }); }
export async function ask(id, by, text, token) { return vid(id) || request({ op: "ask", id, by, text, token: tok(id, token) }); }
export async function report(id, by, { state, summary, ran = [], changed = [] }, token) {
  return vid(id) || request({ op: "report", id, by, state, summary, ran, changed, token: tok(id, token) });
}

// J412 (spec 2.3.4): the relay's receipts for decisions on settings proposals, newest last; only the given proposer's (no tokens involved:
// what Angus decided and his text for that proposal, nothing else)
export function receipts(by) {
  let lines = []; try { lines = fs.readFileSync(path.join(stateDir(), "bridge", "receipts.jsonl"), "utf8").trim().split("\n").filter(Boolean).slice(-200); } catch { /* none yet */ }
  const who = String(by || "");
  return { ok: true, receipts: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.by === who).slice(-20) };
}

// J431: wait for work instead of being nudged. Resolves as soon as (a) a job in the agent's scope is waiting (anyone may claim it: the
// first claim wins, so the claim can still fail; then wait again), or (b) one of `mine` (jobs this agent claimed) has a new answer from
// the owner, or (c) the timeout passes ({ event: "none" }: call again). Read-only, like list/show: it grants nothing. scope: sandbox
// names (empty: all). seen: "id#n" keys of answers already handed over (the caller keeps the set). Jobs still being scoped (J428:
// scoping, scope_held) aren't waiting yet, so they never wake it.
export const WAIT_MAX_S = 290, WAIT_DEFAULT_S = 240; // below Claude Code's limits (stdio idle 30 min, hard MCP_TOOL_TIMEOUT); a harness with a shorter one passes timeout_s
export function waitSeconds(t) { const d = Number(process.env.DOORMAN_BRIDGE_WAIT_S) || WAIT_DEFAULT_S, n = t === undefined || t === null || t === "" ? d : Number(t); return Math.min(WAIT_MAX_S, Math.max(1, Number.isFinite(n) ? Math.round(n) : d)); }
// mine: job ids, or a Map id -> the caller's claim token (then an answer counts only while that exact claim stands, so a later session with
// the same name and a new claim isn't "you"). owner: the agent's registered name; an answer counts only while that agent still holds the job's claim (a lapsed claim taken by another agent
// isn't "yours"). asked: "id#n" of questions the caller asked (when given, only those answers count). skip: job ids not to offer.
export async function waitForJob({ scope = [], mine = [], owner = "", asked = null, seen = new Set(), skip = new Set(), timeoutS, pollMs = 1000, signal } = {}) {
  const sc = new Set((scope || []).map(String)), inScope = (j) => !sc.size || sc.has(String(j.sandbox));
  const end = Date.now() + waitSeconds(timeoutS) * 1000;
  for (;;) {
    for (const [id, tk] of mine instanceof Map ? mine : (mine || []).map((x) => [x, ""])) { // (WaitReview HIGH 2: still mine: by claim token when known, else by name)
      const rec = readRec(id); if (tk && rec?.claim?.token !== tk) continue;
      const j = show(id); if (!j || j.state === "asked" || (owner && j.claimed_by !== owner)) continue;
      const q = (j.questions || []).find((x) => x.answer !== null && x.answer !== undefined && !seen.has(`${id}#${x.n}`) && (!asked || asked.has(`${id}#${x.n}`)));
      if (q) { seen.add(`${id}#${q.n}`); return { ok: true, event: "answer", text: `the owner answered your question ${q.n} on ${id}`, job: j }; } }
    const w = list({ quiet: true }).find((j) => inScope(j) && !skip.has(j.id));
    if (w) return { ok: true, event: "job", text: `job ${w.id} is waiting: claim_job it (another agent may claim it first; then wait again)`, job: w };
    if (Date.now() >= end || signal?.aborted) return { ok: true, event: "none", text: "no job yet: call wait_for_job again" };
    await new Promise((res) => setTimeout(res, Math.min(pollMs, Math.max(10, end - Date.now()))));
  }
}
