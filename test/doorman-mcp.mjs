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
// a host message by name: the notifier resolves the name to ONE live agent and hands it over (J464Check #4); here: Alpha, or nobody
const hostMsg = (o) => { if (/^Alpha:/.test(o.text)) M.deliverNamed({ id: "hp-alpha01", name: "Alpha" }, o); };
let seq = 0; const item = (o) => { const name = `${String(Date.now()).padStart(13, "0")}-${(seq++).toString(16).padStart(8, "0")}.json`; fs.writeFileSync(path.join(INBOX, name), JSON.stringify(o)); return name; };
// the fake relay: takes each outbox file, records it, answers with a result (and lets the test add later items)
const taken = [];
let answer = (req, file) => ({ ok: true });
const relay = setInterval(() => {
  for (const f of fs.readdirSync(path.join(BOX, "outbox")).filter((x) => /^[0-9]+-[0-9a-f]{8}\.json$/.test(x))) {
    const req = JSON.parse(fs.readFileSync(path.join(BOX, "outbox", f), "utf8")); fs.unlinkSync(path.join(BOX, "outbox", f));
    const tracked = fs.readdirSync(path.join(STATE, "doorman-mcp", "agents")).some((x) => JSON.parse(fs.readFileSync(path.join(STATE, "doorman-mcp", "agents", x), "utf8")).files?.[f]);
    taken.push({ f, req, tracked }); item({ type: "result", for: f, op: req.op, ...answer(req, f) });
  }
}, 100);

