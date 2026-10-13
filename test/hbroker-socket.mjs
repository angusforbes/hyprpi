#!/usr/bin/env node
// J543 (1) proof: omnistation/hbroker.mjs never takes over or removes a live agent's socket.
//   node test/hbroker-socket.mjs   (exit 0 = pass; no network, a fake pi; about 10 s)
// Seen on world H: a daemon with an agent's env made pi-entry run its one-shot `pi -p …` calls as "hbroker serve AGENT";
// each unlinked the live broker's socket, so the agent's windows found "isn't running". Checked:
//   1. serve NAME -- (rpc) serves the socket; a client gets broker_hello and answers
//   2. serve NAME -- -p …  runs pi as plain pi (its output on stdout) and leaves the socket alone
//   3. a second serve NAME while the first is live refuses (exit 6); the first still answers
//   4. the socket file removed by something else: the live broker serves it again within ~5 s
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HB = process.env.HB || path.join(ROOT, "omnistation/hbroker.mjs");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = fs.mkdtempSync(path.join(os.tmpdir(), "j543-hb-"));
const PI = path.join(D, "fake-pi");
fs.writeFileSync(PI, `#!/usr/bin/env node
if (process.argv.includes("-p")) { console.log("a topic label"); process.exit(0); }
let b = ""; process.stdin.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\\n")) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); const r = JSON.parse(l); process.stdout.write(JSON.stringify({ type: "response", id: r.id, command: r.type, success: true, data: { pong: true } }) + "\\n"); } });
`, { mode: 0o755 });
const env = { ...process.env, HYPRPI_SOCKET: path.join(D, "daemon.sock"), HYPRPI_REMOTE_PI: PI };
const SOCK = path.join(D, "t1.rpc.sock");
const inoOf = () => { try { return fs.statSync(SOCK).ino; } catch { return 0; } };
const ask = () => new Promise((res) => {
  const c = net.connect(SOCK); let buf = "", hello = false; const t = setTimeout(() => { c.destroy(); res("timeout"); }, 3000);
  c.on("error", (e) => { clearTimeout(t); res(e.code); });
  c.on("data", (d) => { buf += d; for (const l of buf.split("\n").slice(0, -1)) { const r = JSON.parse(l); if (r.type === "broker_hello") { hello = true; c.write(JSON.stringify({ type: "get_state", id: "q1" }) + "\n"); } if (r.type === "response" && r.id === "q1") { clearTimeout(t); c.destroy(); res(hello ? "answered" : "no hello"); } } buf = buf.slice(buf.lastIndexOf("\n") + 1); });
});
const first = spawn(process.execPath, [HB, "serve", "t1", "--", "--session-dir", D], { env, stdio: ["ignore", "ignore", "pipe"] });
let errs = ""; first.stderr.on("data", (d) => { errs += d; });
try {
  for (let i = 0; i < 50 && !fs.existsSync(SOCK); i++) await sleep(100);
  ok("1 the broker serves its socket and answers", (await ask()) === "answered");
  const ino = inoOf();
  const p = spawnSync(process.execPath, [HB, "serve", "t1", "--", "-p", "--no-session", "label this"], { env, encoding: "utf8", timeout: 10000 });
  ok("2 serve -- -p runs plain pi", p.status === 0 && p.stdout.trim() === "a topic label", JSON.stringify([p.status, p.stdout, p.stderr]));
  ok("2 ... and leaves the socket alone", inoOf() === ino && (await ask()) === "answered");
  const second = spawnSync(process.execPath, [HB, "serve", "t1", "--"], { env, encoding: "utf8", timeout: 10000 });
  ok("3 a second broker for a live agent refuses", second.status === 6, JSON.stringify([second.status, second.stderr.trim()]));
  ok("3 ... and the first still answers on the same socket", inoOf() === ino && (await ask()) === "answered");
  try { fs.unlinkSync(SOCK); } catch {}
  let back = false; for (let i = 0; i < 80 && !back; i++) { await sleep(100); back = fs.existsSync(SOCK); }
  ok("4 a removed socket is served again", back && (await ask()) === "answered");
} finally {
  first.kill("SIGTERM"); await sleep(500);
  ok("the broker removes its own socket when it ends", !fs.existsSync(SOCK));
  fs.rmSync(D, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED\n${errs}` : "all passed");
process.exit(fails ? 1 : 0);
