#!/usr/bin/env node
// world-helper: the HOST side of a sandboxed hyprpi world's windows (J262, @pidocker).
//
// World G runs its own hyprpi daemon inside one Docker Sandboxes (sbx) sandbox. That daemon can't reach
// Hyprland, so inside the sandbox `hyprctl` and `kitty` are small stand-ins (docker/world/bin/) that send
// requests through a drop-box: requests in <workspace>/.hyprpi-g/hypr-out/ (sandbox-writable), answers in a
// HOST-ONLY folder mounted read-only into the sandbox. This helper answers them, for that world's windows
// ONLY:
//   query     clients / activeworkspace / activewindow / monitors / cursorpos / workspaces, filtered to the
//             world's own windows and workspaces (other worlds' windows are never listed)
//   dispatch  a small allowlist of window ops, each re-built from parsed values (never the request text):
//             focus, move to one of the world's workspaces, close, float / resize / move-at, unfullscreen,
//             always on a window this world owns
//   open      a new kitty window on one of the world's workspaces running `sbx exec -it <sandbox> g-run TOKEN`;
//             the command and environment stay inside the sandbox (in a launch file named by TOKEN), so the
//             host never runs anything the sandbox chose
// A window belongs to the world when its kitty process carries G_WORLD=<world> in its environment, which
// only this helper sets (the sandbox can't touch host processes). Everything is logged.
//
// Usage: world-helper.mjs start|stop|status|run [WORLD]     config: ~/.config/hyprpi/worlds/<WORLD>.json
//   { "sandbox": "world-g", "workspace": "~/Work/world-g", "inbox": "~/Work/sbx-inbox/world-g-hypr",
//     "workspaces": [61, 69] }

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const [cmd, worldArg] = process.argv.slice(2);
const WORLD = worldArg || "world-g";
if (!/^[a-z0-9-]{1,32}$/.test(WORLD)) { console.error("bad world name"); process.exit(2); }
const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi", "worlds", `${WORLD}.json`);
const STATE = path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "hyprpi", "worlds", WORLD);
const LOG = path.join(STATE, "helper.jsonl");
const UNIT = `hyprpi-${WORLD}-helper`;
const exp = (p) => path.resolve(String(p || "").replace(/^~(?=\/|$)/, HOME));
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;

const LIMITS = { fileBytes: 32 * 1024, perMinute: 600, opensPerMinute: 10, maxLiveWindows: 16, scanEntries: 300, resultTtlMs: 30000, maxResults: 400, scanCooldownMs: 100 };
const REQ_RE = /^[0-9]{13}-[0-9a-f]{8}\.json$/;
const ADDR_RE = /^0x[0-9a-f]{1,16}$/;
const TOKEN_RE = /^[0-9a-f]{24}$/;
const AGENT_RE = /^[A-Za-z0-9_.-]{3,64}$/;
const LIVE_MSG = (n) => String(n);
// G's window classes (J262 v2): hyprpi.g-agent / hyprpi.g-agents / hyprpi.g-mockup. Under "hyprpi." so the host
// treats them like hyprpi windows (Hyprland's hyprpi.* rules: terminal tag, opacity; summon/dismiss never
// move them as apps), but none equals a host class (hyprpi.agent …), so the host daemon never takes them
// for its own agents or panels.
const G_CLASS = /^hyprpi\.g-/;
const PANEL_KINDS = { router: "hyprpi.agents", room: "hyprpi.mockup", board: "hyprpi.mockup", search: "hyprpi.mockup" };

function log(e) {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  try { if (fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, LOG + ".1"); } catch { /* none */ }
  fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
}
function readConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const [lo, hi] = c.workspaces || [];
  if (!/^[A-Za-z0-9._-]+$/.test(c.sandbox || "") || !Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo || hi - lo > 20) throw new Error("bad config");
  const ws = exp(c.workspace), inbox = exp(c.inbox);
  if (inbox === ws || inbox.startsWith(ws + path.sep)) throw new Error("the inbox must not be inside the sandbox's workspace");
  return { sandbox: c.sandbox, workspace: ws, inbox, lo, hi };
}

