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
export function list({ all = false } = {}) {
  let names = []; try { names = fs.readdirSync(reqDir()).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out = []; let bad = 0;
  for (const n of names) { if (!validId(n.slice(0, -5))) { bad++; continue; } const r = readRec(n.slice(0, -5)); if (r?.type !== "host_job") continue; const v = view(r); if (all || v.state === "waiting") out.push(v); }
  // (Pkgsort) a record whose name isn't a job id (<sandbox>--<6 hex>, as the relay makes them) is skipped, but said
  if (bad) process.stderr.write(`doorman-bridge: skipped ${bad} record(s) in ${reqDir()} whose name isn't a job id (<sandbox>--<6 hex digits>)\n`);
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
