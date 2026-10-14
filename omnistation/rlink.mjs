#!/usr/bin/env node
// omnistation/rlink.mjs LETTER (J555, Angus: "13b sounds great lets do it!"): ONE persistent link per remote world that carries all
// of that world's laptop panels to its daemon. A remote world's panels used to run on the remote machine over a raw pty (every key
// a round trip: ~70 ms on H, ~170 ms on the hub); now they run HERE, like a local world's, and only their daemon calls travel.
//
//   laptop panel ──unix socket──▶ rlink.mjs ══ one ssh (remote.sh link) ══▶ rlink-remote.mjs ──▶ the world's daemon socket
//
// The panels connect to $XDG_RUNTIME_DIR/hyprpi/link-<x>.sock (600, in a 700 folder) exactly as to a daemon (lib/client.mjs picks it
// when HYPRPI_REMOTE_LINK=<X>); each connection is one channel. Frames: see rlink-remote.mjs. Besides the daemon's own methods a
// panel may call `link.upload` { name, data } (a pasted image, base64, ≤ 10 MB): written on the machine, answered { path } there.
// Health: a ping every 15 s; nothing heard for 45 s = a dead link (sleep, network): the ssh is ended, every panel connection is
// closed (they reconnect by themselves, as after a daemon restart) and the link comes back with backoff (1 s … 30 s). A Teleport
// (tsh) login that has run out is never used (it would open a browser): the link waits, says so, and checks again every 30 s.
// One per world (the socket is the lock: a live one answers); it ends 10 min after its last panel closed.
//   node rlink.mjs X            run (panels start it: omnistation/world X panel)
//   node rlink.mjs X --status   one line: up / down (why) / not running, and how many panels
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { linkSocket } = await import(path.join(HERE, "../lib/paths.mjs"));
const WL = String(process.argv[2] || "").toUpperCase(), wl = WL.toLowerCase();
if (!/^[A-I]$/.test(WL)) { console.error("usage: rlink.mjs LETTER [--status]"); process.exit(2); }
const SOCK = linkSocket(WL), CTL = SOCK.replace(/\.sock$/, ".ctl");
// (LinkAgents) the panels' socket listens ONLY while the link is up: down, a panel's connect fails (as with a daemon that isn't
// running) instead of half-opening a channel whose calls time out, which made panels retry without closing it (connections grew
// with every outage). The control socket (status, one link per world) always answers.
const HELLO_MS = Number(process.env.HYPRPI_LINK_HELLO_MS) || 60000; // an ssh that hasn't said hello by then is ended (a stuck login)
const IDLE_MS = Number(process.env.HYPRPI_LINK_IDLE_MS) || 10 * 60e3, PING_MS = Number(process.env.HYPRPI_LINK_PING_MS) || 15000, DEAD_MS = PING_MS * 3;
const log = (...a) => { if (process.env.HYPRPI_LINK_LOG) try { fs.appendFileSync(process.env.HYPRPI_LINK_LOG, `${new Date().toISOString()} ${a.join(" ")}\n`); } catch { /* none */ } };

if (process.argv.includes("--status")) {
  const c = net.createConnection(CTL);
  c.on("connect", () => { c.write(JSON.stringify({ id: 1, method: "link.status", params: {} }) + "\n"); });
  let b = ""; c.on("data", (d) => { b += d; if (b.includes("\n")) { try { const r = JSON.parse(b.split("\n")[0]).result || {}; console.log(`world ${WL} link: ${r.up ? "up" : "down" + (r.why ? ` (${r.why})` : "")}, ${r.panels} panel connection(s)`); } catch { console.log("?"); } process.exit(0); } });
  c.on("error", () => { console.log(`world ${WL} link: not running`); process.exit(1); });
  setTimeout(() => { console.log(`world ${WL} link: not answering`); process.exit(1); }, 3000);
} else {
  await main();
}

