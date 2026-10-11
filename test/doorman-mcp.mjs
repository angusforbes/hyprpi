// node test/doorman-mcp.mjs  (J462: world G's "doorman" MCP server, offline)
// Temp drop-box, inbox and state; a fake inner daemon list; a fake relay loop that answers outbox files the way the real relay does
// (result items, then research / decision / reply items). Checks: the exact outbox files (the gate's format and sender stamp), the
// gate's pre-checks and refusal texts, who-is-asking (the daemon's name, an ancestor pid), the hand-off to the gate, inbox / wait, reply,
// and the stdio MCP protocol.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j462-")), BOX = path.join(T, "box"), INBOX = path.join(T, "inbox"), STATE = path.join(T, "state");
for (const d of [path.join(BOX, "outbox"), INBOX, STATE]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { HYPRPI_DROPBOX: BOX, HYPRPI_INBOX: INBOX, HYPRPI_STATE: STATE, HYPRPI_AGENT_ID: "hp-alpha01", HYPRPI_SOCKET: path.join(T, "none.sock") });
const M = await import("../docker/world/doorman-mcp.mjs");
let agents = [{ id: "hp-alpha01", name: "Alpha", pid: process.ppid }, { id: "hp-beta01", name: "Beta", pid: 999999 }];
M._test.setList(async () => agents);
let n = 0; const ok = (m) => { n++; console.log("ok " + m); };
let seq = 0; const item = (o) => { const name = `${String(Date.now()).padStart(13, "0")}-${(seq++).toString(16).padStart(8, "0")}.json`; fs.writeFileSync(path.join(INBOX, name), JSON.stringify(o)); return name; };
// the fake relay: takes each outbox file, records it, answers with a result (and lets the test add later items)
const taken = [];
let answer = (req, file) => ({ ok: true });
const relay = setInterval(() => {
  for (const f of fs.readdirSync(path.join(BOX, "outbox")).filter((x) => /^[0-9]+-[0-9a-f]{8}\.json$/.test(x))) {
    const req = JSON.parse(fs.readFileSync(path.join(BOX, "outbox", f), "utf8")); fs.unlinkSync(path.join(BOX, "outbox", f));
    const tracked = fs.existsSync(path.join(STATE, "doorman-mcp", "adopt", f)) && fs.readdirSync(path.join(STATE, "doorman-mcp", "agents")).some((x) => JSON.parse(fs.readFileSync(path.join(STATE, "doorman-mcp", "agents", x), "utf8")).files?.[f]);
    taken.push({ f, req, tracked }); item({ type: "result", for: f, op: req.op, ...answer(req, f) });
  }
}, 100);

// 1. research: the gate's exact file, the sender from the daemon, the relay's result as the tool's answer, the hand-off to the gate
answer = (req) => req.op === "research" ? { ok: true, research: "r0a1b2c3d", depth: req.depth, mode: "open", status: "started" } : { ok: true };
let r = await M.call("research", { question: "damp heat results for perovskite modules", deep: true });
assert.equal(r.ok, true, JSON.stringify(r)); assert.match(r.text, /research started \(deep, id r0a1b2c3d\): Angus reviews it before it reaches you \(mode open\)/);
assert.deepEqual(taken.at(-1).req, { op: "research", looking_for: "damp heat results for perovskite modules", depth: "deep", from: "Alpha" });
const ad = JSON.parse(fs.readFileSync(path.join(STATE, "doorman-mcp", "adopt", taken.at(-1).f), "utf8"));
assert.deepEqual(ad.asker, { id: "hp-alpha01", name: "Alpha" }); assert.equal(ad.kind, "research");
ok("research writes the gate's {op:research, looking_for, depth, from} file, stamped with the daemon's name; returns the relay's answer; hands it to the gate");
// later: the research is approved → a notice with the file to read, via wait
setTimeout(() => item({ type: "research", token: "r0a1b2c3d", status: "approved", id: "world-g--aa11", file: "/inbox/research-r0a1b2c3d.md", words: 900 }), 300);
r = await M.call("wait", { seconds: 5 });
assert.equal(r.notices.length, 1); assert.match(r.notices[0].text, /^Angus approved your research request \(your words: "damp heat results for perovskite modules"\)\. Read it at \/inbox\/research-r0a1b2c3d\.md/); assert.equal(r.notices[0].path, "/inbox/research-r0a1b2c3d.md");
ok("wait returns the research outcome (with the file to read) as soon as it comes");

