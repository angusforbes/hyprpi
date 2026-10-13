#!/usr/bin/env node
// J543 (1) proof (Angus: "An agent window stuck on 'reconnecting' won't take my typing (omni-alpha)").
//   node test/remote-client-reconnect.mjs   (exit 0 = pass; no network, no real agent; about 1 minute)
// Runs omnistation/remote-client.mjs headlessly under a pty (`script`), with a fake binding whose "ssh" is a local stub
// (fake-ssh below). The stub does what its mode file says: ok (pipe to a test broker on a unix socket), expired (a login
// error), hang (no output, never exits), hang-escape (hangs, and a detached leftover keeps the pipe open, so no "close"),
// notrunning (the broker's "agent isn't running"). The test broker answers pi's RPC and records every prompt. Checked:
//   1. connected: the footer's link entry is empty; a message is delivered
//   2. drop, then an expired login: the footer says "login expired"; the editor takes keys; Enter queues (in order)
//   3. a hung ssh (no output) is killed and retried; a hung one whose pipe stays open is too
//   4. the agent stopped: the footer says so (waiting); then it's back: the queued messages arrive once, in order
//   5. a link that goes quiet after hello: the footer says "no answer", it is dropped and reconnected
//   6. the link drops while a message is in flight: it goes back to the editor (never sent twice), the next one is delivered
//   7. the laptop "sleeps" (SIGSTOP 6 s): on waking the dead link is noticed and it reconnects
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLIENT = process.env.CLIENT || path.join(ROOT, "omnistation/remote-client.mjs");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D = fs.mkdtempSync(path.join(os.tmpdir(), "j543-rc-"));
const SOCK = path.join(D, "broker.sock"), MODE = path.join(D, "mode"), LOG = path.join(D, "debug.log"), PIDS = path.join(D, "pids");
const mode = (m) => fs.writeFileSync(MODE, m);
fs.writeFileSync(LOG, ""); fs.writeFileSync(PIDS, "");

// ---- the ssh stub: argv = the remote command (ignored); behaviour from the mode file
const STUB = path.join(D, "fake-ssh.mjs");
fs.writeFileSync(STUB, `
import fs from "node:fs"; import net from "node:net"; import { spawn } from "node:child_process";
const m = fs.readFileSync(${JSON.stringify(MODE)}, "utf8").trim();
fs.appendFileSync(${JSON.stringify(PIDS)}, process.pid + "\\n");
if (m === "expired") { process.stderr.write("ERROR: ssh: cert has expired, run 'tsh login'\\n"); process.exit(1); }
if (m === "notrunning") { process.stdout.write(JSON.stringify({ type: "broker_error", error: "agent t1 isn't running here (ENOENT)" }) + "\\n"); process.exit(4); }
if (m === "hang") setInterval(() => {}, 1e6);
else if (m === "hang-escape") { // a leftover in its own session (a kill of the ssh's group misses it) holding stdout open
  const c = spawn("sleep", ["120"], { detached: true, stdio: ["ignore", "inherit", "ignore"] }); fs.appendFileSync(${JSON.stringify(PIDS)}, "-" + c.pid + "\\n"); c.unref();
  setInterval(() => {}, 1e6);
} else { const s = net.connect(${JSON.stringify(SOCK)}); process.stdin.pipe(s); s.pipe(process.stdout); s.on("close", () => process.exit(0)); s.on("error", () => process.exit(5)); process.stdin.on("end", () => s.end()); }
`);
const CONF = path.join(D, "i.json");
fs.writeFileSync(CONF, JSON.stringify({ ssh: [process.execPath, STUB], label: "Test" }));

