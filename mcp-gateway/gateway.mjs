#!/usr/bin/env node
// mcp-gateway (J88, @system N12; Angus: "MCP servers only start when needed"). Part of hyprpi since J129;
// standalone: works for any pi setup (no hyprpi dependency). See mcp-gateway/README.md.
//
// pi 1.0's built-in MCP starts EVERY enabled server at session start, once per pi process: with
// ~27 agents that was 27 copies of each stdio server (~9 GB idle). This gateway runs each stdio
// server at most ONCE, shared by every agent, and only while it is being used:
//
//   - pi connects to http://127.0.0.1:<port>/<name> (streamable HTTP, plain JSON responses).
//   - initialize / tools/list / resources/list / prompts/list / resources/templates/list are
//     answered from a cache (~/.cache/mcp-gateway/<name>.json), so connecting costs nothing.
//   - the real server (the stdio command) starts on the first call that needs it (tools/call,
//     resources/read, …) and stops after IDLE_MIN minutes without calls. Its lists refresh the
//     cache each time it starts. Without a cache yet, it starts once to fill it.
//
// Config: ~/.config/mcp-gateway/servers.json  { "port": 8790, "idleMin": 10,
//   "servers": { "<name>": { "command": "...", "args": [...], "env": {...}, "cwd": "..." } } }
// Logs to stderr (journalctl --user -u mcp-gateway).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const CFG_FILE = process.env.MCP_GATEWAY_CONFIG || path.join(os.homedir(), ".config/mcp-gateway/servers.json");
const CACHE = path.join(os.homedir(), ".cache/mcp-gateway");
fs.mkdirSync(CACHE, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
const PORT = Number(cfg.port) || 8790, IDLE_MS = (Number(cfg.idleMin) || 10) * 60000;
const log = (...a) => console.error(new Date().toISOString(), ...a);
const LISTS = ["tools/list", "resources/list", "prompts/list", "resources/templates/list"];

class Upstream {
  constructor(name, spec, label = name) {
    this.name = label; this.spec = spec; this.child = null; this.ready = null; this.pending = new Map();
    this.nextId = 1; this.idle = null; this.buf = "";
    this.cacheFile = path.join(CACHE, `${name.replace(/[^\w.-]/g, "_")}.json`); // one cache per server, shared by its sessions
    try { this.cache = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")); } catch { this.cache = null; }
  }
  touch() { this.last = Date.now(); if (this.idle) clearTimeout(this.idle); this.idle = setTimeout(() => this.stop("idle"), IDLE_MS); this.idle.unref?.(); }
  stop(why) {
    if (!this.child) return;
    log(`${this.name}: stopping (${why})`);
    try { this.child.kill("SIGTERM"); } catch { /* gone */ }
    const c = this.child; setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref?.();
    this.child = null; this.ready = null;
    for (const [, p] of this.pending) p.reject(new Error(`${this.name} stopped`));
    this.pending.clear();
  }
  send(msg) { this.child.stdin.write(JSON.stringify(msg) + "\n"); }
  request(method, params, timeoutMs = 600000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}: ${method} timed out`)); }, timeoutMs);
      t.unref?.();
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }
  start(clientInit) {
    if (this.ready) return this.ready;
    const s = this.spec;
    log(`${this.name}: starting ${s.command} ${(s.args || []).join(" ")}`);
    const child = spawn(s.command, s.args || [], { cwd: s.cwd || os.homedir(), env: { ...process.env, ...(s.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; this.buf = "";
    child.stderr.on("data", (d) => { const t = String(d).trim(); if (t) log(`${this.name} stderr: ${t.slice(0, 400)}`); });
    child.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
          const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.resolve(m); }
        } else if (m.id !== undefined && m.method) {
          // server → client request (sampling, roots, ping): not supported through the gateway
          this.send({ jsonrpc: "2.0", id: m.id, ...(m.method === "ping" ? { result: {} } : { error: { code: -32601, message: "not supported by mcp-gateway" } }) });
        }
      }
    });
    child.on("exit", (code, sig) => { if (this.child === child) { log(`${this.name}: exited (${sig || code})`); this.child = null; this.ready = null; for (const [, p] of this.pending) p.reject(new Error(`${this.name} exited`)); this.pending.clear(); } });
    // J190: a server that can't start (command not found, …) fails its callers at once with a JSON-RPC
    // error naming the command, instead of a hung or empty reply.
    child.on("error", (e) => {
      log(`${this.name}: spawn failed: ${e.message}`);
      if (this.child !== child) return;
      this.child = null;
      const err = new Error(`mcp-gateway: couldn't start ${this.name} (${s.command}): ${e.code === "ENOENT" ? "command not found" : e.message}; check ~/.config/mcp-gateway/servers.json`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
    child.stdin.on("error", () => {}); // a dead child's pipe: handled by "error" / "exit" above
    this.ready = (async () => {
      const init = await this.request("initialize", clientInit || { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-gateway", version: "1" } }, 120000);
      if (init.error) throw new Error(`${this.name}: initialize failed: ${init.error.message}`);
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const cache = { initialize: init.result, lists: {} };
      const caps = init.result?.capabilities || {};
      for (const m of LISTS) {
        const need = m.startsWith("tools") ? caps.tools : m.startsWith("prompts") ? caps.prompts : caps.resources;
        if (!need) continue;
        const r = await this.request(m, {}, 60000).catch(() => null);
        if (r && r.result) cache.lists[m] = r.result;
      }
      this.cache = cache;
      fs.writeFileSync(this.cacheFile + ".tmp", JSON.stringify(cache)); fs.renameSync(this.cacheFile + ".tmp", this.cacheFile);
      log(`${this.name}: ready (${(cache.lists["tools/list"]?.tools || []).length} tools)`);
      this.touch();
    })();
    this.ready.catch((e) => { log(String(e.message || e)); this.stop("failed"); });
    return this.ready;
  }
  async handle(msg) {
    const reply = (body) => ({ jsonrpc: "2.0", id: msg.id, ...body });
    if (msg.method === "initialize") {
      if (!this.cache) await this.start(msg.params);
      return reply({ result: { ...this.cache.initialize, protocolVersion: msg.params?.protocolVersion || this.cache.initialize.protocolVersion } });
    }
    if (msg.method === "ping") return reply({ result: {} });
    if (LISTS.includes(msg.method) && !msg.params?.cursor) {
      if (!this.cache) await this.start();
      const l = this.cache.lists[msg.method];
      if (l) return reply({ result: l });
      if (!this.child) return reply({ result: msg.method === "tools/list" ? { tools: [] } : msg.method === "prompts/list" ? { prompts: [] } : msg.method === "resources/list" ? { resources: [] } : { resourceTemplates: [] } });
    }
    await this.start();
    this.touch();
    const r = await this.request(msg.method, msg.params);
    this.touch();
    return reply(r.error !== undefined ? { error: r.error } : { result: r.result });
  }
  notify(msg) { if (this.child && msg.method !== "notifications/initialized") this.send(msg); }
}

// "perSession": true → one child per MCP session (per agent), still lazy and idle-stopped: for servers
// that keep state per client (hyprcu: the last marks / capture, app-notes seen-state; Dormouse).
const ups = {}, sessions = new Map(); // "name|sid" -> Upstream
function upstreamFor(name, sid) {
  const spec = cfg.servers?.[name];
  if (!spec) return null;
  if (!spec.perSession) return (ups[name] ||= new Upstream(name, spec));
  const key = `${name}|${sid || "-"}`;
  let u = sessions.get(key);
  if (!u) { u = new Upstream(name, spec, `${name}[${String(sid || "-").slice(0, 8)}]`); sessions.set(key, u); }
  return u;
}

const server = http.createServer((req, res) => {
  const name = decodeURIComponent((req.url || "/").split("?")[0].replace(/^\/+|\/+$/g, ""));
  if (!cfg.servers?.[name]) { res.writeHead(404).end("unknown server"); return; }
  if (req.method === "DELETE") { const u = sessions.get(`${name}|${req.headers["mcp-session-id"] || "-"}`); if (u) { u.stop("session closed"); sessions.delete(`${name}|${req.headers["mcp-session-id"]}`); } res.writeHead(200).end(); return; }
  if (req.method === "GET") { res.writeHead(405, { Allow: "POST" }).end(); return; } // no server-initiated stream
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 50e6) req.destroy(); });
  req.on("end", async () => {
    let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400).end("bad json"); return; }
    const sid = req.headers["mcp-session-id"] || (msg.method === "initialize" ? randomUUID() : "");
    const up = upstreamFor(name, sid);
    const headers = { "Content-Type": "application/json", ...(sid ? { "Mcp-Session-Id": sid } : {}) };
    try {
      if (Array.isArray(msg)) {
        const out = [];
        for (const m of msg) { if (m.id === undefined) up.notify(m); else out.push(await up.handle(m)); }
        if (!out.length) { res.writeHead(202, headers).end(); return; }
        res.writeHead(200, headers).end(JSON.stringify(out)); return;
      }
      if (msg.id === undefined) { up.notify(msg); res.writeHead(202, headers).end(); return; }
      const out = await up.handle(msg);
      res.writeHead(200, headers).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: String(e.message || e) } }));
    }
  });
});
server.listen(PORT, "127.0.0.1", () => log(`mcp-gateway on http://127.0.0.1:${PORT}/ : ${Object.keys(cfg.servers || {}).join(", ")} (idle ${IDLE_MS / 60000} min)`));
// sessions whose child is gone and idle for a day are forgotten
setInterval(() => { for (const [k, u] of sessions) if (!u.child && Date.now() - (u.last || 0) > 86400e3) sessions.delete(k); }, 3600e3).unref?.();
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { for (const u of [...Object.values(ups), ...sessions.values()]) u.stop("gateway exit"); setTimeout(() => process.exit(0), 300); });
