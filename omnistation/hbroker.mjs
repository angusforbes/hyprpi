#!/usr/bin/env node
// hbroker.mjs: keeps one remote agent's pi running in RPC mode and lets local windows talk to it (J471, a remote world).
// Runs ON the remote machine, next to remote.sh. No dependencies (node 22+).
//
//   hbroker.mjs serve NAME -- PI_ARGS...   run `pi --mode rpc PI_ARGS` (hyprpi's `new` starts this instead of pi when
//                                           HYPRPI_REMOTE_RPC=1) and serve it on ~/.hyprpi-<letter>/run/NAME.rpc.sock
//   hbroker.mjs connect NAME                pipe stdin/stdout to that socket: what a laptop window runs over ssh
//
// Why: a world H window used to mirror pi's terminal over ssh (every key went round the link). Now the window is drawn on the
// laptop (omnistation/h-client.mjs) and only finished messages and pi's events cross the link. pi and its session live here; a
// dropped ssh or an expired login only closes one client, never pi.
//
// Protocol: pi's own RPC JSONL. Several clients may be connected: events go to all of them; a command's id is rewritten
// per client so its response goes back only to the client that asked; an extension dialog (select / confirm / input /
// editor) goes to all clients and the first answer wins (with no client connected it is cancelled, so pi never hangs).
// Extra lines from the broker itself: {"type":"broker_hello", ...} when a client connects.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const [, , cmd, NAME, ...rest] = process.argv;
if (!/^[a-z][a-z0-9-]{0,30}$/.test(NAME || "")) { console.error("hbroker: usage: hbroker.mjs serve|connect NAME"); process.exit(2); }
// the world's run folder: next to its daemon socket (remote.sh exports HYPRPI_SOCKET=~/.hyprpi-<letter>/run/daemon.sock)
const RUN = process.env.HYPRPI_SOCKET ? path.dirname(process.env.HYPRPI_SOCKET) : path.join(path.dirname(new URL(import.meta.url).pathname), "run");
const SOCK = path.join(RUN, `${NAME}.rpc.sock`);

// LF-only JSONL splitter (pi's RPC framing: never split on U+2028/2029, which readline does)
function lines(onLine) {
  let buf = ""; const dec = new StringDecoder("utf8"); // (review) a multibyte character split across chunks stays whole
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : dec.write(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); if (l) onLine(l); }
  };
}

if (cmd === "connect") {
  const s = net.connect(SOCK);
  s.on("error", (e) => { process.stdout.write(JSON.stringify({ type: "broker_error", error: `agent ${NAME} isn't running here (${e.code || e.message})` }) + "\n"); process.exit(4); });
  process.stdin.pipe(s); s.pipe(process.stdout);
  // A killed laptop ssh doesn't always close this side's stdin (seen with Teleport): the client pings every 15 s, so 60 s of
  // silence means it is gone and this connection ends instead of lingering
  let last = Date.now(); process.stdin.on("data", () => { last = Date.now(); });
  setInterval(() => { if (Date.now() - last > 60000) { s.destroy(); process.exit(0); } }, 5000).unref();
  s.on("close", () => process.exit(0));
  process.stdin.on("end", () => s.end());
} else if (cmd === "serve") {
  const dd = rest.indexOf("--");
  const piArgs = dd >= 0 ? rest.slice(dd + 1) : rest;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(SOCK); } catch {}
  const log = (m) => process.stderr.write(`[hbroker ${new Date().toISOString().slice(11, 19)}] ${m}\n`);
  const pi = spawn(process.env.HYPRPI_REMOTE_PI || "pi", ["--mode", "rpc", ...piArgs], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  const clients = new Map(); // n -> socket
  let nextN = 1;
  const pendingUi = new Map(); // ui request id -> request (until answered)
  const send = (sock, obj) => { try { sock.write(JSON.stringify(obj) + "\n"); } catch {} };
  const toPi = (obj) => pi.stdin.write(JSON.stringify(obj) + "\n");
  const DIALOG = new Set(["select", "confirm", "input", "editor"]);
  const sticky = new Map();

  pi.stdout.on("data", lines((l) => {
    let r; try { r = JSON.parse(l); } catch { return; }
    // a command's response, and command-scoped events (bash_execution_update), go only to the client that asked (review)
    if ((r.type === "response" || r.type === "bash_execution_update") && typeof r.id === "string" && /^c\d+:/.test(r.id)) {
      const n = Number(r.id.slice(1, r.id.indexOf(":"))); const sock = clients.get(n);
      if (sock) send(sock, { ...r, id: r.id.slice(r.id.indexOf(":") + 1) });
      return;
    }
    if (r.type === "extension_ui_request") {
      if (DIALOG.has(r.method)) {
        if (!clients.size) { toPi({ type: "extension_ui_response", id: r.id, cancelled: true }); return; }
        pendingUi.set(r.id, r);
        // (review) pi resolves a dialog with a timeout by itself: forget it then, and close it in the windows
        if (r.timeout) setTimeout(() => { if (pendingUi.delete(r.id)) for (const s of clients.values()) send(s, { type: "extension_ui_closed", id: r.id }); }, r.timeout + 1000).unref();
      } else if (r.method !== "notify") sticky.set(`${r.method}:${r.statusKey || r.widgetKey || ""}`, r);
    }
    for (const sock of clients.values()) send(sock, r);
  }));
  pi.on("error", (e) => { log(`couldn't start pi: ${e.message}`); try { fs.unlinkSync(SOCK); } catch {} process.exit(3); });
  pi.stdin.on("error", () => {});
  pi.on("exit", (code, sig) => {
    log(`pi exited (${sig || code}); closing`);
    for (const s of clients.values()) { send(s, { type: "broker_error", error: `pi exited (${sig || code})` }); s.end(); }
    try { fs.unlinkSync(SOCK); } catch {}
    process.exit(code ?? 1);
  });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { try { pi.kill("SIGTERM"); } catch {} });

  const srv = net.createServer((sock) => {
    const n = nextN++; clients.set(n, sock);
    log(`client ${n} connected (${clients.size} now)`);
    send(sock, { type: "broker_hello", agent: NAME, pid: pi.pid, clients: clients.size, cwd: process.cwd(), home: os.homedir() });
    for (const r of sticky.values()) send(sock, r);
    for (const r of pendingUi.values()) send(sock, r);
    sock.on("data", lines((l) => {
      let r; try { r = JSON.parse(l); } catch { send(sock, { type: "response", command: "parse", success: false, error: "bad JSON" }); return; }
      if (r.type === "broker_ping") { send(sock, { type: "broker_pong", t: r.t }); return; }
      if (r.type === "extension_ui_response") {
        if (!pendingUi.has(r.id)) return; // already answered by another client
        pendingUi.delete(r.id); toPi(r);
        for (const [m, s] of clients) if (m !== n) send(s, { type: "extension_ui_closed", id: r.id });
        return;
      }
      toPi({ ...r, id: `c${n}:${r.id ?? ""}` });
    }));
    const bye = () => {
      if (!clients.delete(n)) return;
      log(`client ${n} left (${clients.size} now)`);
      if (!clients.size) for (const id of pendingUi.keys()) { toPi({ type: "extension_ui_response", id, cancelled: true }); pendingUi.delete(id); }
    };
    sock.on("close", bye); sock.on("error", bye);
  });
  srv.listen(SOCK, () => { fs.chmodSync(SOCK, 0o600); log(`agent ${NAME}: pi ${pi.pid} in RPC mode, serving ${SOCK}`); });
} else { console.error("hbroker: usage: hbroker.mjs serve|connect NAME"); process.exit(2); }