// 1. research: the gate's exact file, the sender from the daemon, the relay's result as the tool's answer, the hand-off to the gate
answer = (req) => req.op === "research" ? { ok: true, research: "r0a1b2c3d", depth: req.depth, mode: "open", status: "started" } : { ok: true };
let r = await M.call("research", { question: "damp heat results for perovskite modules", deep: true });
assert.equal(r.ok, true, JSON.stringify(r)); assert.match(r.text, /research started \(deep, id r0a1b2c3d\): Angus reviews it before it reaches you \(mode open\)/);
assert.deepEqual(taken.at(-1).req, { op: "research", looking_for: "damp heat results for perovskite modules", depth: "deep", from: "Alpha" });
ok("research writes the relay's {op:research, looking_for, depth, from} file, stamped with the daemon's name; returns the relay's answer");
// later: the research is approved → a notice with the file to read, via wait
setTimeout(() => item({ type: "research", token: "r0a1b2c3d", status: "approved", id: "world-g--aa11", file: "/inbox/research-r0a1b2c3d.md", words: 900 }), 300);
r = await M.call("wait", { seconds: 5 });
assert.equal(r.notices.length, 1); assert.match(r.notices[0].text, /^Angus approved your research request \(your words: "damp heat results for perovskite modules"\)\. Read it at file:\/\/\/inbox\/research-r0a1b2c3d\.md \(Ctrl\+click opens it in the host's Markdown viewer; read-only\)/); assert.equal(r.notices[0].path, "/inbox/research-r0a1b2c3d.md");
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
hostMsg({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-9", text: "Alpha: can you check the notes?" });
hostMsg({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-10", text: "Beta: not yours" });
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
hostMsg({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-11", text: "Alpha: one more" }); await M.call("inbox", {});
answer = (req) => req.op === "reply" ? { ok: false, error: "unknown request_id (only requests delivered to this sandbox can be answered)" } : { ok: true };
let t0 = Date.now(); r = await M.call("reply", { request_id: "req-in-11", text: "x" });
assert.match(r.error, /^your reply re req-in-1: not delivered: unknown request_id/); assert.ok(Date.now() - t0 < 5000, "answered at once, not after 20 s");
// #3: a failed / refused reply leaves the message answerable
fs.writeFileSync(path.join(STATE, "doorman-mcp", "rate.json"), JSON.stringify(Array.from({ length: 18 }, () => Date.now())));
assert.match((await M.call("reply", { request_id: "req-in-11", text: "x" })).error, /rate limit/); fs.unlinkSync(path.join(STATE, "doorman-mcp", "rate.json"));
answer = () => ({ ok: true, delivered: true });
t0 = Date.now(); r = await M.call("reply", { request_id: "req-in-11", text: "now it goes" }); assert.equal(r.ok, true, JSON.stringify(r)); assert.match(r.text, /delivered/); assert.ok(Date.now() - t0 < 5000);
assert.match((await M.call("reply", { request_id: "req-in-11", text: "again" })).error, /already answered/);
// (recheck) two concurrent replies to one message: one is published, the other refused; a stale failure can't reopen it
hostMsg({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-13", text: "Alpha: race" }); await M.call("inbox", {});
{ const n0 = taken.length; const [a1, a2] = await Promise.all([M.call("reply", { request_id: "req-in-13", text: "first" }), M.call("reply", { request_id: "req-in-13", text: "second" })]);
  assert.equal(taken.slice(n0).filter((t) => t.req.request_id === "req-in-13").length, 1, "only one reply published"); assert.ok([a1, a2].filter((x) => x.ok).length === 1 && [a1, a2].some((x) => /already answered/.test(x.error || "")));
  const st = M._test.load("hp-alpha01"); item({ type: "result", for: "1700000000000-deadbeef.json", op: "reply", ok: false, error: "stale" }); st.files["1700000000000-deadbeef.json"] = { kind: "reply", R: "req-in-13", at: Date.now() }; M._test.save(st);
  await M.call("inbox", {}); assert.match((await M.call("reply", { request_id: "req-in-13", text: "third" })).error, /already answered/, "another attempt's failure doesn't reopen a delivered reply"); }
// #4: a cancelled wait consumes nothing
{ const ctl = { cancelled: false }; const p = M.call("wait", { seconds: 10 }, ctl); setTimeout(() => { ctl.cancelled = true; }, 200); await new Promise((x) => setTimeout(x, 400));
  hostMsg({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-12", text: "Alpha: after the cancel" }); assert.equal((await p).text, "cancelled");
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

// 7. (J465) a report path with a space is an encoded file:// URL
item({ type: "research", token: "rspace001", status: "approved", file: "/inbox/a b.md" });
M._test.load; { const st2 = M._test.load("hp-alpha01"); st2.research["rspace001"] = { want: "x", at: Date.now() }; M._test.save(st2); }
r = await M.call("inbox", {}); assert.ok(r.notices.some((x) => /Read it at file:\/\/\/inbox\/a%20b\.md /.test(x.text) && x.path === "/inbox/a b.md"), JSON.stringify(r.notices));
ok("the report is a Ctrl+clickable file:// URL (encoded), the plain path kept in path");
// 9. (J464Check) the review fixes
{ const R = "req-tg-1"; M.withAgent("thoughts:G", (st) => { st.inbound[R] = { from: "Lens", at: Date.now() }; });
  assert.notEqual(M._test.fileOf("thoughts:G"), M._test.fileOf("thoughts-g"));
  assert.match(M.replyOut({ id: "thoughts-g", name: "Beta" }, R, "x").error, /no message to you/, "an agent with id thoughts-g can't answer Thoughts-G's message (#3)"); }
{ hostMsg({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-20", text: "Alpha: two processes" }); await M.call("inbox", {});
  M.withAgent("hp-alpha01", (st) => { st.inbound["req-in-20"].replied = true; st.inbound["req-in-20"].file = "1700000000000-aaaaaaaa.json"; }); // another process reserved it
  assert.match((await M.call("reply", { request_id: "req-in-20", text: "x" })).error, /already answered/, "a reply reserved in the shared state by another process blocks this one (#5)"); }
{ M.setLockWait(100); const lk = M._test.fileOf("hp-zz") + ".lock"; fs.mkdirSync(lk, { recursive: true }); const t1 = Date.now();
  assert.throws(() => M.withAgent("hp-zz", () => 1), /busy \(lock\)/); assert.ok(Date.now() - t1 < 1000, "a short lock wait fails fast (#6)"); fs.rmdirSync(lk); M.setLockWait(5000); }
{ const long = "w".repeat(5000) + " SENTINEL"; M.withAgent("hp-alpha01", (st) => { st.hostReq["req-long"] = { to: ["Harbor"], ref: "req-long", at: Date.now() }; });
  item({ type: "reply", request_id: "req-long", from: "Harbor", text: long }); r = await M.call("inbox", {}); assert.ok(r.notices.some((x) => x.text.includes("SENTINEL")), "long host text is kept (#7)"); }
{ M.withAgent("hp-alpha01", (st) => { st.research["rhash0001"] = { want: "x", at: Date.now() }; }); item({ type: "research", token: "rhash0001", status: "approved", file: "/inbox/a#b?.md" });
  r = await M.call("inbox", {}); assert.ok(r.notices.some((x) => x.text.includes("file:///inbox/a%23b%3F.md ")), JSON.stringify(r.notices)); }
item({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-30", text: "Alpha: straight into the inbox" }); r = await M.call("inbox", {});
assert.ok(!r.notices.some((x) => /straight into the inbox/.test(x.text)), "an agent's own scan never takes a name-addressed message: only the notifier's unique resolution does (#4)");
{ hostMsg({ type: "message", mode: "talk", from: "Harbor", request_id: "req-in-40", text: "Alpha: busy lock" }); await M.call("inbox", {});
  M.setLockWait(40); const rl = path.join(STATE, "doorman-mcp", "rate.lock"); fs.mkdirSync(rl);
  const r1 = M.replyOut({ id: "hp-alpha01", name: "Alpha" }, "req-in-40", "first"); fs.rmdirSync(rl); M.setLockWait(5000);
  assert.equal(r1.retry, true, JSON.stringify(r1)); assert.match(r1.error, /busy/);
  const r2 = M.replyOut({ id: "hp-alpha01", name: "Alpha" }, "req-in-40", "second"); assert.ok(r2.file, "after a busy rate lock the reply is still answerable (recheck #2): " + JSON.stringify(r2)); }
ok("review fixes: thoughts:G can't be an agent; a reply reserved by another process; a short lock wait fails fast; long text kept; # and ? encoded in the file URL; named items only via the notifier");
clearInterval(relay); fs.rmSync(T, { recursive: true, force: true });
console.log(`doorman-mcp: all ${n} pass`); process.exit(0);