async function main() {
  // the binding: the same private file as the windows and the phone bridge (remote-control/rworld.mjs)
  const { remoteOf } = await import(path.join(HERE, "../remote-control/rworld.mjs"));
  const w = remoteOf(WL);
  if (!w) { console.error(`rlink: world ${WL} isn't bound to a remote machine`); process.exit(2); }
  // one per world: a live link answers on the socket
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  // (LinkCheck) one link per world: an exclusive lock (O_EXCL, holding our pid) taken BEFORE anything is probed or unlinked; a
  // stale one (its pid gone, or not an rlink.mjs for this world) is taken over once; the loser never touches the owner's sockets
  const LOCK = SOCK.replace(/\.sock$/, ".lock");
  const isLink = (pid) => { try { const a = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); return a.some((x) => x.endsWith("/rlink.mjs")) && a.includes(WL) && !a.includes("--status"); } catch { return false; } };
  for (let tries = 0; ; tries++) {
    try { const fd = fs.openSync(LOCK, "wx", 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== "EEXIST" || tries > 1) process.exit(0);
      let old = 0; try { old = Number(fs.readFileSync(LOCK, "utf8")); } catch { /* being written: try again */ }
      if (!old) { await new Promise((r) => setTimeout(r, 100)); continue; }
      if (old !== process.pid && isLink(old)) process.exit(0);
      try { if (Number(fs.readFileSync(LOCK, "utf8")) === old) fs.unlinkSync(LOCK); } catch { /* another took it */ }
    }
  }
  const unlock = () => { try { if (Number(fs.readFileSync(LOCK, "utf8")) === process.pid) fs.unlinkSync(LOCK); } catch { /* gone */ } };
  process.on("exit", unlock);
  for (const f of [SOCK, CTL]) { try { fs.unlinkSync(f); } catch { /* none */ } }

  const clients = new Map(); // c -> { sock, opened, queue: [lines], uploads: Map(id -> local request id) }
  let nextC = 1, child = null, up = false, why = "starting", backoff = 1000, lastHeard = 0, lastClient = Date.now(), timer = null, downSince = Date.now();
  const toRemote = (o) => { if (child && up) { try { child.stdin.write(JSON.stringify(o) + "\n"); return true; } catch { /* below */ } } return false; };
  const panels = () => [...clients.values()].filter((k) => !k.probe).length; // (LinkCheck) a daemon probe isn't a panel
  const closeClient = (c) => { const k = clients.get(c); if (!k) return; clients.delete(c); try { k.sock.destroy(); } catch { /* gone */ } if (!k.probe && !panels()) lastClient = Date.now(); };
  // (LinkCheck) end one ssh: TERM, then KILL 2 s later if it's still THAT process; never its replacement
  const endSsh = (old) => { if (!old || old.killing) return; old.killing = true; try { process.kill(-old.pid, "SIGTERM"); } catch { /* gone */ } setTimeout(() => { if (old.exitCode === null && old.signalCode === null) { try { process.kill(-old.pid, "SIGKILL"); } catch { /* gone */ } } }, 2000).unref(); };

  // ---- the link (one ssh)
  const isTsh = path.basename(w.ssh[0]) === "tsh";
  const tshOk = () => new Promise((res) => {
    if (!isTsh) return res("");
    execFile(w.ssh[0], ["status", "--format=json"], { timeout: 8000 }, (e, out) => {
      if (e) return res("not logged in to Teleport: run `tsh login`");
      try { const u = Date.parse(JSON.parse(out).active?.valid_until || ""); res(u && u > Date.now() + 60000 ? "" : "the Teleport login has run out: run `tsh login`"); } catch { res("can't read `tsh status`"); }
    });
  });
  const remoteCmd = `bash ~/.hyprpi-${wl}/remote.sh link`;
  async function connect() {
    timer = null;
    const bad = await tshOk();
    if (bad) { why = bad; log("waiting:", bad); timer = setTimeout(connect, 30000); return; }
    why = "connecting";
    const ch = spawn(w.ssh[0], [...w.ssh.slice(1), remoteCmd], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    child = ch; let buf = "", err = "";
    lastHeard = Date.now();
    ch.stdout.setEncoding("utf8"); ch.stderr.setEncoding("utf8");
    ch.stderr.on("data", (d) => { err = (err + d).slice(-400); });
    ch.stdin.on("error", () => {});
    ch.stdout.on("data", (d) => {
      lastHeard = Date.now(); buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        let f; try { f = JSON.parse(l); } catch { continue; }
        if (f.t === "hi") { up = true; why = ""; backoff = 1000; log("up"); listen(); for (const fr of answersWaiting.splice(0)) toRemote(fr); for (const [c, k] of clients) if (!k.opened) { k.opened = true; toRemote({ t: "o", c }); for (const q of k.queue.splice(0)) toRemote({ t: "d", c, l: q }); } continue; }
        if (f.t === "P") continue;
        if (f.t === "out") { relayOut(f); continue; }
        const k = clients.get(Number(f.c));
        if (!k) continue;
        if (f.t === "d" && typeof f.l === "string") { k.heard = true; try { k.sock.write(f.l + "\n"); } catch { /* gone */ } }
        else if (f.t === "x") { const kk = clients.get(Number(f.c)); closeClient(Number(f.c)); if (kk && !kk.heard && /ECONNREFUSED|ENOENT/.test(String(f.e || ""))) { log("channel", f.c, "refused:", f.e); daemonDown(); } }
        else if (f.t === "ur") { const rid = k.uploads.get(f.id); k.uploads.delete(f.id); if (rid != null) { try { k.sock.write(JSON.stringify(f.error ? { id: rid, error: `upload: ${f.error}` } : { id: rid, result: { path: f.path } }) + "\n"); } catch { /* gone */ } } }
      }
    });
    const end = () => {
      if (ch.hDone) return; ch.hDone = true;
      if (child === ch) { child = null; }
      if (up) downSince = Date.now();
      up = false; why = (err.trim().split("\n").pop() || "the link ended").slice(0, 200); log("down:", why); unlisten();
      for (const c of [...clients.keys()]) closeClient(c); // the panels reconnect by themselves (as after a daemon restart)
      try { process.kill(-ch.pid, "SIGTERM"); } catch { /* gone */ }
      if (!timer) { timer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); }
    };
    ch.on("close", end); ch.on("error", (e) => { err += `\n${e.message}`; end(); });
  }
  // (LinkCheck) the link is up but the world's DAEMON doesn't answer (restarting, stopped): panels must not connect then either (their
  // retries would multiply, as with a down link), so the panel socket closes until a probe channel gets a daemon answer again
  let probing = null;
  function daemonDown() {
    if (probing || !up) return; log("daemon down: probing"); downSince = Date.now(); /* panels can't connect now: the longer, "down" idle rule applies */ why = `world ${WL}'s daemon doesn't answer`; unlisten(); for (const c of [...clients.keys()]) closeClient(c);
    const probe = () => {
      if (!up) { probing = null; return; }
      const c = nextC++; const k = { sock: { write: (l) => { if (/"result"/.test(l)) { clients.delete(c); toRemote({ t: "x", c }); clearTimeout(probing); probing = null; why = ""; log("daemon back"); listen(); } }, destroy() {} }, opened: true, queue: [], uploads: new Map(), probe: true };
      clients.set(c, k); toRemote({ t: "o", c }); toRemote({ t: "d", c, l: JSON.stringify({ id: 1, method: "room.current", params: {} }) });
      probing = setTimeout(() => { if (clients.get(c) === k) { clients.delete(c); toRemote({ t: "x", c }); } probe(); }, 2000);
    };
    probe();
  }
  // J555 (Angus 17b): the machine's message for one of the LAPTOP's Thoughts (Thoughts-A …): asked here (the laptop daemon's
  // thoughts.relayAsk, as the laptop's own relay to a remote world does), its answer polled and sent back over the link
  const seenOut = new Map(); // id -> when (a re-attached link resends what's still waiting: asked once)
  const relaying = new Set(), answersWaiting = [];
  // the ops a world's machine may ask the laptop to do (link.call): op -> a module (relative to omnistation/) exporting
  // handle(world, args) -> JSON. Tests may add one (HYPRPI_TEST=1, HYPRPI_TEST_LINK_OP=op:/abs/module.mjs)
  const LINK_OPS = { jot: "../lib/jot-relay-host.mjs" };
  if (process.env.HYPRPI_TEST === "1" && /^[a-z-]+:\/.+\.mjs$/.test(process.env.HYPRPI_TEST_LINK_OP || "")) { const [o, m] = process.env.HYPRPI_TEST_LINK_OP.split(/:(.*)/); LINK_OPS[o] = path.relative(HERE, m); }
  async function relayOut(f) {
    const id = String(f.id || ""); if (!/^[0-9a-f-]{36}$/.test(id) || seenOut.has(id)) return; seenOut.set(id, Date.now());
    for (const [k, t] of seenOut) if (Date.now() - t > 3600e3) seenOut.delete(k);
    relaying.add(id);
    const back = (o) => { relaying.delete(id); log("ans", id, o.error ? `error: ${o.error}` : "answer"); const fr = { t: "ans", id, ...o }; if (!toRemote(fr)) answersWaiting.push(fr); }; // (down now: sent when it's back)
    if (f.kind === "call") { // J555 (Namesmith's J561): an allow-listed op the machine asks the laptop to do; its handler module answers
      const mod = LINK_OPS[String(f.op || "")];
      if (!mod) return back({ error: `no op ${String(f.op || "?").slice(0, 40)} on the laptop` });
      try {
        const m = await import(path.join(HERE, mod));
        if (typeof m.handle !== "function") throw new Error(`${mod} has no handle()`);
        const result = await Promise.race([m.handle(WL, f.args ?? null), new Promise((_, rej) => setTimeout(() => rej(new Error("the op took over 60 s")), 60000))]);
        return back({ result: result ?? null });
      } catch (e) { return back({ error: String(e?.message || e).slice(0, 500) }); }
    }
    const to = String(f.to || "").toUpperCase();
    if (!/^[A-I]$/.test(to)) return back({ error: "bad world" });
    let c = null;
    try {
      const { connect } = await import(path.join(HERE, "../lib/client.mjs"));
      const { socketPath } = await import(path.join(HERE, "../lib/paths.mjs"));
      const req = async (m, p) => { if (!c || c.closed) c = await connect({ path: socketPath() }); return c.call(m, p, { timeoutMs: 15000 }); };
      const { request_id } = await req("thoughts.relayAsk", { room: to, from: String(f.from || `Thoughts-${WL}`).slice(0, 80), text: String(f.text || ""), mode: f.mode === "talk" ? "talk" : "demand", fromThoughts: /^[A-I]$/.test(String(f.fromThoughts || "")) ? f.fromThoughts : "", via: `via world ${WL}'s link` });
      log("out", id, "→ Thoughts-" + to);
      for (const end = Date.now() + 30 * 60e3; Date.now() < end;) {
        await new Promise((r) => setTimeout(r, 3000));
        try { const r = await req("thoughts.relayResult", { request_id }); if (r.answer != null) { back({ answer: String(r.answer) }); return; } }
        catch (e) { log("relayResult:", e.message); if (/unknown or expired/.test(e.message)) { back({ error: e.message }); return; } c = null; } // a laptop daemon restart: keep waiting
      }
      back({ error: "no answer within 30 min" });
    } catch (e) { back({ error: `the laptop: ${e.message}` }); }
    finally { try { c?.close(); } catch { /* gone */ } }
  }
  // keepalive: a ping every PING_MS; nothing heard for DEAD_MS = dead (a slept laptop, a hung ssh): end it, reconnect
  setInterval(() => {
    if (child && up) { if (Date.now() - lastHeard > DEAD_MS) { log("silent for", DEAD_MS, "ms"); endSsh(child); } else toRemote({ t: "p", ts: Date.now() }); } // (LinkCheck) the OLD ssh only, never its replacement
    else if (child && !up && Date.now() - lastHeard > HELLO_MS) endSsh(child); // (a login prompt or a hang before hello: TERM, then KILL)
    // idle: up with no panel for IDLE_MS; down (nobody can connect then) for 6 × IDLE_MS (panel-link.sh restarts it while a panel lives)
    if (!panels() && !relaying.size && !answersWaiting.length && (up && !probing ? Date.now() - lastClient > IDLE_MS : Date.now() - Math.max(lastClient, downSince) > 6 * IDLE_MS)) bye();
  }, Math.min(PING_MS, 5000)).unref?.();
  // a laptop waking from sleep: check at once rather than at the next ping
  let lastTick = Date.now();
  setInterval(() => { const now = Date.now(); if (now - lastTick > 20000 && child && up) { lastHeard = 0; } lastTick = now; }, 2000).unref?.();

  // ---- the panels' side
  const onPanel = (sock) => {
    const c = nextC++; const k = { sock, opened: false, queue: [], uploads: new Map() }; clients.set(c, k); lastClient = Date.now();
    if (up) { k.opened = true; toRemote({ t: "o", c }); }
    let buf = ""; let nUp = 0;
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
        let m = null; try { m = JSON.parse(l); } catch { /* passed on as it is */ }
        if (m?.method === "link.upload") {
          const p = m.params || {};
          if (!up) { sock.write(JSON.stringify({ id: m.id, error: `the link to world ${WL} is down${why ? ` (${why})` : ""}` }) + "\n"); continue; }
          const uid = ++nUp; k.uploads.set(uid, m.id); toRemote({ t: "u", c, id: uid, name: String(p.name || ""), data: String(p.data || "") }); continue;
        }
        if (k.opened) toRemote({ t: "d", c, l }); else if (k.queue.length < 200) k.queue.push(l);
      }
    });
    const gone = () => { if (clients.get(c) === k) { clients.delete(c); toRemote({ t: "x", c }); if (!panels()) lastClient = Date.now(); } };
    sock.on("close", gone); sock.on("error", gone);
  };
  // a NEW server each time it listens (a closed one may still be finishing; reusing it left the socket accepting while "down")
  let srv = null;
  function listen() { if (srv) return; const s = net.createServer(onPanel); srv = s; s.on("error", (e) => { log(`panel socket: ${e.message}`); if (srv === s) srv = null; }); try { fs.unlinkSync(SOCK); } catch { /* none */ } s.listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); } catch { /* fine */ } log("listening", SOCK); }); }
  function unlisten() { if (!srv) return; const s = srv; srv = null; try { s.close(); } catch { /* fine */ } try { fs.unlinkSync(SOCK); } catch { /* gone */ } }
  const ctl = net.createServer((sock) => {
    let b = ""; sock.setEncoding("utf8");
    sock.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); let m = null; try { m = JSON.parse(l); } catch { continue; }
      if (m?.method === "link.status") sock.write(JSON.stringify({ id: m.id, result: { up: up && !probing, why, panels: [...clients.values()].filter((x) => !x.probe).length } }) + "\n"); } });
    sock.on("error", () => {});
  });
  ctl.listen(CTL, () => { try { fs.chmodSync(CTL, 0o600); } catch { /* fine */ } });
  ctl.on("error", (e) => { console.error(`rlink: ${e.message}`); process.exit(1); });
  function bye() { log("idle: bye"); unlisten(); try { ctl.close(); } catch { /* fine */ } try { fs.unlinkSync(CTL); } catch { /* gone */ } if (child) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } } process.exit(0); }
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, bye);
  connect();
}
