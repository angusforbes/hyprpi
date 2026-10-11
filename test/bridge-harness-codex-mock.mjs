// node test/bridge-harness-codex-mock.mjs  (J425, J425Recheck #1/#5: codex's enforcement, PROVED offline)
// The real codex binary, with the argv the codex adapter builds, against a localhost mock Responses provider that FORCES one
// exec_command per case (no model call, no network). Each case checks what the OS sandbox did: writes allowed only in the
// job's read-and-write folders; a read-and-write folder that overlaps a read-only one either way is not writable; outside, /tmp and
// a project-local .codex config can't widen it. Skipped (exit 0, "SKIP") when codex isn't installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
if (spawnSync("sh", ["-c", "command -v codex"]).status !== 0) { console.log("SKIP codex not installed"); process.exit(0); }
const { adapterPlan } = await import("../docker/bridge/harness.mjs");
// the folders live under $HOME (codex's sandbox treats /tmp specially); removed at the end
const root = fs.mkdtempSync(path.join(os.homedir(), ".cache", "j425-cxmock-")), chome = path.join(root, "codex-home"); fs.mkdirSync(chome);
let cmd = "";
const srv = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c; let d = {}; try { d = JSON.parse(b); } catch { /* */ }
  if (!req.url.includes("responses")) { res.writeHead(404); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const done = d.input?.some((x) => x.type === "function_call_output");
  const response = { id: "resp_1", object: "response", status: "in_progress", model: "mock", output: [] };
  const item = done ? { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "finished", annotations: [] }] }
    : { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd }) };
  const emit = (type, v) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...v })}\n\n`);
  emit("response.created", { response }); emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: done ? undefined : "" } });
  if (done) { emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }); emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "finished" }); emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "finished" }); }
  else { emit("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments }); emit("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: item.arguments }); }
  emit("response.output_item.done", { output_index: 0, item }); emit("response.completed", { response: { ...response, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const cli = path.join(root, "bridge"); fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
// run codex as the adapter would, with the mock provider, forcing `shell` (a write of `target`); → did the file appear?
async function attempt(job, target) {
  const tmp = fs.mkdtempSync(path.join(root, "run-")), work = path.join(tmp, "work"); fs.mkdirSync(work);
  const p = adapterPlan(job, { tmp, work, cli, mcpEnv: { DOORMAN_BRIDGE_TOKEN: "fake" }, choice: { harness: "codex", command: ["codex"], model: "mock" } });
  cmd = `printf x > '${target}'`;
  const args = [...p.argv.slice(1, -1), "-c", 'model_provider="mock"', "-c", `model_providers.mock={name="Mock",base_url="http://127.0.0.1:${srv.address().port}/v1",wire_api="responses",requires_openai_auth=false}`, "-c", "features.shell_snapshot=false", "-"];
  const ch = spawn("codex", args, { env: { PATH: process.env.PATH, HOME: chome, CODEX_HOME: chome, OPENAI_API_KEY: "fake" }, cwd: p.cwd, stdio: ["pipe", "ignore", "ignore"] });
  ch.stdin.end("do the test"); const t = setTimeout(() => ch.kill("SIGKILL"), 60000); await new Promise((r) => ch.on("close", r)); clearTimeout(t);
  return { written: fs.existsSync(target), argv: p.argv };
}
const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const RW = mk("rw"), OUT = mk("outside"), PARENT = mk("ro-parent"), CHILD = mk("ro-parent", "rw-child"), HOLD = mk("rw-holder"), INNER = mk("rw-holder", "ro-inner");
fs.mkdirSync(path.join(RW, ".codex")); fs.writeFileSync(path.join(RW, ".codex", "config.toml"), `[sandbox_workspace_write]\nwritable_roots=["${root}"]\n`); // a project-local config trying to widen it
const W = (folders, read_only = []) => ({ id: "world-t--cafe01", approved: { action: "x", tools: ["Write", "Bash"], folders, read_only, time_limit_s: 60 }, questions: [] });
const cases = [
  ["inside a read-and-write folder", W([RW]), path.join(RW, "in.txt"), true],
  ["outside every folder", W([RW]), path.join(OUT, "out.txt"), false],
  ["/tmp", W([RW]), path.join(os.tmpdir(), `j425-cxmock-${process.pid}.txt`), false],
  ["the project .codex config can't widen it (the root above)", W([RW]), path.join(root, "widened.txt"), false],
  ["a rw folder INSIDE a read-only one (J425Recheck HIGH)", W([PARENT, CHILD], [PARENT]), path.join(CHILD, "violated.txt"), false],
  ["…and the read-only parent itself", W([PARENT, CHILD], [PARENT]), path.join(PARENT, "violated.txt"), false],
  ["a rw folder HOLDING a read-only one: its read-only part", W([HOLD, INNER], [INNER]), path.join(INNER, "violated.txt"), false],
  ["a read-only folder alone", W([PARENT], [PARENT]), path.join(PARENT, "ro.txt"), false],
];
let n = 0;
for (const [what, job, target, want] of cases) {
  const r = await attempt(job, target);
  assert.equal(r.written, want, `${what}: ${want ? "should be written" : "WRITTEN, not enforced"} (argv ${r.argv.join(" ")})`);
  console.log(`ok ${what}: ${want ? "written" : "blocked"}`); n++; try { fs.unlinkSync(target); } catch { /* */ }
}
srv.close(); fs.rmSync(root, { recursive: true, force: true });
console.log(`bridge-harness-codex-mock: all ${n} pass`); process.exit(0);