// --- pinned folders (as in docker/sbx-relay.mjs): open once, then only through /proc/self/fd -------------------
const fdPath = (fd, name = "") => `/proc/self/fd/${fd}${name ? "/" + name : ""}`;
const openDirAt = (parent, name) => fs.openSync(parent == null ? name : fdPath(parent, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
function pin(cfg, st) {
  if (st.dirs) { try { if (fs.fstatSync(st.dirs.out).nlink > 0) return st.dirs; } catch { /* re-pin */ } for (const fd of Object.values(st.dirs)) { try { fs.closeSync(fd); } catch { /* */ } } st.dirs = null; }
  const opened = [];
  const sub = (p, n) => { let fd; try { fd = openDirAt(p, n); } catch (e) { if (e.code !== "ENOENT") throw new Error(`${n}: not a plain directory`); fs.mkdirSync(fdPath(p, n), { mode: 0o755 }); fd = openDirAt(p, n); } opened.push(fd); return fd; };
  try {
    const ws = openDirAt(null, cfg.workspace); opened.push(ws);
    const base = sub(ws, ".hyprpi-g"), out = sub(base, "hypr-out");
    const inbox = openDirAt(null, cfg.inbox); opened.push(inbox);
    st.dirs = { ws, base, out, inbox };
    return st.dirs;
  } catch (e) { for (const fd of opened) { try { fs.closeSync(fd); } catch { /* */ } } throw e; }
}
function listNames(fd, max) { const d = fs.opendirSync(fdPath(fd)), out = []; try { let e; while (out.length < max && (e = d.readSync())) out.push(e.name); } finally { d.closeSync(); } return out; }
function readReq(dirFd, name) {
  const fd = fs.openSync(fdPath(dirFd, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  let raw;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > LIMITS.fileBytes) throw new Error("bad request file");
    const b = Buffer.alloc(st.size); fs.readSync(fd, b, 0, st.size, 0); raw = b.toString("utf8");
  } finally { fs.closeSync(fd); }
  let j; try { j = JSON.parse(raw); } catch { throw new Error("invalid JSON"); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("request must be an object");
  return j;
}
function writeResult(st, stem, obj) {
  const name = `res-${stem}.json`;
  const fd = fs.openSync(fdPath(st.dirs.inbox, name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  try { fs.writeSync(fd, JSON.stringify(obj)); } finally { fs.closeSync(fd); }
}
function pruneResults(st) {
  for (const n of listNames(st.dirs.inbox, 5000).filter((x) => /^closed-/.test(x))) {
    try { if (Date.now() - fs.statSync(fdPath(st.dirs.inbox, n)).mtimeMs > 86400000) fs.unlinkSync(fdPath(st.dirs.inbox, n)); } catch { /* */ }
  }
  const names = listNames(st.dirs.inbox, 5000).filter((n) => /^res-/.test(n));
  const now = Date.now();
  const old = names.filter((n) => now - Number(n.slice(4, 17)) > LIMITS.resultTtlMs);
  const extra = names.length - old.length - LIMITS.maxResults;
  const sorted = names.filter((n) => !old.includes(n)).sort();
  for (const n of [...old, ...(extra > 0 ? sorted.slice(0, extra) : [])]) { try { fs.unlinkSync(fdPath(st.dirs.inbox, n)); } catch { /* */ } }
}

// --- Hyprland on the host ------------------------------------------------------------------------------------
const hyprctl = (args) => new Promise((res, rej) => execFile("hyprctl", args, { timeout: 5000, maxBuffer: 8 << 20 }, (e, out) => (e ? rej(e) : res(out))));
const hj = async (what) => JSON.parse(await hyprctl(["-j", what]));
const q = (s) => JSON.stringify(String(s));
function envOf(pid) { try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return []; } }

class Helper {
  constructor(cfg) {
    this.cfg = cfg; this.st = {}; this.stamps = []; this.opens = []; this.owned = new Map(); this.busy = false;
    // token -> { agent, kind, at }: kept on disk (host-only state) so a helper restart still knows which
    // agent each open window belongs to.
    this.tokFile = path.join(STATE, "tokens.json");
    this.tokens = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.tokFile, "utf8")))) if (TOKEN_RE.test(k)) this.tokens.set(k, v); } catch { /* none */ }
  }
  saveTokens() { try { fs.writeFileSync(this.tokFile, JSON.stringify(Object.fromEntries(this.tokens)), { mode: 0o600 }); } catch { /* */ } }
  inWorld(ws) { return Number.isInteger(ws) && ws >= this.cfg.lo && ws <= this.cfg.hi; }
  // The world's windows: kitty processes this helper started carry G_WORLD=<world> and G_TOKEN.
  async windows() {
    const all = await hj("clients");
    const mine = [];
    for (const c of all) {
      if (!c?.pid || !G_CLASS.test(c.class || "")) continue;
      let o = this.owned.get(c.address);
      if (!o || o.pid !== c.pid) {
        const env = envOf(c.pid);
        if (!env.includes(`G_WORLD=${WORLD}`)) continue;
        const tok = (env.find((x) => x.startsWith("G_TOKEN=")) || "").slice(8);
        const t = this.tokens.get(tok) || {};
        if (this.tokens.has(tok)) t.mapped = true;
        o = { pid: c.pid, agent: t.agent || "", kind: t.kind || "agent", token: TOKEN_RE.test(tok) ? tok : "" };
        this.owned.set(c.address, o);
      }
      // Review #5: a G window Angus moved out of G's workspaces is no longer the world's to see or touch.
      if (!this.inWorld(c.workspace?.id)) continue;
      mine.push({ c, o });
    }
    for (const [a, o] of [...this.owned]) if (!all.some((c) => c.address === a)) { this.owned.delete(a); this.closed(o.token); if (o.token) { this.tokens.delete(o.token); this.saveTokens(); } }
    return mine;
  }
  view({ c, o }) {
    const title = String(c.title || "").replace(/^G: /, "");
    return {
      address: c.address, mapped: c.mapped, hidden: c.hidden, at: c.at, size: c.size, floating: c.floating,
      workspace: { id: c.workspace?.id, name: String(c.workspace?.name ?? "") }, monitor: c.monitor,
      class: String(c.class).replace(G_CLASS, "hyprpi."), initialClass: String(c.class).replace(G_CLASS, "hyprpi."),
      title, initialTitle: title, pid: 0, xwayland: false, pinned: false, fullscreen: c.fullscreen, fullscreenClient: c.fullscreenClient,
      grouped: [], tags: [], swallowing: "0x0", focusHistoryID: c.focusHistoryID, hyprpiAgent: o.agent,
    };
  }
  async query(what) {
    if (what === "clients") return (await this.windows()).map((w) => this.view(w));
    if (what === "activeworkspace") {
      const a = await hj("activeworkspace");
      const n = this.inWorld(a.id) ? (await this.windows()).filter((w) => w.c.workspace.id === a.id).length : 0;
      return this.inWorld(a.id) ? { id: a.id, name: String(a.id), monitor: a.monitor, windows: n, hasfullscreen: false } : { id: this.cfg.lo, name: String(this.cfg.lo), monitor: a.monitor, windows: 0, hasfullscreen: false };
    }
    if (what === "activewindow") {
      const a = await hj("activewindow").catch(() => ({}));
      const w = a?.address && (await this.windows()).find((x) => x.c.address === a.address);
      return w ? this.view(w) : {};
    }
    if (what === "monitors") {
      const a = await hj("activeworkspace");
      return (await hj("monitors")).map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, width: m.width, height: m.height, scale: m.scale, transform: m.transform, focused: m.focused, reserved: m.reserved,
        activeWorkspace: this.inWorld(m.activeWorkspace?.id) ? m.activeWorkspace : { id: this.cfg.lo, name: String(this.cfg.lo) }, specialWorkspace: { id: 0, name: "" } }))
        .map((m) => (m.focused && !this.inWorld(a.id) ? { ...m } : m));
    }
    if (what === "cursorpos") { const a = await hj("activeworkspace"); return this.inWorld(a.id) ? hj("cursorpos") : { x: 0, y: 0 }; }
    if (what === "workspaces") {
      // Review #4: rebuilt from the world's own windows only (host workspace objects carry lastwindow /
      // lastwindowtitle of whatever host app is there).
      const mine = await this.windows(), a = await hj("activeworkspace").catch(() => ({}));
      const ids = [...new Set(mine.map((w) => w.c.workspace.id))];
      return ids.map((id) => {
        const on = mine.filter((w) => w.c.workspace.id === id);
        return { id, name: String(id), monitor: a.monitor || "", windows: on.length, hasfullscreen: on.some((w) => w.c.fullscreen), lastwindow: on[0]?.c.address || "0x0", lastwindowtitle: this.view(on[0]).title || "" };
      });
    }
    throw new Error("unknown query");
  }
  async dispatch(lua) {
    lua = String(lua || "").trim();
    const W = '\\{ window = "address:(0x[0-9a-f]{1,16})" \\}';
    const own = async (addr) => { if (!ADDR_RE.test(addr) || !(await this.windows()).some((w) => w.c.address === addr)) throw new Error("not a window of this world"); return addr; };
    let m;
    if ((m = new RegExp(`^hl\\.dsp\\.focus\\(${W}\\)$`).exec(lua))) return this.run(`hl.dsp.focus({ window = ${q("address:" + await own(m[1]))} })`);
    if ((m = new RegExp(`^hl\\.dsp\\.window\\.close\\(${W}\\)$`).exec(lua))) return this.run(`hl.dsp.window.close({ window = ${q("address:" + await own(m[1]))} })`);
    if ((m = new RegExp(`^hl\\.dsp\\.window\\.float\\(${W}\\)$`).exec(lua))) return this.run(`hl.dsp.window.float({ window = ${q("address:" + await own(m[1]))} })`);
    if ((m = /^hl\.dsp\.window\.move\(\{ window = "address:(0x[0-9a-f]{1,16})", workspace = "(\d{1,4})", follow = false \}\)$/.exec(lua))) {
      const ws = Number(m[2]); if (!this.inWorld(ws)) throw new Error(`workspace ${ws} is not this world's`);
      return this.run(`hl.dsp.window.move({ window = ${q("address:" + await own(m[1]))}, workspace = ${q(String(ws))}, follow = false })`);
    }
    if ((m = /^hl\.dsp\.window\.(resize|move)\(\{ x = (-?\d{1,5}), y = (-?\d{1,5}), relative = false, window = "address:(0x[0-9a-f]{1,16})" \}\)$/.exec(lua)))
      return this.run(`hl.dsp.window.${m[1]}({ x = ${Number(m[2])}, y = ${Number(m[3])}, relative = false, window = ${q("address:" + await own(m[4]))} })`);
    if ((m = /^hl\.dsp\.window\.fullscreen_state\(\{ internal = 0, client = 0, window = "address:(0x[0-9a-f]{1,16})" \}\)$/.exec(lua)))
      return this.run(`hl.dsp.window.fullscreen_state({ internal = 0, client = 0, window = ${q("address:" + await own(m[1]))} })`);
    throw new Error("window operation not allowed in a sandboxed world");
  }
  // A window of this world closed on the host: tell its program inside the sandbox (bin/g-run watches for
  // closed-<token> in the read-only inbox), since `sbx exec` leaves it running otherwise.
  closed(token) {
    if (!token || !this.st.dirs) return;
    try { const fd = fs.openSync(fdPath(this.st.dirs.inbox, `closed-${token}`), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644); fs.closeSync(fd); log({ op: "closed", token: token.slice(0, 6) }); } catch { /* exists */ }
  }
  async run(lua) { await hyprctl(["dispatch", lua]); return { ok: true }; }
  async open(r) {
    const t = Date.now(); this.opens = this.opens.filter((x) => t - x < 60000);
    if (this.opens.length >= LIMITS.opensPerMinute) throw new Error("too many windows opened this minute");
    if (!TOKEN_RE.test(String(r.token))) throw new Error("bad token");
    if (this.tokens.has(r.token)) throw new Error("token already used");
    // Review #2: a cap on the world's LIVE windows (plus launches still opening), not just on the rate.
    const live = (await this.windows()).length + [...this.tokens.values()].filter((x) => !x.mapped && t - x.at < 60000).length;
    if (live >= LIMITS.maxLiveWindows) throw new Error(`this world already has ${LIVE_MSG(live)} windows (max ${LIMITS.maxLiveWindows})`);
    const kind = r.kind === "agent" ? "agent" : PANEL_KINDS[r.kind] ? r.kind : "";
    if (!kind) throw new Error("bad kind");
    const agent = r.agent == null || r.agent === "" ? "" : String(r.agent);
    if (agent && !AGENT_RE.test(agent)) throw new Error("bad agent id");
    const ws = this.inWorld(Number(r.ws)) ? Number(r.ws) : this.cfg.lo;
    this.opens.push(t);
    this.tokens.set(r.token, { agent, kind, at: t });
    // forget tokens of windows that never opened within a minute, and of closed windows (below)
    const liveTok = new Set([...this.owned.values()].map((o) => o.token));
    for (const [k, v] of this.tokens) if (!liveTok.has(k) && !v.mapped && t - v.at > 60000) this.tokens.delete(k);
    this.saveTokens();
    // The host command: fixed except the token (checked charset), the class (from a fixed table) and the
    // panel title (from a fixed table). The workspace number is an integer we checked.
    const cls = kind === "agent" ? "hyprpi.g-agent" : PANEL_KINDS[kind].replace(/^hyprpi\./, "hyprpi.g-");
    const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const kconf = ["--config", this.kittyConf(H)];
    const title = kind === "agent" ? [] : ["--title", `G: hyprpi-${kind} G`];
    // Review #1: the window gets a locked-down kitty config (no clipboard, links, remote control or host-shell
    // keys) instead of Angus's own, and the program's output passes through g-filter (drops kitty graphics,
    // OSC 52 / 8 / file transfer / notifications, DCS…), so the sandbox can't reach the host through kitty.
    const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const argv = ["env", `G_WORLD=${WORLD}`, `G_TOKEN=${r.token}`, "kitty", `--class=${cls}`, ...kconf, ...title, `--directory=${this.cfg.workspace}`, "--",
      "python3", path.join(H, "docker", "world", "g-filter.py"),
      "systemd-run", "--user", "--scope", "--quiet", `--slice=hyprpi-${WORLD}.slice`, "-p", "MemoryMax=512M", "-p", "TasksMax=64",
      "sbx", "exec", "-it", "-w", this.cfg.workspace, this.cfg.sandbox, path.join(H, "docker", "world", "bin", "g-run"), r.token];
    const script = path.join(STATE, `open-${r.token}.sh`);
    fs.writeFileSync(script, `#!/bin/sh\nrm -f -- ${sh(script)}\nexec ${argv.map(sh).join(" ")}\n`, { mode: 0o700 });
    if (!/^[A-Za-z0-9/._-]+$/.test(script)) throw new Error("unexpected characters in the launch script path");
    await this.run(`hl.dsp.exec_cmd(${q(script)}, { workspace = ${q(`${ws} silent`)} })`);
    return { ok: true, ws, kind };
  }
  // The window's kitty config (J262 v2): Angus's look (font, padding, decorations, cursor, the current Omarchy
  // theme's colours) copied as plain values from his kitty.conf and the theme's kitty.conf, KEEPING ONLY
  // visual settings from a fixed list (never includes, maps, links, remote control or listen_on), then the
  // lockdown in sandbox-kitty.conf, which comes last and wins. Rebuilt on each open (theme changes).
  kittyConf(H) {
    const VISUAL = /^(font_family|bold_font|italic_font|bold_italic_font|font_size|font_features|modify_font|disable_ligatures|window_padding_width|window_margin_width|single_window_padding_width|single_window_margin_width|hide_window_decorations|background_opacity|dynamic_background_opacity|cursor|cursor_text_color|cursor_shape|cursor_shape_unfocused|cursor_blink_interval|cursor_stop_blinking_after|cursor_beam_thickness|cursor_underline_thickness|cursor_trail|foreground|background|selection_foreground|selection_background|color[0-9]{1,3}|active_border_color|inactive_border_color|bell_border_color|url_color|mark[123]_(fore|back)ground|active_tab_(fore|back)ground|inactive_tab_(fore|back)ground|tab_bar_background|tab_bar_margin_color|tab_bar_edge|tab_bar_style|tab_powerline_style|text_composition_strategy|text_fg_override_threshold|scrollback_lines|enable_audio_bell|visual_bell_duration|window_alert_on_bell|wheel_scroll_multiplier|touch_scroll_multiplier)$/;
    const VALUE = /^[A-Za-z0-9 #.,:_+\-%]{0,120}$/;
    const kconfDir = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "kitty");
    const files = [path.join(HOME, ".local", "state", "omarchy", "current", "theme", "kitty.conf"), path.join(kconfDir, "kitty.conf")];
    const lines = [];
    for (const f of files) {
      let t = ""; try { t = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const raw of t.split("\n")) {
        const m = /^\s*([a-z0-9_]+)\s+(.*?)\s*$/.exec(raw);
        if (m && VISUAL.test(m[1]) && VALUE.test(m[2])) lines.push(`${m[1]} ${m[2]}`);
      }
    }
    const out = path.join(STATE, "kitty-look.conf");
    const lock = fs.readFileSync(path.join(H, "docker", "world", "sandbox-kitty.conf"), "utf8").replaceAll("@G_PASTE@", path.join(H, "docker", "world", "g_paste.py")); // kitty resolves a relative kitten path against ITS config dir, so give it the absolute one
    fs.writeFileSync(out, `# generated by world-helper.mjs: visual settings only, then the sandbox lockdown\n${lines.join("\n")}\n\n${lock}`, { mode: 0o600 });
    return out;
  }
  async handle(r) {
    switch (r.op) {
      case "query": return { ok: true, data: await this.query(String(r.what || "")) };
      case "dispatch": return await this.dispatch(r.lua);
      case "open": return await this.open(r);
      default: throw new Error("unknown op");
    }
  }
  rateOk() { const t = Date.now(); this.stamps = this.stamps.filter((x) => t - x < 60000); if (this.stamps.length >= LIMITS.perMinute) return false; this.stamps.push(t); return true; }
  async scan() {
    if (this.busy) { this.again = true; return; }
    const since = Date.now() - (this.lastScan || 0);
    if (since < LIMITS.scanCooldownMs) { if (!this.cooling) { this.cooling = true; setTimeout(() => { this.cooling = false; this.scan().catch(() => {}); }, LIMITS.scanCooldownMs - since); } return; }
    this.busy = true; this.lastScan = Date.now();
    try {
      let d; try { d = pin(this.cfg, this.st); } catch (e) { log({ error: `drop-box: ${e.message}` }); return; }
      const names = listNames(d.out, LIMITS.scanEntries).filter((n) => REQ_RE.test(n)).sort();
      let dropped = 0;
      for (const n of names) {
        const stem = n.slice(0, -5);
        // Review #3: over the rate the request is deleted unread, with ONE log line and no result per file.
        if (!this.rateOk()) { try { fs.unlinkSync(fdPath(d.out, n)); } catch { /* */ } dropped++; continue; }
        let r = null, res;
        try {
          r = readReq(d.out, n);
          try { fs.unlinkSync(fdPath(d.out, n)); } catch { /* */ }
          res = await this.handle(r);
        } catch (e) { try { fs.unlinkSync(fdPath(d.out, n)); } catch { /* */ } res = { ok: false, error: String(e.message || e).slice(0, 200) }; }
        const op = typeof r?.op === "string" ? r.op.slice(0, 12) : "?";
        if (op !== "query" || !res.ok) log({ op, what: op === "dispatch" ? String(r?.lua || "").slice(0, 120) : op === "open" ? r?.kind : r?.what, ok: !!res.ok, error: res.error });
        try { writeResult(this.st, stem, res); } catch (e) { log({ error: `result: ${e.message}` }); }
      }
      if (dropped) log({ dropped, reason: "rate limit" });
      pruneResults(this.st);
    } catch (e) { log({ error: `scan: ${e.message}` }); }
    finally { this.busy = false; if (this.again) { this.again = false; setTimeout(() => this.scan().catch(() => {}), LIMITS.scanCooldownMs); } }
  }
  async run_() {
    const d = pin(this.cfg, this.st);
    log({ note: `helper starting (pid ${process.pid}) for ${WORLD}: sandbox ${this.cfg.sandbox}, workspaces ${this.cfg.lo}-${this.cfg.hi}` });
    fs.watch(fdPath(d.out), () => this.scan().catch(() => {}));
    setInterval(() => this.scan().catch(() => {}), 500);
    setInterval(() => this.windows().catch(() => {}), 3000); // notices closed windows (closed-<token>)
    process.on("unhandledRejection", (e) => log({ error: `unhandled: ${e?.message || e}` }));
    for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { log({ note: "helper stopping" }); process.exit(0); });
  }
}

if (cmd === "run") await new Helper(readConfig()).run_();
else if (cmd === "windows") { // the world's own windows (G_WORLD in the kitty process), for world.sh stop (review #7)
  const all = JSON.parse(execFileSync("hyprctl", ["-j", "clients"]).toString());
  for (const c of all) if (c.pid && G_CLASS.test(c.class || "") && envOf(c.pid).includes(`G_WORLD=${WORLD}`)) console.log(c.address);
}
else if (cmd === "start") { readConfig(); execFileSync("systemd-run", ["--user", `--unit=${UNIT}`, "--collect", "--property=Restart=on-failure", "--property=MemoryMax=256M", "--property=CPUQuota=50%", "--property=TasksMax=64", process.execPath, fileURLToPath(import.meta.url), "run", WORLD], { stdio: "inherit" }); }
else if (cmd === "stop") execFileSync("systemctl", ["--user", "stop", UNIT], { stdio: "inherit" });
else if (cmd === "status") { try { execFileSync("systemctl", ["--user", "--no-pager", "status", UNIT], { stdio: "inherit" }); } catch { /* */ } console.log(`log: ${LOG}`); }
else { console.log("usage: world-helper.mjs start|stop|status|run [WORLD]"); process.exit(cmd ? 1 : 0); }
