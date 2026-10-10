// `doorman`: ONE command for the whole gateway of a world (J380 v2: "when there's so many separate pieces it gets confusing").
// The pieces stay separate processes (the relay is a small core; the heavy or risky work runs in contained workers); this only
// installs, starts, stops and checks them as one thing. Everything it knows about the machine goes through `sys`, so tests can
// run it on a made-up machine.
//
//   doorman status [WORLD]    one readable summary: mode, every piece up or not, held items, last errors
//   doorman doctor [WORLD]    find broken pieces (stale paths, dead units, missing keys) and say how to fix each
//   doorman install [WORLD]   set up the units and timers (relay, Doorman, runner, digests); safe to repeat
//   doorman start|stop [WORLD]
// WORLD is the served sandbox's name (default: the only one in sbx-relay.json).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { modeForSandbox } from "../research/mode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), H = path.resolve(HERE, "../..");
const home = (p) => String(p || "").replace(/^~(?=\/|$)/, os.homedir());
export const paths = () => {
  const cfg = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hyprpi"), st = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "hyprpi");
  return { cfg, st, relayConf: process.env.HYPRPI_RELAY_CONF || path.join(cfg, "sbx-relay.json"), relayState: path.join(st, "sbx-relay"), units: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user") };
};
// the real machine
export const realSys = {
  active: (u) => { const r = spawnSync("systemctl", ["--user", "is-active", u], { encoding: "utf8", timeout: 5000 }); return String(r.stdout).trim(); },
  enabled: (u) => { const r = spawnSync("systemctl", ["--user", "is-enabled", u], { encoding: "utf8", timeout: 5000 }); return String(r.stdout).trim(); },
  failed: () => String(spawnSync("systemctl", ["--user", "--failed", "--no-legend", "--plain"], { encoding: "utf8", timeout: 5000 }).stdout || "").split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean),
  sbx: () => { const r = spawnSync("sbx", ["ls"], { encoding: "utf8", timeout: 15000 }); if (r.error || r.status !== 0) return null; const o = {}; for (const l of String(r.stdout).split("\n").slice(1)) { const c = l.trim().split(/\s+/); if (c[0]) o[c[0]] = c[3] || ""; } return o; },
  window: (cls) => { const r = spawnSync("hyprctl", ["-j", "clients"], { encoding: "utf8", timeout: 5000 }); if (r.status !== 0) return null; try { return JSON.parse(r.stdout).some((c) => c.class === cls); } catch { return null; } },
  run: (cmd, args, env = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 120000, env: { ...process.env, ...env } }),
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const count = (d, re = /\.json$/) => { try { return fs.readdirSync(d).filter((f) => re.test(f)).length; } catch { return 0; } };
const tailErrors = (f, n = 400) => { try { const lines = fs.readFileSync(f, "utf8").split("\n").slice(-n); return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.error).slice(-3).map((o) => `${String(o.t || "").slice(11, 19)} ${String(o.error).slice(0, 110)}`); } catch { return []; } };

// Which sandboxes and Doorman belong to a world
export function resolveWorld(world, P = paths()) {
  const conf = readJson(P.relayConf), list = Array.isArray(conf?.sandboxes) ? conf.sandboxes : [];
  const served = list.filter((s) => !s.doorman_for);
  const sb = world ? served.find((s) => s.name === world) : served.length === 1 ? served[0] : null;
  if (!sb) return { error: world ? `no sandbox "${world}" in ${P.relayConf}` : served.length ? `which world? one of: ${served.map((s) => s.name).join(", ")}` : `no sandbox in ${P.relayConf} (see the quick start)`, conf };
  const dm = list.find((d) => d.doorman_for === sb.name) || null;
  return { sb, dm, list, conf };
}

