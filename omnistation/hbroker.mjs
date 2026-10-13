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
  const log = (m) => process.stderr.write(`[hbroker ${new Date().toISOString().slice(11, 19)}] ${m}\n`);
  // J543 (seen on world H: a daemon restarted from an agent's own `hyprpi ensure` inherited HYPRPI_REMOTE_RPC=1 and
  // HYPRPI_NAME, so pi-entry ran each of its one-shot `pi -p …` calls as "hbroker serve AGENT", twice a second; each one
  // unlinked the live agent's socket, so its windows found "isn't running" and stayed disconnected):
  // (1) a one-shot pi (-p / --print, or any mode but rpc) is never an agent: run it as plain pi and leave the socket alone
  if (piArgs.some((a) => a === "-p" || a === "--print" || /^--print=/.test(a)) || (piArgs.includes("--mode") && piArgs[piArgs.indexOf("--mode") + 1] !== "rpc")) {
    const p = spawn(process.env.HYPRPI_REMOTE_PI || "pi", piArgs, { stdio: "inherit" });
    p.on("error", (e) => { process.stderr.write(`hbroker: couldn't start pi: ${e.message}\n`); process.exit(127); });
    p.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { try { p.kill(s); } catch {} });
  } else {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  // (2) a live broker already serving this agent keeps its socket: this one refuses instead of unlinking it
  const live = await new Promise((res) => { const c = net.connect(SOCK); c.on("connect", () => { c.destroy(); res(true); }); c.on("error", () => res(false)); });
  if (live) { log(`agent ${NAME} is already served on ${SOCK}: not starting a second broker`); process.exit(6); }
  try { fs.unlinkSync(SOCK); } catch {}
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
      } else if (["setStatus", "setWidget", "setTitle"].includes(r.method)) sticky.set(`${r.method}:${r.statusKey || r.widgetKey || ""}`, r);
    }
    for (const sock of clients.values()) send(sock, r);
  }));
  // (3) the socket file is removed only while it is still ours (never another broker's that replaced it)
  let myIno = 0;
  const unlinkMine = () => { try { if (myIno && fs.statSync(SOCK).ino === myIno) fs.unlinkSync(SOCK); } catch {} };
  pi.on("error", (e) => { log(`couldn't start pi: ${e.message}`); unlinkMine(); process.exit(3); });
  pi.stdin.on("error", () => {});
  pi.on("exit", (code, sig) => {
    log(`pi exited (${sig || code}); closing`);
    for (const s of clients.values()) { send(s, { type: "broker_error", error: `pi exited (${sig || code})` }); s.end(); }
    unlinkMine();
    process.exit(code ?? 1);
  });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { try { pi.kill("SIGTERM"); } catch {} });

  const onClient = (sock) => {
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
  };
  const serve = () => {
    const srv = net.createServer(onClient);
    srv.on("error", (e) => log(`couldn't serve ${SOCK}: ${e.message}`));
    srv.listen(SOCK, () => { fs.chmodSync(SOCK, 0o600); myIno = fs.statSync(SOCK).ino; log(`agent ${NAME}: pi ${pi.pid} in RPC mode, serving ${SOCK}`); });
  };
  serve();
  // (4) its socket file gone (removed by something else): serve it again, so windows can reach this pi again
  setInterval(() => { if (!myIno) return; try { fs.statSync(SOCK); } catch (e) { if (e.code === "ENOENT") { log(`${SOCK} was removed: serving it again`); myIno = 0; serve(); } } }, 5000).unref();
  }
} else { console.error("hbroker: usage: hbroker.mjs serve|connect NAME"); process.exit(2); }