// ---- the test broker: pi's RPC, enough for the window
const prompts = []; const history = []; const socks = new Set();
let dropOn = null; // a prompt text: record it, then drop the link without answering
const srv = net.createServer((s) => {
  socks.add(s); s.on("close", () => socks.delete(s)); s.on("error", () => {});
  const tx = (o) => { if (!s.hung) try { s.write(JSON.stringify(o) + "\n"); } catch {} };
  tx({ type: "broker_hello", agent: "t1", pid: 1, clients: 1, cwd: "/home/x/work", home: "/home/x" });
  let buf = "";
  s.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l) continue;
      const r = JSON.parse(l); if (s.hung) continue;
      const res = (data) => tx({ type: "response", id: r.id, command: r.type, success: true, data });
      if (r.type === "broker_ping") tx({ type: "broker_pong", t: r.t });
      else if (r.type === "get_state") res({ model: { provider: "p", id: "m" }, thinkingLevel: "off", isStreaming: false, pendingMessageCount: 0, sessionId: "s1" });
      else if (r.type === "get_session_stats") res({ tokens: {}, cost: 0 });
      else if (r.type === "get_available_models") res({ models: [] });
      else if (r.type === "get_messages") res({ messages: history });
      else if (r.type === "prompt") {
        prompts.push(r.message); history.push({ role: "user", content: r.message });
        if (r.message === dropOn) { s.destroy(); continue; }
        res({}); tx({ type: "message_start", message: { role: "user", content: r.message } });
      } else res({});
    }
  });
});
await new Promise((r) => srv.listen(SOCK, r));
const dropAll = () => { for (const s of socks) s.destroy(); };

// ---- the window, under a pty
mode("ok");
const env = { ...process.env, HYPRPI_REMOTE_CONF: CONF, HYPRPI_REMOTE_WS: "81", HYPRPI_REMOTE_DEBUG: LOG, HYPRPI_REMOTE_DEAD_MS: "3000" };
const win = spawn("script", ["-qfec", `stty cols 140 rows 40; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLIENT)} I t1`, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] });
let screen = ""; win.stdout.on("data", (d) => { screen += d; }); win.stderr.on("data", (d) => { screen += d; });
const plain = () => screen.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const keys = async (t) => { for (const ch of t) { win.stdin.write(ch); await sleep(25); } };
const log = () => fs.readFileSync(LOG, "utf8");
let mark = 0; const since = () => log().slice(mark); const setMark = () => { mark = log().length; };
async function waitLog(re, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const m = since().match(re); if (m) return m; await sleep(100); } return null; }
const footerNow = () => { const all = [...log().matchAll(/footer (".*")$/gm)]; return all.length ? JSON.parse(all.at(-1)[1]) : ""; };
const editorNow = () => { const all = [...log().matchAll(/editor (".*")$/gm)]; return all.length ? JSON.parse(all.at(-1)[1]) : null; };

