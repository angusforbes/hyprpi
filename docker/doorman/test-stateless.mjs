#!/usr/bin/env node
// J373 test: the Doorman is stateless. Runs the REAL pi (RPC mode) with the REAL drop-box extension (HYPRPI_DOORMAN=1) under
// docker/doorman/doorman-rpc.mjs, against a local fake OpenAI-compatible model that records every request and answers each
// question with hyprpi_reply. A stand-in relay writes inbox items (through docker/doorman/history.mjs, as the relay does) and
// answers the extension's outbox requests. Isolated: its own HOME and folders; no network, no sandbox, nothing on screen.
//   node docker/doorman/test-stateless.mjs [N]      (N = messages in the long run, default 6)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStore, forDoorman, HIST_EXCHANGES } from "./history.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2]) || 6;
const T = fs.mkdtempSync(path.join(os.tmpdir(), "doorman-stateless-"));
const HOMEDIR = path.join(T, "home"), BOX = path.join(T, "box"), INBOX = path.join(T, "inbox"), OUTBOX = path.join(BOX, "outbox");
for (const d of [HOMEDIR, OUTBOX, INBOX, path.join(HOMEDIR, ".pi", "agent")]) fs.mkdirSync(d, { recursive: true });
let fails = 0; const ok = (c, what) => { console.log(`${c ? "PASS" : "FAIL"}  ${what}`); if (!c) fails++; };

// --- the fake model: OpenAI chat completions, streamed. It answers a question with one hyprpi_reply tool call, then "ok".
const requests = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const j = JSON.parse(body || "{}"); requests.push(j); if (process.env.DUMP) fs.appendFileSync(process.env.DUMP, JSON.stringify(j) + "\n");
    const msgs = j.messages || [], last = msgs[msgs.length - 1];
    const text = (m) => typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((x) => x.text || "").join("") : "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const rid = (/· id ([^,\s]+),/.exec(text(last)) || [])[1];
    if (last?.role !== "tool" && rid) {
      const secret = (/SECRET-[A-Z0-9]+/.exec(text(last)) || [])[0] || "none";
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: "hyprpi_reply", arguments: JSON.stringify({ request_id: rid, text: `answer about ${secret}` }) } }] });
      chunk({}, "tool_calls");
    } else { chunk({ role: "assistant", content: "ok" }); chunk({}, "stop"); }
    res.write("data: [DONE]\n\n"); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
fs.writeFileSync(path.join(T, "fake.ts"), `export default function (pi: any) {
  pi.registerProvider("fake", { baseUrl: "http://127.0.0.1:${PORT}/v1", apiKey: "x", api: "openai-completions",
    models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
}\n`);
fs.writeFileSync(path.join(T, "prompt.md"), "You are a test Doorman.");

// --- the stand-in relay: inbox items through history.mjs (as sbx-relay.mjs inboxWrite does), outbox requests answered
const store = openStore(path.join(T, "doorman-history.json"));
let seq = 0;
const inboxWrite = (obj) => { obj = forDoorman(store, "doorman-t", obj); const name = `${String(Date.now() * 10 + (++seq % 10)).padStart(13, "0")}-${(seq).toString(16).padStart(8, "0")}.json`; fs.writeFileSync(path.join(INBOX, name), JSON.stringify({ v: 1, ...obj })); };
const replies = [];
const relayTick = setInterval(() => {
  for (const n of fs.readdirSync(OUTBOX).filter((x) => x.endsWith(".json") && !x.startsWith("."))) {
    let req; try { req = JSON.parse(fs.readFileSync(path.join(OUTBOX, n), "utf8")); } catch { continue; } fs.unlinkSync(path.join(OUTBOX, n));
    if (req.op === "reply") { replies.push(req); store.answered("doorman-t", req.request_id, req.text); }
    if (req.op === "task_change" && req.about) store.link("doorman-t", "doorman-t--abc123", req.about);
    if (req.op !== "status") inboxWrite({ type: "result", for: n, op: req.op, ok: true, ...(req.op === "task_change" ? { pending: ["doorman-t--abc123"] } : {}) });
  }
}, 100);

// --- pi under the controller
const PI = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const PIRUN = [PI, "--mode", "rpc", "--no-extensions", "-e", path.join(HERE, "..", "sbx-dropbox-ext.ts"), "-e", path.join(T, "fake.ts"), "--model", "fake/m", "--no-skills", "--no-context-files", "--no-prompt-templates", "--tools", "read,hyprpi_reply,hyprpi_talk,hyprpi_draft_request,hyprpi_gpu_lease,hyprpi_task_change", "--system-prompt", "You are a test Doorman."].map(q).join(" ");
const env = { ...process.env, HOME: HOMEDIR, HYPRPI_DROPBOX: BOX, HYPRPI_INBOX: INBOX, HYPRPI_DOORMAN: "1", DOORMAN_PIRUN: PIRUN, PI_OFFLINE: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_SOCKET", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY"]) delete env[k];
const ctl = spawn(process.execPath, [path.join(HERE, "doorman-rpc.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
const events = []; let buf = "";
ctl.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { events.push(JSON.parse(l)); } catch { /* */ } } });
let errs = ""; ctl.stderr.on("data", (d) => (errs += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } console.log(`(timed out waiting for ${what})`); return false; };
const sessions = () => { const d = path.join(HOMEDIR, ".pi", "agent", "sessions"); if (!fs.existsSync(d)) return []; return fs.readdirSync(d).flatMap((s) => fs.readdirSync(path.join(d, s)).map((f) => path.join(d, s, f))); };
const ask = (from, label, rid, text) => inboxWrite({ type: "message", mode: "demand", from, request_id: rid, text: label ? `[${label}, in world G] ${text}` : text });
const userText = (r) => (r.messages || []).filter((m) => m.role !== "assistant" && m.role !== "tool" && m.role !== "system").map((m) => typeof m.content === "string" ? m.content : (m.content || []).map((x) => x.text || "").join("")).join("\n");
const questionCalls = () => requests.filter((r) => (r.messages || []).at(-1)?.role !== "tool");

