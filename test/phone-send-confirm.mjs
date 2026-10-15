#!/usr/bin/env node
// J663 (no silent success, Angus's 38a): the phone app's send to Thoughts (POST /api/send) says "sent" only when the receiver
// confirmed it, and a failed send loses nothing.
//  S1 a remote world whose Thoughts can't be reached (a stand-in tsh whose login has expired): the send is an error (502, "didn't
//     confirm"), never a 200 the page takes as sent (it used to answer 200 { error }, and the page cleared the text as sent).
//  S2 a 📎 file (π's pending upload, ~/Phone/.pending/…) sent to that world: an error, and the pending copy is STILL there, so the
//     same tile can be sent again (it used to be moved into ~/Phone first: the retry said "no longer on the laptop").
//  S3 the retry to that world fails the same way (not "not found"); then sent to a reachable world (A, the temp daemon): 200, the
//     file is in ~/Phone once (the earlier link is reused, no "name (2)"), its pending copy is gone, the text names it.
//  S4 "/ignore" with a 📎: refused (400), the pending copy kept (thoughts.ignore takes no files: they used to be dropped).
//  S5 the daemon gone mid-way (a stand-in daemon socket that closes every call): the send is an error, the pending copy kept.
//   node test/run.mjs test/phone-send-confirm.mjs   (exit 0 = pass; its own temp daemon and server, never the live ones)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url); // (it starts and ends a daemon and a server: only ever inside the test guard)
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j663-send-")), RD = path.join(T, "remote"), BIN = path.join(T, "bin"), HOME = path.join(T, "home"), PHONE = path.join(T, "Phone");
for (const d of [RD, BIN, HOME, PHONE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(BIN, "tsh"), `#!/bin/sh\nif [ "$1" = status ]; then echo "ERROR: Not logged in." >&2; exit 1; fi\nexit 9\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [path.join(BIN, "tsh"), "ssh", "me@example.invalid"], label: "Test" }));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };

const sock = path.join(T, "d.sock"), cfg = path.join(T, "cfg"), run = path.join(T, "run");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(run);
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, phone: { uploadDir: PHONE, folders: [PHONE], extraDirs: [] } }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const denv = { ...process.env, HOME, HYPRPI_SOCKET: sock, HYPRPI_STATE: path.join(T, "state"), XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(T, "xdg"), XDG_RUNTIME_DIR: run, HYPRPI_TEST: "1", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRLAND_INSTANCE_SIGNATURE: "j663-bogus", HYPRPI_REMOTE_DIR: RD };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "WAYLAND_DISPLAY"]) delete denv[k];
const daemon = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: denv, stdio: ["ignore", fs.openSync(path.join(T, "d.log"), "w"), fs.openSync(path.join(T, "d.err"), "w")] });
for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((z) => setTimeout(z, 200));
ok("a temp daemon of the test's own is up (never the live one)", fs.existsSync(sock), sock);
const { connect } = await import("../lib/client.mjs");
const fake = await connect({ path: sock, onEvent: () => {} }).catch(() => null);
if (fake) await fake.call("agent.hello", { agent_id: "hp-j663fake", pid: process.pid, name: "Fake663", want_workspace: 2, cwd: T }).catch(() => {});

const PORT = 19000 + Math.floor(Math.random() * 900), ORIGIN = `http://127.0.0.1:${PORT}`;
let srv = null;
const startServer = (env) => { srv = spawn(process.execPath, [path.join(ROOT, "remote-control/server.mjs")], { env: { ...env, HYPRPI_REMOTE_PORT: String(PORT) }, stdio: ["ignore", fs.openSync(path.join(T, "srv.log"), "a"), fs.openSync(path.join(T, "srv.log"), "a")] }); };
// (fetch, not http.request: the guard's preload trips on http's null-prototype connect options)
const req = async (method, p, { body = null, headers = {} } = {}) => {
  try { const rs = await fetch(`${ORIGIN}${p}`, { method, headers: { origin: ORIGIN, ...headers }, ...(body != null ? { body } : {}) }); const d = await rs.text(); let j = {}; try { j = JSON.parse(d); } catch { /* not json */ } return { status: rs.status, j }; }
  catch (e) { return { status: 0, j: { error: e.message } }; }
};
const send = (world, text, images) => req("POST", "/api/send", { body: JSON.stringify({ world, text, ...(images ? { images } : {}) }), headers: { "content-type": "application/json" } });
const upload = async (name, data) => {
  const t = (await req("GET", "/api/files/token")).j.token;
  return (await req("POST", "/api/upload", { body: data, headers: { "x-upload-token": t, "x-file-name": encodeURIComponent(name), "x-batch": "j663batch" + Math.random().toString(36).slice(2, 8), "x-pending": "1", "content-type": "application/octet-stream" } })).j;
};
const waitUp = async () => { for (let i = 0; i < 40; i++) { await new Promise((z) => setTimeout(z, 250)); const r = await req("GET", "/api/state"); if (r.status === 200) return true; } return false; };

try {
  startServer(denv);
  ok("the phone server is up (temp daemon, temp ~/Phone)", await waitUp());
  // S1
  let r = await send("H", "hello from the phone");
  ok("S1 an unreachable remote world: the send is NOT a 200 (the page would clear the text as sent)", r.status !== 200, `${r.status} ${JSON.stringify(r.j)}`);
  ok("S1 … a 502 that says Thoughts didn't confirm it, and why", r.status === 502 && /didn't confirm/.test(r.j.error || "") && /tsh login|reach|world-h|offline|ended/i.test(r.j.error || ""), r.j.error);
  // S2
  const up = await upload("report.pdf", "%PDF-1.4 j663 test file\n".repeat(50));
  ok("S2 a 📎 PDF uploaded as pending", up.path && up.path.includes(`${path.sep}.pending${path.sep}`) && fs.existsSync(up.path), JSON.stringify(up));
  r = await send("H", "see the PDF", [up.path]);
  ok("S2 sent to the unreachable world: an error, not 200", r.status === 502, `${r.status} ${JSON.stringify(r.j)}`);
  ok("S2 … its pending copy is still there (the tile can be sent again)", fs.existsSync(up.path));
  // S3
  r = await send("H", "see the PDF", [up.path]);
  ok("S3 the retry fails the same way, not 'not found' (the file isn't lost)", r.status === 502 && !r.j.bad, `${r.status} ${JSON.stringify(r.j)}`);
  r = await send("A", "see the PDF", [up.path]);
  ok("S3 sent to a reachable world (A, the temp daemon): 200", r.status === 200, `${r.status} ${JSON.stringify(r.j)}`);
  const inPhone = fs.readdirSync(PHONE).filter((f) => !f.startsWith("."));
  ok("S3 … the PDF is in ~/Phone once (no 'report (2).pdf' from the failed tries)", inPhone.length === 1 && inPhone[0] === "report.pdf", JSON.stringify(inPhone));
  ok("S3 … its pending copy is gone only now, after the confirmed send", !fs.existsSync(up.path) && !fs.existsSync(path.dirname(up.path)));
  const th = fake ? await fake.call("thoughts.get", { room: "A", limit: 20 }).catch(() => null) : null;
  ok("S3 … and the message in Thoughts-A's thread names it", !!th?.entries?.some((e) => e.role === "you" && /PDF saved: ~\/.*report\.pdf/.test(e.text || "")), JSON.stringify(th?.entries?.map((e) => e.text)).slice(0, 300));
  // S4
  const up2 = await upload("notes.pdf", "%PDF-1.4 second\n".repeat(20));
  r = await send("A", "/ignore keep this in mind", [up2.path]);
  ok("S4 /ignore with a 📎: refused (400), not dropped", r.status === 400 && /ignore/.test(r.j.error || ""), `${r.status} ${JSON.stringify(r.j)}`);
  ok("S4 … the pending copy kept", fs.existsSync(up2.path));
  // S5: the daemon answers nothing any more (a stand-in socket that takes calls and closes them): the send must fail visibly
  srv.kill(); await new Promise((z) => srv.on("exit", z));
  const net = await import("node:net");
  const deadSock = path.join(T, "dead.sock");
  const dead = net.createServer((c) => { let first = true; c.on("data", () => { if (first) { first = false; return; } c.destroy(); }); c.on("error", () => {}); }).listen(deadSock);
  void dead;
  startServer({ ...denv, HYPRPI_SOCKET: deadSock });
  const up3 = await (async () => { if (!(await waitUp())) return null; return upload("late.pdf", "%PDF-1.4 third\n".repeat(20)); })();
  r = await send("A", "anyone there?", up3?.path ? [up3.path] : undefined);
  ok("S5 a daemon that takes the call and never confirms: an error, not 200", r.status !== 200 && r.status !== 0, `${r.status} ${JSON.stringify(r.j)}`);
  ok("S5 … the pending copy kept", !up3?.path || fs.existsSync(up3.path));
} finally { try { srv?.kill(); } catch { /* gone */ } try { fake?.close(); } catch { /* gone */ } daemon.kill(); }
if (!fails) fs.rmSync(T, { recursive: true, force: true }); else console.log("state:", T);
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