// One piece: { name, state: ok | off | warn | fail, text, fix? }
export function gather(world, sys = realSys, P = paths()) {
  const R = resolveWorld(world, P); if (R.error) return { error: R.error, pieces: [] };
  const { sb, dm } = R, S = sb.name, pieces = [], add = (name, state, text, fix) => pieces.push({ name, state, text, ...(fix ? { fix } : {}) });
  const up = (u) => sys.active(u) === "active";
  const mode = modeForSandbox(P.cfg, S);
  const sbxs = sys.sbx();
  // relay
  const relayUp = up("hyprpi-sbx-relay");
  add("relay", relayUp ? "ok" : "fail", relayUp ? "running (hyprpi-sbx-relay)" : "not running", "doorman start");
  // sandbox + doorman
  const sbState = sbxs ? sbxs[S] : undefined;
  add("sandbox", sbxs === null ? "warn" : sbState === "running" ? "ok" : "fail", sbxs === null ? "can't ask sbx (is its daemon up?)" : sbState ? `${S} is ${sbState}` : `${S} doesn't exist in sbx`, sbxs && sbState && sbState !== "running" ? `sbx run ${S}` : "");
  if (!dm) add("doorman", "fail", `no Doorman entry (doorman_for: "${S}") in sbx-relay.json`, "doorman install");
  else {
    const du = `hyprpi-doorman-${dm.name}`, dUp = up(du), dbx = sbxs ? sbxs[dm.name] : undefined;
    add("doorman", dUp && dbx === "running" ? "ok" : dUp ? "warn" : "fail", dUp ? `${dm.name} running (${dm.visibility || "strict"} window mode${dbx && dbx !== "running" ? `; its sandbox is ${dbx}` : ""})` : `${dm.name} is not running`, dUp ? "" : `doorman start ${S}`);
    const vis = dm.visibility;
    if (vis === "developer" || vis === "observer") { const w = sys.window(`hyprpi-doorman-${dm.name}`); add("window", w === null ? "off" : w ? "ok" : "warn", w === null ? "can't check (no desktop session)" : w ? "the decision window is open" : "the decision window isn't open (it opens when the Doorman starts)", w === false ? `docker/doorman/doorman.sh window ${dm.name}` : ""); }
  }
  // world helpers
  for (const [k, u] of [["helper", `hyprpi-${S}-helper`], ["shares", `hyprpi-${S}-shares`]]) { const a = sys.active(u); if (a === "active") add(k, "ok", `${u} running`); else add(k, "off", `${u} not running (only needed for a world with its own windows/shares)`); }
  // mode
  add("mode", mode.note ? "warn" : "ok", `${mode.mode}${mode.note ? ` (${mode.note})` : ""}`);
  // host agents + runner
  const bridge = dm && dm.host_agents === "bridge";
  if (!bridge) add("host agents", "off", dm && dm.host_agents === false ? "off (agent-free, fixed request types only)" : "off (not configured: host_agents)", "");
  else {
    const reg = readJson(path.join(P.relayState, "bridge", "agents.json")), live = Object.values(reg?.agents || {}).filter((a) => a && Date.now() - Date.parse(a.last) < 120000);
    const ru = sys.active("doorman-bridge-runner.path");
    add("runner", ru === "active" ? "ok" : "fail", ru === "active" ? "doorman-bridge-runner.path active (one agent run per approved job)" : "the per-job runner isn't installed or active", "doorman install");
    add("host agents", live.length || ru === "active" ? "ok" : "warn", `${live.length} registered${live.length ? ": " + live.map((a) => a.name).join(", ") : ""}${ru === "active" ? "; the runner starts one per job" : ""}`);
  }
  // digests
  for (const [k, u] of [["digest (hourly)", "hyprpi-research-digest.timer"], ["digest (daily)", "hyprpi-research-daily.timer"]]) { const e = sys.enabled(u), a = sys.active(u); add(k, e === "enabled" && a === "active" ? "ok" : "fail", e === "enabled" && a === "active" ? "scheduled" : "timer missing or stopped", "doorman install"); }
  // phone decisions, remote app
  const phone = dm && (dm.phone_decisions ?? R.conf?.phone_decisions);
  add("phone decisions", "off", phone === true ? "on" : phone === false || phone === undefined ? "off" : `unknown value ${JSON.stringify(phone)}`);
  const ra = sys.active("hyprpi-remote-control"); add("remote app", ra === "active" ? "ok" : "off", ra === "active" ? "the phone web app is up" : "not running (optional)");
  // held + errors
  const pend = fs.existsSync(path.join(P.relayState, "pending")) ? fs.readdirSync(path.join(P.relayState, "pending")).filter((f) => f.startsWith(`${dm?.name || S}--`)).length : 0;
  let waiting = 0; try { for (const f of fs.readdirSync(path.join(P.relayState, "requests"))) { const j = readJson(path.join(P.relayState, "requests", f)); if (j && j.sandbox === S && j.type === "host_job" && j.state === "waiting") waiting++; } } catch { /* none */ }
  add("held", pend ? "warn" : "ok", pend ? `${pend} waiting for your decision` : "nothing waiting for you" + (waiting ? `; ${waiting} host job(s) waiting for an agent` : ""));
  const errs = tailErrors(path.join(P.relayState, "log.jsonl"));
  add("last errors", errs.length ? "warn" : "ok", errs.length ? errs.join(" | ") : "none in the relay log");
  return { world: S, doorman: dm?.name || "", mode: mode.mode, pieces };
}