try {
  await sleep(3000); // pi starting
  // the Doorman's rules (its system prompt) reach the model on EVERY fresh session's first call (pi 1.0 drops it for a custom-message turn)
  const sysEvery = () => questionCalls().every((r) => (r.messages || [])[0]?.role === "system" && /test Doorman/.test(JSON.stringify(r.messages[0])));
  // W1: A from Alpha, then B from Beta: B's model call holds nothing of A
  ask("world-g", "Alpha", "rid-a", "Is pypi.org allowed? SECRET-ALPHA1");
  await waitFor(() => replies.some((r) => r.request_id === "rid-a"), 30000, "answer to A");
  ask("world-g", "Beta", "rid-b", "Can I write /work/lib? SECRET-BETA1");
  await waitFor(() => replies.some((r) => r.request_id === "rid-b"), 30000, "answer to B");
  const qa = questionCalls();
  ok(replies.some((r) => r.request_id === "rid-a") && replies.some((r) => r.request_id === "rid-b"), "both questions answered through hyprpi_reply (the tool works in fresh sessions)");
  const callB = qa.find((r) => userText(r).includes("SECRET-BETA1"));
  ok(!!callB && !JSON.stringify(callB.messages).includes("SECRET-ALPHA1") && !JSON.stringify(callB.messages).includes("rid-a"), "message B (Beta) carries nothing of message A (Alpha): not the text, not its id, not its answer");
  // W2: Alpha's second message carries Alpha's own earlier exchange, Beta's does not
  ask("world-g", "Alpha", "rid-a2", "And files.pythonhosted.org? SECRET-ALPHA2");
  await waitFor(() => replies.some((r) => r.request_id === "rid-a2"), 30000, "answer to A2");
  const callA2 = questionCalls().find((r) => userText(r).includes("SECRET-ALPHA2"));
  ok(!!callA2 && userText(callA2).includes("SECRET-ALPHA1") && userText(callA2).includes("answer about SECRET-ALPHA1"), "Alpha's next message brings Alpha's own earlier question and answer (relay-supplied)");
  ok(!!callA2 && !JSON.stringify(callA2.messages).includes("SECRET-BETA1"), "… and nothing of Beta's");
  // W1: a long run; every question call has the same shape (system + one message), and one session file per message
  for (let i = 0; i < N; i++) { ask("world-g", i % 2 ? "Alpha" : "Gamma", `rid-n${i}`, `question ${i} SECRET-N${i}`); await waitFor(() => replies.some((r) => r.request_id === `rid-n${i}`), 30000, `answer n${i}`); }
  const calls = questionCalls(), sizes = calls.map((r) => (r.messages || []).length);
  ok(calls.length >= N + 3 && sizes.every((s) => s === 2), `after ${N + 3} messages every model call still holds only the system prompt and ONE message (messages per call: ${sizes.join(",")})`);
  const bounded = calls.filter((r) => /earlier between you and this same asker/.test(userText(r))).every((r) => (userText(r).match(/they asked:/g) || []).length <= HIST_EXCHANGES);
  ok(sysEvery(), "every question call starts with the Doorman's system prompt (its rules), also in a fresh session");
  ok(bounded, `relay-supplied history never holds more than ${HIST_EXCHANGES} earlier exchanges`);
  await sleep(1500);
  const files = sessions().filter((f) => fs.statSync(f).size > 0);
  const perFile = files.map((f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => /"role":"user"/.test(l) && /via the drop-box/.test(l)).length).filter((c) => c > 0);
  ok(perFile.length >= N + 3 && perFile.every((c) => c === 1), `one session file per message, each holding exactly one incoming message (${perFile.length} files: ${perFile.join(",")})`);
  // W3: a receipt for a task change drafted while answering Alpha comes back with Alpha's next message, not Beta's
  store.asked("doorman-t", "rid-tc", "world-g", "[Alpha, in world G] please change the task"); store.link("doorman-t", "doorman-t--tc1", "rid-tc");
  inboxWrite({ type: "task_change", status: "applied", id: "doorman-t--tc1", outcome: "the task of world-t is now: SECRET-TASK" });
  ask("world-g", "Beta", "rid-b3", "anything new? SECRET-BETA3");
  await waitFor(() => replies.some((r) => r.request_id === "rid-b3"), 30000, "answer to B3");
  ask("world-g", "Alpha", "rid-a3", "anything new? SECRET-ALPHA3");
  await waitFor(() => replies.some((r) => r.request_id === "rid-a3"), 30000, "answer to A3");
  const cB3 = questionCalls().find((r) => userText(r).includes("SECRET-BETA3")), cA3 = questionCalls().find((r) => userText(r).includes("SECRET-ALPHA3"));
  ok(!!cB3 && !userText(cB3).includes("SECRET-TASK") && !!cA3 && userText(cA3).includes("SECRET-TASK"), "a task-change receipt reaches only the asker it was drafted for, with that asker's next message (no turn of its own)");
  ok(!requests.some((r) => userText(r).includes("[hyprpi] Angus")), "no receipt was delivered to the Doorman as a message of its own");
} finally {
  clearInterval(relayTick); try { ctl.kill("SIGTERM"); } catch { /* */ } server.close();
  if (fails && errs) console.log("stderr:", errs.slice(-1500));
  if (!process.env.KEEP) fs.rmSync(T, { recursive: true, force: true }); else console.log("kept", T);
}
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