try {
  // 1. connected
  ok("1 the window connects and loads", !!(await waitLog(/ready/, 30000)));
  ok("1 footer: no link entry while connected", footerNow() === "", JSON.stringify(footerNow()));
  setMark(); await keys("m1\r");
  ok("1 a message is delivered", !!(await waitLog(/sent "m1"/)) && prompts.join() === "m1", prompts.join());

  // 2. drop + expired login; typing while disconnected
  mode("expired"); setMark(); dropAll();
  ok("2 the drop is noticed", !!(await waitLog(/link ended/)));
  ok("2 an expired login says so in the footer", !!(await waitLog(/footer ".*login expired/)), footerNow());
  await sleep(300); await keys("m2");
  ok("2 the editor takes keys while disconnected", editorNow() === "m2", JSON.stringify(editorNow()));
  await keys("\r"); await keys("m3\r");
  ok("2 Enter queues them in order (and retries now)", !!(await waitLog(/queued "m3" \(2;/)), since().match(/queued .*/g)?.join(" | "));
  ok("2 the queue shows in the footer", !!(await waitLog(/footer ".* 2 to send"/, 3000)), footerNow());
  ok("2 nothing sent while disconnected", prompts.join() === "m1", prompts.join());

  // 3. a hung ssh, then one whose pipe a leftover holds open (Enter on the empty editor retries at once)
  const nextConnect = async (m) => { mode(m); await waitLog(/link (retry|login|agent)/, 60000); setMark(); await keys("\r"); return Number((await waitLog(/connect: ssh pid (\d+)/, 5000))?.[1]); };
  let pid = await nextConnect("hang");
  ok("3 Enter on the empty editor retries at once", pid > 0);
  ok("3 the footer shows it's reconnecting", !!(await waitLog(/footer ".*reconnecting… \(\d+ s/)), footerNow());
  ok("3 a hung ssh is killed after the dead time", !!(await waitLog(new RegExp(`link silent .* killing ssh ${pid}`), 10000)));
  ok("3 ... and the next try is scheduled", !!(await waitLog(/link (retry|login) /, 8000)), footerNow());
  pid = await nextConnect("hang-escape");
  ok("3 a hung ssh with its pipe held open is killed", !!(await waitLog(new RegExp(`link silent .* killing ssh ${pid}`), 10000)));
  ok("3 ... and its end is handled without a close", !!(await waitLog(/link ended \((exit|killed)\)/, 8000)), since().match(/link ended.*/)?.[0]);
  ok("3 ... and the next try is scheduled", !!(await waitLog(/link (retry|login) /, 8000)), footerNow());

  // 4. the agent stopped, then back
  pid = await nextConnect("notrunning");
  ok("4 a stopped agent shows as waiting", !!(await waitLog(/footer ".*stopped · waiting/, 10000)), footerNow());
  pid = await nextConnect("ok");
  ok("4 it reconnects when the agent is back", !!(await waitLog(/ready/, 10000)));
  await waitLog(/sent "m3"/, 5000);
  ok("4 the queued messages arrive once, in order", prompts.join() === "m1,m2,m3", prompts.join());
  ok("4 the footer's link entry is gone again", !!(await waitLog(/footer ""/, 3000)) && footerNow() === "", JSON.stringify(footerNow()));
  ok("4 the screen showed the login and stopped states", /login expired/.test(plain()) && /stopped · waiting/.test(plain()));

  // 5. quiet after hello
  setMark(); for (const s of socks) s.hung = true;
  ok("5 a quiet link shows 'no answer'", !!(await waitLog(/footer ".*no answer for/, 10000)), footerNow());
  ok("5 it is dropped and reconnected", !!(await waitLog(/link silent[\s\S]*ready/, 20000)));
  setMark(); await keys("m4\r");
  ok("5 a message after the reconnect is delivered", !!(await waitLog(/sent "m4"/)) && prompts.join() === "m1,m2,m3,m4", prompts.join());

  // 6. the link drops with a message in flight
  dropOn = "m5"; setMark(); await keys("m5\r");
  ok("6 a message whose answer never came goes back to the editor", !!(await waitLog(/send failed .*"m5" back in the editor/)));
  await sleep(200);
  dropOn = null; await sleep(300); await keys("\x7f\x7f"); // (clear "m5" from the editor before typing the next message)
  await sleep(200); await keys("m6\r");
  ok("6 the next one is delivered after the reconnect", !!(await waitLog(/sent "m6"/, 20000)));
  ok("6 none sent twice", prompts.join() === "m1,m2,m3,m4,m5,m6", prompts.join());

  // 7. sleep
  setMark(); const cpid = Number((log().match(/connect: ssh pid/) && fs.readFileSync(`/proc/${win.pid}/task/${win.pid}/children`, "utf8").trim().split(/\s+/)[0]) || 0);
  ok("7 found the window's process", cpid > 0);
  if (cpid) {
    process.kill(cpid, "SIGSTOP"); dropAll(); await sleep(6000); process.kill(cpid, "SIGCONT"); process.kill(win.pid, "SIGCONT"); // (script stops itself when its child stops)
    ok("7 on waking it notices and reconnects", !!(await waitLog(/woke after[\s\S]*ready/, 20000)), since().match(/woke.*|link.*/g)?.join(" | "));
    setMark(); await keys("m7\r");
    ok("7 ... and delivers", !!(await waitLog(/sent "m7"/)) && prompts.at(-1) === "m7", prompts.join());
  }

  await keys("/quit\r"); await sleep(1500);
} finally {
  try { process.kill(win.pid, "SIGTERM"); } catch {}
  for (const l of fs.readFileSync(PIDS, "utf8").split("\n").filter(Boolean)) { const p = Math.abs(Number(l)); try { process.kill(p, "SIGKILL"); } catch {} }
  srv.close();
  if (fails && !process.env.KEEP) console.log(`debug log: ${LOG}`); else if (!process.env.KEEP) fs.rmSync(D, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
