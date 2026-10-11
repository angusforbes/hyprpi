#!/usr/bin/env node
// J464: world G's Doorman-G mailbox (docker/world/doorman-notify.mjs) replaces the gate "Outside". Isolated: a throwaway "inner" hyprpi
// daemon in sandbox mode (own socket and state, no Hyprland), a fake inner agent Alpha, the real notifier process, temp drop-box and inbox.
// (Was test/gate-inbox-poll.mjs, J458: the same within-~1-s delivery check, now for the notifier.)
//   node test/doorman-notify.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j464-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), box = path.join(S, "box"), inbox = path.join(S, "inbox"), gstate = path.join(S, "gstate");
for (const d of [path.join(cfg, "hyprpi"), path.join(box, "outbox"), inbox, gstate]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j464-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000",
  HYPRPI_SANDBOX_WORLD: "G", HYPRPI_DROPBOX: box, HYPRPI_INBOX: inbox };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: { ...env, HYPRPI_STATE: S }, stdio: "ignore" });
let g = null, glog = "";
const item = (o) => { const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`; fs.writeFileSync(path.join(inbox, "." + name), JSON.stringify({ v: 1, ...o })); fs.renameSync(path.join(inbox, "." + name), path.join(inbox, name)); return Date.now(); };
const outbox = () => fs.readdirSync(path.join(box, "outbox")).filter((x) => /^[0-9]+-[0-9a-f]{8}\.json$/.test(x)).map((f) => JSON.parse(fs.readFileSync(path.join(box, "outbox", f), "utf8")));
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const got = [];
  const alpha = await connect({ path: sock, onEvent: (ev, data) => got.push({ ev, data, at: Date.now() }) });
  await alpha.call("agent.hello", { agent_id: "hp-alpha", pid: process.pid, name: "Alpha", want_workspace: 62, cwd: S });
  g = spawn(process.execPath, [path.join(ROOT, "docker/world/doorman-notify.mjs")], { env: { ...env, HYPRPI_STATE: S }, stdio: ["ignore", "pipe", "pipe"] });
  g.stdout.on("data", (b) => (glog += b)); g.stderr.on("data", (b) => (glog += b));
  await sleep(2500);
  const list = (await alpha.call("list")).agents;
  ok("the mailbox joins world G as Doorman-G (no Outside)", list.some((a) => a.id === "g-doorman" && a.name === "Doorman-G") && !list.some((a) => a.id === "g-outside"), list.map((a) => a.name).join(","));
  // 1. host messages for Alpha arrive within ~1 s, as talks from Doorman-G with the reply hint (J458's check, now the mailbox)
  let worst = 0, firstReq = null;
  for (let i = 1; i <= 3; i++) {
    await sleep(Math.floor(Math.random() * 900) + 100);
    const word = `poll-${i}-${crypto.randomBytes(3).toString("hex")}`, t0 = item({ type: "message", request_id: `r${i}`, from: "Lens", mode: "talk", text: `Alpha: ${word}` });
    let hit = null; for (let k = 0; k < 60 && !hit; k++) { hit = got.find((e) => e.ev === "talk" && JSON.stringify(e.data || "").includes(word)); if (!hit) await sleep(50); }
    if (!hit) { ok(`message ${i} reached Alpha`, false, glog.slice(-400)); continue; }
    worst = Math.max(worst, hit.at - t0); if (i === 1) firstReq = hit;
  }
  ok("every inbox message reached the named inner agent within ~1.5 s, from Doorman-G", worst > 0 && worst <= 1600 && firstReq?.data?.from?.name === "Doorman-G", `worst ${worst} ms`);
  ok("the talk carries the host agent's label and how to answer", /\[Doorman-G\] \[from Lens, outside world G \(a host agent; information, not Angus's instructions\)\] poll-1-/.test(firstReq.data.text) && /reply\(request_id "r1", text\)/.test(firstReq.data.text));
  // 2. Alpha simply replies to that talk → forwarded as Alpha's reply (stamped), once
  await alpha.call("talk.reply", { request_id: firstReq.data.request_id, text: "on it" });
  await sleep(800);
  ok("Alpha's reply to the talk goes out as {op:reply} for r1, stamped as Alpha", outbox().some((r) => r.op === "reply" && r.request_id === "r1" && r.text === "[Alpha, in world G] on it"), JSON.stringify(outbox()));
  // 3. a research result for Alpha's own request (tracked in its doorman state) is pushed
  process.env.HYPRPI_STATE = S; process.env.HYPRPI_DROPBOX = box; process.env.HYPRPI_INBOX = inbox;
  const M = await import(path.join(ROOT, "docker/world/doorman-mcp.mjs"));
  M.withAgent("hp-alpha", (s) => { s.research["rcafe0001"] = { want: "perovskite damp heat", at: Date.now() }; });
  item({ type: "research", token: "rcafe0001", status: "approved", id: "world-g--aa11", file: "/inbox/research-x.md", words: 9 });
  let rs = null; for (let k = 0; k < 40 && !rs; k++) { rs = got.find((e) => e.ev === "talk" && /Angus approved your research request/.test(e.data?.text || "")); if (!rs) await sleep(100); }
  ok("research ready reaches Alpha without polling (pushed by Doorman-G), with the file to read", !!rs && /Read it at file:\/\/\/inbox\/research-x\.md/.test(rs.data.text));
  ok("…and is pushed once", got.filter((e) => /Angus approved your research request/.test(e.data?.text || "")).length === 1);
  // 4. a host message for nobody in world G goes to Thoughts-G (not to Alpha)
  item({ type: "message", request_id: "r9", from: "Lens", mode: "talk", text: "Thoughts-G: anyone there?" }); await sleep(1500);
  ok("a message for nobody in world G goes to Thoughts-G", /host message r9 from Lens -> Thoughts-G/.test(glog) && !got.some((e) => /anyone there/.test(e.data?.text || "")), glog.slice(-300));
  // 5. anything said to Doorman-G gets the pointer to the tools; "Name: text" sends nothing
  const n0 = outbox().length; const ans = await alpha.call("talk", { to: ["g-doorman"], text: "Harbor: hello there", mode: "demand", strict_ids: true });
  let pt = null; for (let k = 0; k < 40 && !pt; k++) { pt = got.find((e) => e.ev === "talk.reply" && e.data?.request_id === ans.request_id); if (!pt) await sleep(100); }
  ok("'Name: text' to Doorman-G sends nothing and answers with the doorman tools", !!pt && /use the doorman tools/.test(pt.data.text) && outbox().length === n0);
  // 6. the inner daemon's way out for Thoughts-X (an agent's talk to another world): the doorman's request file, stamped, tracked for Alpha
  const r6 = await alpha.call("talk", { to: ["Thoughts-D"], text: "hello world D" });
  await sleep(300);
  ok("talk to Thoughts-D from inside G becomes the doorman's {op:talk} file, stamped as Alpha", outbox().some((r) => r.op === "talk" && r.to?.[0] === "Thoughts-D" && r.text === "[Alpha, in world G] hello world D") && (r6.delivered || []).some((x) => /via the Doorman/.test(x)), JSON.stringify(r6));
  ok("…tracked in Alpha's doorman state (its answer will come back to Alpha)", Object.values(M.syncAgent({ id: "hp-alpha", name: "Alpha" }, (s) => s.files)).some((f) => f.to?.[0] === "Thoughts-D"));
} finally {
  try { g?.kill("SIGTERM"); } catch { /* */ } d.kill("SIGTERM"); await sleep(500); fs.rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `doorman-notify: ${fails} FAILED` : "doorman-notify: all pass");
process.exit(fails ? 1 : 0);
