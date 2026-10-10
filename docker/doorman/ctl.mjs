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
import { modeForSandbox, phoneDecisionsFor, withWorldsLock } from "../research/mode.mjs";

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
    add("doorman", dUp && dbx === "running" ? "ok" : dUp ? "warn" : "fail", dUp ? `${dm.name} running (${mode.mode === "open" ? "developer" : mode.mode === "strict" ? "strict" : "safe"} window mode${dbx && dbx !== "running" ? `; its sandbox is ${dbx}` : ""})` : `${dm.name} is not running`, dUp ? "" : `doorman start ${S}`);
    const vis = mode.mode === "open" ? "developer" : mode.mode === "strict" ? "strict" : "safe"; // the window the mode implies (doorman.sh): open = developer, safe/yolo = safe, strict = strict
    if (vis === "developer") { const w = sys.window(`hyprpi-doorman-${dm.name}`); add("window", w === null ? "off" : w ? "ok" : "warn", w === null ? "can't check (no desktop session)" : w ? "the decision window is open" : "the decision window isn't open (it opens when the Doorman starts)", w === false ? `docker/doorman/doorman.sh window ${dm.name}` : ""); }
  }
  // world helpers
  for (const [k, u] of [["helper", `hyprpi-${S}-helper`], ["shares", `hyprpi-${S}-shares`]]) { const a = sys.active(u); if (a === "active") add(k, "ok", `${u} running`); else add(k, "off", `${u} not running (only needed for a world with its own windows/shares)`); }
  // mode
  add("mode", mode.note ? "warn" : "ok", `${mode.mode}${mode.note ? ` (${mode.note})` : ""}`);
  // the host's levels (J380 v3)
  try { const c = configRows(S, P); add("levels", c.levelsError ? "fail" : c.violations.length ? "warn" : "ok", c.levelsError ? c.levelsError : c.violations.length ? `outside the host's levels: ${c.violations.join("; ")}` : "every setting is inside the host's levels", c.violations.length || c.levelsError ? `doorman config ${S}` : ""); } catch (e) { add("levels", "warn", `can't read the settings: ${e.message}`, "fix the worlds files, then doorman config"); }
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
  let phone = false; try { phone = phoneDecisionsFor(P.cfg, S); } catch { /* fail closed */ }
  add("phone decisions", phone ? "ok" : "off", phone ? "on (the world asks for it and the host allows it)" : "off");
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
  for (const p of g.pieces) if (p.state === "fail" || (p.name === "levels" && p.state === "warn")) add(p.name, p.text, p.fix || "");
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
    if (dm && dm.host_agents === "bridge") steps.push({ what: "stop the per-job runner (path unit)", cmd: ["systemctl", "--user", "stop", "doorman-bridge-runner.path"] });
    steps.push({ what: "stop the relay", cmd: [...relay, "stop"] });
    return { steps };
  }
  steps.push({ what: "start the relay", cmd: [...relay, "start"], skipIfActive: "hyprpi-sbx-relay" });
  if (dm) steps.push({ what: `start the Doorman ${dm.name}`, cmd: [dsh, "start", dm.name], env: { DOORMAN_NO_WINDOW: "" }, skipIfActive: `hyprpi-doorman-${dm.name}` });
  if (action === "start" && dm && dm.host_agents === "bridge" && fs.existsSync(path.join(P.units, "doorman-bridge-runner.path"))) steps.push({ what: "start the per-job runner (path unit)", cmd: ["systemctl", "--user", "start", "doorman-bridge-runner.path"] });
  if (action === "install") {
    if (dm && dm.host_agents === "bridge") steps.push({ what: "install the per-job runner (path unit)", cmd: [bridge, "runner", "--install"] });
    steps.push({ what: "install the hourly and daily digest timers", cmd: [path.join(H, "docker/research/digest-timer.sh")] });
  }
  return { steps };
}
export function apply(p, sys = realSys, out = console.log) {
  let allOk = true;
  for (const s of p.steps) {
    if (s.skipIfActive && sys.active(s.skipIfActive) === "active") { out(`  already running: ${s.what.replace(/^start /, "")}`); continue; }
    const r = sys.run(s.cmd[0], s.cmd.slice(1), s.env || {});
    if (r.status !== 0) allOk = false;
    out(`  ${r.status === 0 ? "done" : "FAILED"}: ${s.what}${r.status === 0 ? "" : ` (${String(r.stderr || r.stdout || "").trim().split("\n").pop().slice(0, 140)})`}`);
  }
  return allOk;
}