const MARK = { ok: "ok  ", off: "off ", warn: "WARN", fail: "FAIL" };
export function renderStatus(g) {
  if (g.error) return g.error;
  const w = Math.max(...g.pieces.map((p) => p.name.length));
  const bad = g.pieces.filter((p) => p.state === "fail").length, warn = g.pieces.filter((p) => p.state === "warn").length;
  return [`Gateway for ${g.world}: mode ${g.mode}${g.doorman ? `, Doorman ${g.doorman}` : ""}  [${bad ? `${bad} broken` : warn ? `${warn} to look at` : "all fine"}]`, "", ...g.pieces.map((p) => `  ${MARK[p.state]} ${p.name.padEnd(w)}  ${p.text}`), ...(bad ? ["", "Run: doorman doctor " + g.world] : [])].join("\n");
}

// doctor: the same pieces plus static checks of what's on disk
export function doctor(world, sys = realSys, P = paths()) {
  const g = gather(world, sys, P); if (g.error) return { error: g.error, issues: [] };
  const issues = [], add = (what, why, fix) => issues.push({ what, why, fix });
  for (const p of g.pieces) if (p.state === "fail") add(p.name, p.text, p.fix || "");
  const R = resolveWorld(world, P), { sb, dm } = R;
  // units that point at paths that no longer exist, or at a moved project
  let files = []; try { files = fs.readdirSync(P.units).filter((f) => /^(hyprpi-(research|sbx|doorman|world|sandbox)|doorman-)/.test(f) && /\.(service|path|timer)$/.test(f)); } catch { /* none */ }
  for (const f of files) {
    let t = ""; try { t = fs.readFileSync(path.join(P.units, f), "utf8"); } catch { continue; }
    for (const m of t.matchAll(/(?:ExecStart|PathChanged|PathExists|WorkingDirectory)=(.+)/g)) for (const x of m[1].match(/(?:\/[\w.@+-]+)+/g) || []) { if (x.length < 4 || /^\/(usr|bin|etc|run|tmp|dev|proc|sys)\b/.test(x)) continue; if (!fs.existsSync(x)) add(f, `points at ${x}, which doesn't exist (moved or deleted)`, `doorman install ${sb?.name || ""}`.trim()); }
  }
  const failed = sys.failed().filter((u) => /^(hyprpi-|doorman-)/.test(u)); for (const u of failed) add(u, "the unit failed", `systemctl --user reset-failed ${u}; journalctl --user -u ${u} -n 20`);
  // config the pieces need
  if (dm) {
    if (dm.key_file && !fs.existsSync(home(dm.key_file))) add("doorman key", `key_file ${dm.key_file} is missing or unreadable`, "put the model key there (mode 600)");
    for (const k of ["workspace", "inbox", "card"]) if (dm[k] && !fs.existsSync(home(dm[k]))) add(`doorman ${k}`, `${dm[k]} doesn't exist`, `doorman install ${sb.name}`);
    if (dm.visibility === "developer" && g.mode === "strict") add("window mode", "the Doorman's window is in developer mode but the world's mode is strict", "set gateway.mode and visibility together in worlds/<world>.json");
  }
  for (const k of ["workspace", "inbox"]) if (sb[k] && !fs.existsSync(home(sb[k]))) add(`sandbox ${k}`, `${sb[k]} doesn't exist`, "create it");
  const hits = (() => { try { return fs.readdirSync(path.join(P.cfg, "worlds")).filter((f) => f.endsWith(".json")).map((f) => [f, readJson(path.join(P.cfg, "worlds", f))]).filter(([f, w]) => w && (w.sandbox || f.slice(0, -5)) === sb.name); } catch { return []; } })();
  if (hits.length > 1) add("worlds config", `${hits.map(([f]) => f).join(", ")} all name ${sb.name}; the mode fails closed to strict`, "keep one file per world");
  if (!hits.length) add("worlds config", `no worlds/*.json names ${sb.name}: the default mode applies`, "create worlds/<world>.json with a gateway block");
  return { world: g.world, issues };
}
export function renderDoctor(d) {
  if (d.error) return d.error;
  if (!d.issues.length) return `doctor: nothing wrong found for ${d.world}`;
  return [`doctor: ${d.issues.length} thing(s) to fix for ${d.world}`, "", ...d.issues.map((i, n) => `${n + 1}. ${i.what}: ${i.why}${i.fix ? `\n   fix: ${i.fix}` : ""}`)].join("\n");
}

