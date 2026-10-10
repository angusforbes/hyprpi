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
  const out = [];
  for (const n of names) { const r = readRec(n.slice(0, -5)); if (r?.type !== "host_job") continue; const v = view(r); if (all || v.state === "waiting") out.push(v); }
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

// claim tokens kept for the user only: one file per job (~/.cache/doorman-bridge/tokens/<id>, 600), so parallel
// commands never race on a shared file (BridgeReview)
const tokDir = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "doorman-bridge", "tokens");
export function tokens() { const out = {}; try { for (const n of fs.readdirSync(tokDir())) if (validId(n)) out[n] = fs.readFileSync(path.join(tokDir(), n), "utf8").trim(); } catch { /* */ } return out; }
export function saveToken(id, token) {
  if (!validId(id)) return;
  const f = path.join(tokDir(), id);
  if (!token) { try { fs.unlinkSync(f); } catch { /* */ } return; }
  fs.mkdirSync(tokDir(), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, token, { mode: 0o600 }); fs.renameSync(tmp, f);
}

// the five operations, as the CLI and MCP tools call them
export async function claim(id, by, leaseS) { const r = await request({ op: "claim", id, by, lease_s: leaseS }); if (r.ok && r.token) saveToken(id, r.token); return r; }
const tok = (id, token) => { if (token) return token; try { return fs.readFileSync(path.join(tokDir(), id), "utf8").trim(); } catch { return ""; } };
export async function renew(id, by, leaseS, token) { return request({ op: "renew", id, by, lease_s: leaseS, token: tok(id, token) }); }
export async function release(id, by, token) { const r = await request({ op: "release", id, by, token: tok(id, token) }); if (r.ok) saveToken(id, ""); return r; }
export async function ask(id, by, text, token) { return request({ op: "ask", id, by, text, token: tok(id, token) }); }
export async function report(id, by, { state, summary, ran = [], changed = [] }, token) {
  const r = await request({ op: "report", id, by, state, summary, ran, changed, token: tok(id, token) }); if (r.ok) saveToken(id, ""); return r;
}