// ---- config: the one place to see and change a world's gateway settings (J380 v3) --------------------------------------------------
// Reads and writes the existing "gateway" block of worlds/<world>.json (via gateway-admin.mjs: validation, atomic write, the owner-terminal rule)
// and the host's levels file (gateway-levels.json: which modes and options a world may use at all).
import { currentValues, adminSet, KEYS } from "../research/gateway-admin.mjs";
import { loadLevels, writeLevels, checkValue, violations, describeLevels, levelsFile } from "../research/levels.mjs";
import { SEARCH_PROVIDERS } from "../research/gateway.mjs";
import { ownerTtyProblem } from "../agent-guard.mjs";

const RANGE = (k, lv) => k === "mode" ? lv.modes.join(" | ") : k === "level" ? `strict..${lv.max_share_level}` : k === "phone_decisions" ? (lv.phone_decisions ? "true | false" : "false only (the host doesn't allow it)") : k === "host_runner" ? (lv.runner_harnesses.join(" | ") || "none") : k === "search.provider" ? Object.keys(SEARCH_PROVIDERS).join(" | ") : /model$/.test(k) ? "a model id" : k === "search.key_file" ? "a path (owner only)" : "";
export function configRows(world, P = paths()) {
  const R = resolveWorld(world, P); if (R.error) return { error: R.error, rows: [] };
  const { sb, dm } = R, { levels, error } = loadLevels(P.cfg);
  let cur; try { cur = currentValues(P.cfg, sb.name, Object.keys(KEYS)); } catch (e) { return { error: e.message, rows: [] }; }
  const rows = Object.keys(KEYS).map((k) => ({ key: k, value: cur[k], range: RANGE(k, levels), where: "worlds/<world>.json gateway block", settable: true }));
  const ro = [["host_agents", dm?.host_agents === undefined ? "(not set: agent-free)" : String(dm.host_agents), "false | bridge", "sbx-relay.json, the Doorman's entry"], ["window", dm?.visibility || "(strict)", "strict | safe | observer | developer", "sbx-relay.json, the Doorman's entry"], ["bridge defaults", dm?.bridge ? JSON.stringify(dm.bridge).slice(0, 80) : "(none)", "tools, folders, time_limit_s", "sbx-relay.json, the Doorman's entry"], ["doorman model", dm?.model || "(default)", "a model id", "sbx-relay.json, the Doorman's entry"]];
  for (const [key, value, range, where] of ro) rows.push({ key, value, range, where, settable: false });
  // host_runner (J425) is read from the worlds file itself, so a value outside the levels shows even where the setting's own key isn't defined yet
  let hr = ""; try { const h = worldsFor(P.cfg, sb.name); if (h.length === 1) hr = h[0].w?.gateway?.host_runner ?? ""; } catch { /* none */ }
  if (hr && !rows.some((r) => r.key === "host_runner")) rows.push({ key: "host_runner", value: typeof hr === "object" ? JSON.stringify(hr).slice(0, 60) : String(hr), range: RANGE("host_runner", levels), where: "worlds/<world>.json gateway block", settable: false });
  const viol = violations(levels, { mode: cur.mode, level: cur.level, phone_decisions: cur.phone_decisions, host_runner: hr });
  return { world: sb.name, rows, levels, levelsError: error, violations: viol, levelsFile: levelsFile(P.cfg) };
}
export function renderConfig(c) {
  if (c.error) return c.error;
  const w = Math.max(...c.rows.map((r) => r.key.length)), v = Math.max(...c.rows.map((r) => String(r.value).length), 8);
  return [`Settings for ${c.world} (change with: doorman config set ${c.world} KEY VALUE, from your own terminal)`, "",
    ...c.rows.map((r) => `  ${r.key.padEnd(w)}  ${String(r.value).padEnd(Math.min(v, 44))}  ${r.range}${r.settable ? "" : `   [${r.where}]`}`), "",
    `The host's levels (${c.levelsFile}${c.levelsError ? ": BROKEN, strictest used" : ""}):`, ...describeLevels(c.levels).map((l) => "  " + l),
    ...(c.violations.length ? ["", "OUTSIDE the levels (clamped or refused):", ...c.violations.map((x) => "  " + x)] : [])].join("\n");
}
const kvOf = (args) => { const kv = []; for (let i = 0; i < args.length; i++) { if (args[i].includes("=")) kv.push(args[i]); else if (i + 1 < args.length) { kv.push(`${args[i]}=${args[i + 1]}`); i++; } else return null; } return kv; };
// `doorman config ...` -> { text, code }
export function configCommand(args, P = paths(), opts = {}) {
  const sub = ["get", "set", "edit", "levels"].includes(args[0]) ? args[0] : "", rest = sub ? args.slice(1) : args, guard = opts.guard || ownerTtyProblem;
  if (sub === "levels") {
    const [op = "show", ...kv] = rest;
    if (op === "show") { const { levels, error } = loadLevels(P.cfg); return { code: error ? 1 : 0, text: [`Host levels (${levelsFile(P.cfg)}):`, ...describeLevels(levels).map((l) => "  " + l), ...(error ? ["", error] : [])].join("\n") }; }
    if (op !== "set") return { code: 2, text: "usage: doorman config levels [show | set KEY VALUE ...]  (keys: modes, max_share_level, phone_decisions, runner_harnesses; lists with commas)" };
    const why = guard(); if (why) return { code: 3, text: `only the owner can change the host's levels, from a real terminal (${why})` };
    const pairs = kvOf(kv); if (!pairs) return { code: 2, text: "expected KEY VALUE pairs" };
    const patch = {}; for (const p of pairs) { const i = p.indexOf("="), k = p.slice(0, i), v = p.slice(i + 1); patch[k] = k === "modes" || k === "runner_harnesses" ? v.split(",").map((x) => x.trim()).filter(Boolean) : k === "phone_decisions" ? v === "on" || v === "true" : v; }
    try { const l = writeLevels(P.cfg, patch); return { code: 0, text: ["Host levels now:", ...describeLevels(l).map((x) => "  " + x), "", "Worlds already outside the new levels are clamped (the mode) and listed by doorman status and doctor."].join("\n") }; } catch (e) { return { code: 2, text: e.message }; }
  }
  // WORLD is explicit when given (an unknown name is an error, never a silent fallback to the only world):
  //   config [WORLD] | config get [WORLD] KEY | config set [WORLD] KEY VALUE... (or KEY=VALUE) | config edit [WORLD]
  const isKey = (x) => Object.hasOwn(KEYS, x) || x === "host_runner" || x.includes("=");
  const worldGiven = sub === "" ? rest.length >= 1 : sub === "get" ? rest.length >= 2 : sub === "set" ? rest.length >= 1 && !isKey(rest[0]) : rest.length >= 1;
  const world = worldGiven ? rest[0] : "", tail = worldGiven ? rest.slice(1) : rest, R = resolveWorld(world, P); if (R.error) return { code: 2, text: R.error };
  if (!sub) return { code: 0, text: renderConfig(configRows(R.sb.name, P)) };
  if (sub === "get") { const c = configRows(R.sb.name, P); if (c.error) return { code: 2, text: c.error }; const r = c.rows.find((x) => x.key === tail[0]); return r ? { code: 0, text: String(r.value) } : { code: 2, text: `unknown setting ${JSON.stringify(tail[0] || "").slice(0, 40)}; see doorman config ${R.sb.name}` }; }
  if (sub === "set") {
    const kv = kvOf(tail); if (!kv || !kv.length) return { code: 2, text: `usage: doorman config set [WORLD] KEY VALUE [KEY VALUE ...]` };
    const r = adminSet(P.cfg, R.sb.name, kv, { guard }); return { code: r.ok ? 0 : r.code || 1, text: r.text };
  }
  if (sub === "edit") {
    const why = guard(); if (why) return { code: 3, text: `only the owner can edit settings, from a real terminal (${why})` };
    const hits = worldsFor(P.cfg, R.sb.name); if (hits.length !== 1) return { code: 2, text: hits.length ? `${hits.length} worlds files name ${R.sb.name}: fix that first` : `no worlds file names ${R.sb.name}` };
    const f = fs.realpathSync(path.join(P.cfg, "worlds", hits[0].f)), before = fs.readFileSync(f, "utf8"), had = new Set(configRows(R.sb.name, P).violations || []);
    // the editor works on a private copy; nothing live changes until the edit is checked, and then it is written under the worlds lock
    const stage = path.join(os.tmpdir(), `doorman-edit-${process.pid}-${Date.now()}.json`); fs.writeFileSync(stage, before, { mode: 0o600 });
    try {
      const ed = (process.env.VISUAL || process.env.EDITOR || "nano").split(/\s+/); (opts.run || spawnSync)(ed[0], [...ed.slice(1), stage], { stdio: "inherit" });
      const after = fs.readFileSync(stage, "utf8"); if (after === before) return { code: 0, text: "no change" };
      return withWorldsLock(P.cfg, () => {
        if (fs.readFileSync(f, "utf8") !== before) return { code: 2, text: "not kept: the settings changed while you were editing (another change was applied). Run doorman config edit again." };
        try { JSON.parse(after); } catch (e) { return { code: 2, text: `not kept: ${e.message}. Nothing changed.` }; }
        // check the edit in a private copy of the config folder FIRST: nothing live holds the unchecked text
        const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "doorman-chk-")); let bad = "";
        try {
          fs.mkdirSync(path.join(tdir, "worlds"));
          for (const n of fs.readdirSync(P.cfg)) { const src = path.join(P.cfg, n); if (n === "worlds") { for (const w of fs.readdirSync(src)) if (w.endsWith(".json")) fs.copyFileSync(path.join(src, w), path.join(tdir, "worlds", w)); } else if (/\.json$/.test(n)) fs.copyFileSync(src, path.join(tdir, n)); }
          fs.writeFileSync(path.join(tdir, "worlds", hits[0].f), after);
          const c = configRows(R.sb.name, { ...P, cfg: tdir, relayConf: path.join(tdir, "sbx-relay.json") }); if (c.error) bad = c.error; else { const fresh = c.violations.filter((x) => !had.has(x)); if (fresh.length) bad = "outside the host's levels: " + fresh.join("; "); }
        } catch (e) { bad = e.message; } finally { fs.rmSync(tdir, { recursive: true, force: true }); }
        if (bad) return { code: 2, text: `not kept: ${bad}. Nothing changed.` };
        const tmp = `${f}.edit${process.pid}`; fs.writeFileSync(tmp, after, { mode: fs.statSync(f).mode & 0o777 }); fs.renameSync(tmp, f);
        return { code: 0, text: `saved ${f}` };
      });
    } finally { try { fs.unlinkSync(stage); } catch { /* gone */ } }
  }
}
import { worldsFor } from "../research/mode.mjs";
// the line for bringing your own host agent (Claude Code, Codex): the bridge's MCP server for this install
export function hostAgentConfig(P = paths()) {
  const cli = path.join(H, "docker/bridge/doorman-bridge"), state = path.join(P.relayState);
  return [`Claude Code:  claude mcp add doorman-bridge -e DOORMAN_BRIDGE_AGENT=claude-code -- ${cli} mcp`, "Codex (~/.codex/config.toml):", "[mcp_servers.doorman-bridge]", `command = "${cli}"`, 'args = ["mcp"]', `env = { DOORMAN_BRIDGE_AGENT = "codex" }`, "", `(The server finds the gateway's state at ${state}; set DOORMAN_STATE to point it elsewhere.) It lists the jobs you approved and lets the agent claim, ask you, and report; it can't approve anything.`].join("\n");
}