// install / start / stop: call the pieces' own commands, in order; each is idempotent
export function plan(action, world, P = paths()) {
  const R = resolveWorld(world, P); if (R.error) return { error: R.error };
  const { sb, dm } = R, S = sb.name, node = process.execPath, steps = [];
  const relay = [node, path.join(H, "docker/sbx-relay.mjs")], dsh = path.join(H, "docker/doorman/doorman.sh"), bridge = path.join(H, "docker/bridge/doorman-bridge");
  if (action === "stop") {
    if (dm) steps.push({ what: `stop the Doorman ${dm.name}`, cmd: [dsh, "stop", dm.name], env: { DOORMAN_NO_WINDOW: "1" } });
    steps.push({ what: "stop the relay", cmd: [...relay, "stop"] });
    return { steps };
  }
  steps.push({ what: "start the relay", cmd: [...relay, "start"], skipIfActive: "hyprpi-sbx-relay" });
  if (dm) steps.push({ what: `start the Doorman ${dm.name}`, cmd: [dsh, "start", dm.name], env: { DOORMAN_NO_WINDOW: "" }, skipIfActive: `hyprpi-doorman-${dm.name}` });
  if (action === "install") {
    if (dm && dm.host_agents === "bridge") steps.push({ what: "install the per-job runner (path unit)", cmd: [bridge, "runner", "--install"] });
    steps.push({ what: "install the hourly and daily digest timers", cmd: [path.join(H, "docker/research/digest-timer.sh")] });
  }
  return { steps };
}
export function apply(p, sys = realSys, out = console.log) {
  for (const s of p.steps) {
    if (s.skipIfActive && sys.active(s.skipIfActive) === "active") { out(`  already running: ${s.what.replace(/^start /, "")}`); continue; }
    const r = sys.run(s.cmd[0], s.cmd.slice(1), s.env || {});
    out(`  ${r.status === 0 ? "done" : "FAILED"}: ${s.what}${r.status === 0 ? "" : ` (${String(r.stderr || r.stdout || "").trim().split("\n").pop().slice(0, 140)})`}`);
  }
}