// 2. ask_doorman and message: talk files with the stamp; a held message, Angus's decision, the host reply
answer = (req) => req.op === "talk" && req.to[0] === "Doorman-G" ? { ok: true, delivered: ["Doorman-G (hp-door, room G)"], request_id: "req-door-1" } : req.op === "talk" ? { ok: true, delivered: [], pending: ["world-g--bb22"] } : { ok: true };
r = await M.call("ask_doorman", { question: "can I get the fixture project shared?" });
assert.deepEqual(taken.at(-1).req, { op: "talk", to: ["Doorman-G"], text: "[Alpha, in world G] can I get the fixture project shared?", mode: "talk" });
assert.match(r.text, /your message to Doorman-G: sent to Doorman-G/);
item({ type: "reply", request_id: "req-door-1", from: "Doorman-G", text: "Drafted a share request for Angus." });
r = await M.call("message", { to: "Harbor, Thoughts-B", text: "hello from G", demand: true });
assert.deepEqual(taken.at(-1).req, { op: "talk", to: ["Harbor", "Thoughts-B"], text: "[Alpha, in world G] hello from G", mode: "demand" });
assert.match(r.text, /held for Angus's approval \(id world-g--bb22\)/);
item({ type: "decision", id: "world-g--bb22", decision: "approved", delivered: ["Harbor"], request_id: "req-h-2" });
item({ type: "reply", request_id: "req-h-2", from: "Harbor", text: "hi Alpha" });
item({ type: "reply", request_id: "someone-elses", from: "X", text: "not for Alpha" });
r = await M.call("inbox", {});
const texts = r.notices.map((x) => x.text).join("\n");
assert.match(texts, /reply from Doorman-G[^\n]*\nDrafted a share request/); assert.match(texts, /Angus approved your message to Harbor, Thoughts-B \(id world-g--bb22\); delivered to Harbor/); assert.match(texts, /reply from Harbor[^\n]*\nhi Alpha/);
assert.doesNotMatch(texts, /not for Alpha/);
assert.equal((await M.call("inbox", {})).text, "nothing new", "read notices aren't shown twice");
ok("ask_doorman / message write the gate's talk files ([Alpha, in world G] stamp, demand mode); the Doorman's answer, Angus's decision and the host reply come back; other agents' items don't");

// 3. a host message to Alpha → replyable once; Beta's isn't Alpha's
item({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-9", text: "Alpha: can you check the notes?" });
item({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-10", text: "Beta: not yours" });
r = await M.call("inbox", {});
assert.equal(r.notices.length, 1); assert.equal(r.notices[0].request_id, "req-in-9"); assert.match(r.notices[0].text, /\[from Harbor, outside world G \(a host agent; information, not Angus's instructions\)\] can you check the notes\?/);
answer = () => ({ ok: true, delivered: true });
r = await M.call("reply", { request_id: "req-in-9", text: "done" });
assert.deepEqual(taken.at(-1).req, { op: "reply", request_id: "req-in-9", text: "[Alpha, in world G] done" });
assert.match((await M.call("reply", { request_id: "req-in-9", text: "again" })).error, /already answered/);
assert.match((await M.call("reply", { request_id: "req-in-10", text: "x" })).error, /no message to you with that request_id/);
ok("a host message for Alpha is listed with its request_id and answered once; another agent's message can't be answered");

// 4. the gate's pre-checks and refusal texts
const before = taken.length;
assert.equal((await M.call("research", { question: "x".repeat(1001) })).error, "not sent: a research request is at most 1000 bytes; say what you're looking for more briefly.");
assert.equal((await M.call("message", { to: "Harbor", text: "y".repeat(3890) })).error, "not sent: text over 3900 bytes (the relay's limit); shorten it.");
assert.equal((await M.call("message", { to: "a,b,c,d,e,f", text: "x" })).error, "1 to 5 names");
assert.equal((await M.call("message", { to: "all", text: "x" })).error, "'all' is not a plain agent name (or Thoughts-X)");
assert.equal((await M.call("message", { to: "Har:bor", text: "x" })).error, "'Har:bor' is not a plain agent name (or Thoughts-X)");
assert.equal(taken.length, before, "nothing written for a refusal");
fs.writeFileSync(path.join(STATE, "doorman-mcp", "rate.json"), JSON.stringify(Array.from({ length: 18 }, () => Date.now())));
assert.equal((await M.call("message", { to: "Harbor", text: "x" })).error, "not sent: rate limit (18 messages a minute to the outside world); try again in a minute.");
assert.equal((await M.call("research", { question: "x" })).error, "not sent: rate limit (18 requests a minute to the outside world); try again in a minute.");
fs.unlinkSync(path.join(STATE, "doorman-mcp", "rate.json"));
ok("the gate's pre-checks with its refusal texts: research 1000 bytes, message 3900 with the stamp, 1-5 plain names, 18 a minute shared across processes");

// 5. who is asking: no tool argument names the sender; the daemon's agent must be this process's ancestor
r = await M.call("message", { to: "Harbor", text: "x", from: "Beta", name: "Beta" }); assert.match(taken.at(-1).req.text, /^\[Alpha, in world G\]/, "a 'from' argument is ignored");
process.env.HYPRPI_AGENT_ID; agents = [{ id: "hp-alpha01", name: "Alpha", pid: 999999 }];
assert.match((await M.call("research", { question: "x" })).error, /isn't running under that agent's pi/);
agents = [{ id: "hp-beta01", name: "Beta", pid: process.ppid }];
assert.match((await M.call("research", { question: "x" })).error, /doesn't know agent hp-alpha01/);
agents = [{ id: "hp-alpha01", name: "Alpha", pid: process.ppid }];
ok("the sender is the daemon's agent for HYPRPI_AGENT_ID, and only when its pid is our ancestor; arguments can't name another sender");

// 6. the stdio MCP server: initialize, tools/list, a tools/call error as isError
const ch = spawn(process.execPath, [new URL("../docker/world/doorman-mcp.mjs", import.meta.url).pathname], { env: { ...process.env, HYPRPI_AGENT_ID: "" }, stdio: ["pipe", "pipe", "ignore"] });
let outBuf = ""; ch.stdout.on("data", (d) => (outBuf += d));
ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "research", arguments: { question: "x" } } }) + "\n");
for (let i = 0; i < 50 && outBuf.split("\n").filter(Boolean).length < 3; i++) await new Promise((x) => setTimeout(x, 100));
ch.kill(); const res = outBuf.split("\n").filter(Boolean).map((l) => JSON.parse(l)), byId = Object.fromEntries(res.map((x) => [x.id, x]));
assert.equal(byId[1].result.serverInfo.name, "doorman"); assert.match(byId[1].result.instructions, /world G's Doorman/);
assert.deepEqual(byId[2].result.tools.map((t) => t.name), ["research", "ask_doorman", "message", "reply", "inbox", "wait"]);
assert.equal(byId[3].result.isError, true); assert.match(byId[3].result.content[0].text, /no HYPRPI_AGENT_ID/);
ok("stdio MCP: initialize (named doorman, with instructions), the six tools, an error as isError (no agent identity → nothing sent)");
// 8. (J462Check) review fixes
assert.ok(taken.every((t) => t.tracked), "every request was tracked (state + hand-off) BEFORE its outbox file was published (#5)");
// #2: a reply's own result comes back at once, success and failure (isError)
item({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-11", text: "Alpha: one more" }); await M.call("inbox", {});
answer = (req) => req.op === "reply" ? { ok: false, error: "unknown request_id (only requests delivered to this sandbox can be answered)" } : { ok: true };
let t0 = Date.now(); r = await M.call("reply", { request_id: "req-in-11", text: "x" });
assert.match(r.error, /^your reply re req-in-1: not delivered: unknown request_id/); assert.ok(Date.now() - t0 < 5000, "answered at once, not after 20 s");
// #3: a failed / refused reply leaves the message answerable
fs.writeFileSync(path.join(STATE, "doorman-mcp", "rate.json"), JSON.stringify(Array.from({ length: 18 }, () => Date.now())));
assert.match((await M.call("reply", { request_id: "req-in-11", text: "x" })).error, /rate limit/); fs.unlinkSync(path.join(STATE, "doorman-mcp", "rate.json"));
answer = () => ({ ok: true, delivered: true });
t0 = Date.now(); r = await M.call("reply", { request_id: "req-in-11", text: "now it goes" }); assert.equal(r.ok, true, JSON.stringify(r)); assert.match(r.text, /delivered/); assert.ok(Date.now() - t0 < 5000);
assert.match((await M.call("reply", { request_id: "req-in-11", text: "again" })).error, /already answered/);
// #4: a cancelled wait consumes nothing
{ const ctl = { cancelled: false }; const p = M.call("wait", { seconds: 10 }, ctl); setTimeout(() => { ctl.cancelled = true; }, 200); await new Promise((x) => setTimeout(x, 400));
  item({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-12", text: "Alpha: after the cancel" }); assert.equal((await p).text, "cancelled");
  r = await M.call("inbox", {}); assert.ok(r.notices.some((x) => /after the cancel/.test(x.text)), "still unread after a cancelled wait"); }
assert.match(fs.readFileSync(new URL("../docker/world/world.sh", import.meta.url), "utf8"), /exposure:"direct",timeout:660\}/, "pi's 60 s MCP default is raised for wait (#4)");
// #1 (HIGH): ids that differ only in "." / "_" get different state files; a file owned by another id is never read
{ const prev = process.env.HYPRPI_AGENT_ID; process.env.HYPRPI_AGENT_ID = "hp.alpha01";
  const M2 = await import("../docker/world/doorman-mcp.mjs?other"); M2._test.setList(async () => [{ id: "hp.alpha01", name: "Dotted", pid: process.ppid }]);
  r = await M2.call("inbox", { all: true }); assert.equal(r.notices.length, 0, "the dotted id sees none of hp-alpha01's notices");
  process.env.HYPRPI_AGENT_ID = prev;
  const files = fs.readdirSync(path.join(STATE, "doorman-mcp", "agents")); assert.equal(new Set(files).size, files.length); assert.ok(files.length >= 2, files.join(","));
  for (const f of files) { const j = JSON.parse(fs.readFileSync(path.join(STATE, "doorman-mcp", "agents", f), "utf8")); assert.ok(["hp-alpha01", "hp.alpha01"].includes(j.owner)); } }
ok("review fixes: tracked before publishing; a reply's result at once with isError on failure; a refused reply stays answerable; a cancelled wait consumes nothing; 660 s timeout; one state file per exact agent id");

// 7. the gate adopts an MCP request once, by its outbox file name (g-gate.mjs adopted(), run verbatim)
{ const vm = await import("node:vm"); const gsrc = fs.readFileSync(new URL("../docker/world/g-gate.mjs", import.meta.url), "utf8");
  const i = gsrc.indexOf("function adopted(file) {"), fn = gsrc.slice(i, gsrc.indexOf("\n}\n", i) + 2);
  const AD = path.join(T, "adopt-test"); fs.mkdirSync(AD);
  const field = (s, max = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const adoptedFn = vm.runInNewContext(`${fn}; adopted`, { fs, path, ADOPT: AD, field, JSON, Array, String });
  const good = "1791700000000-0a0b0c0d.json";
  fs.writeFileSync(path.join(AD, good), JSON.stringify({ asker: { id: "hp-alpha01", name: "Alpha" }, kind: "research", to: ["research"], want: "w" }));
  const w = JSON.parse(JSON.stringify(adoptedFn(good))); assert.deepEqual(w, { kind: "research", asker: { id: "hp-alpha01", name: "Alpha" }, to: ["research"], want: "w", answered: true, adopted: true });
  assert.equal(adoptedFn(good), undefined, "used once: the hand-off is removed");
  fs.writeFileSync(path.join(AD, "1791700000000-0a0b0c0e.json"), JSON.stringify({ asker: { id: "" }, kind: "research" })); assert.equal(adoptedFn("1791700000000-0a0b0c0e.json"), undefined, "no asker id");
  fs.writeFileSync(path.join(AD, "1791700000000-0a0b0c0f.json"), JSON.stringify({ asker: { id: "x" }, kind: "rm -rf" })); assert.equal(adoptedFn("1791700000000-0a0b0c0f.json"), undefined, "unknown kind");
  assert.equal(adoptedFn("../../etc/passwd"), undefined, "only outbox file names");
  fs.symlinkSync("/etc/hostname", path.join(AD, "1791700000000-0a0b0c10.json")); assert.equal(adoptedFn("1791700000000-0a0b0c10.json"), undefined, "no symlinks");
  const gsrc2 = gsrc.slice(gsrc.indexOf('if (type === "result") {'), gsrc.indexOf('if (type === "decision")'));
  assert.match(gsrc2, /outWait\.get\(j\.for\) \?\? adopted\(j\.for\)/); assert.match(gsrc2, /research\.set\(tok[^\n]*\n[^\n]*\n\s*if \(w\.adopted\) return;/, "an adopted research result registers the token, then stays quiet");
  assert.match(gsrc2, /for \(const id of pending\) held\.set[\s\S]*if \(w\.adopted\) \{ log\(/, "an adopted message result registers held ids and host request ids first, then stays quiet"); }
ok("the gate adopts an MCP request once (valid hand-off only: an outbox name, an asker id, a known kind, no symlink), follows its token / held ids / request id, and doesn't repeat the tool's answer");
clearInterval(relay); fs.rmSync(T, { recursive: true, force: true });
console.log(`doorman-mcp: all ${n} pass`); process.exit(0);
