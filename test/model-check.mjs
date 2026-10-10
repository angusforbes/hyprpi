#!/usr/bin/env node
// J383 proof: spawn_agent with an explicit model that can't run is refused with a clear reason and a working
// suggestion; a working one starts, and its check is cached (the second spawn makes no call); a routing-config
// model is known-good (no call). Real one-word calls (cheap). Isolated daemon (J333 guard), with
// HYPRPI_ORCH_LAUNCH=/bin/true so no agent window starts.
//   node test/model-check.mjs [blocked-model] [working-model]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../lib/client.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BAD = process.argv[2] || "openrouter/~google/gemini-pro-latest", GOOD = process.argv[3] || "nvidia/openai/gpt-oss-20b";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j383-")), sock = path.join(T, "d.sock"), state = path.join(T, "state");
fs.mkdirSync(state);
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, HYPRPI_TEST: "1", HYPRPI_ORCH_LAUNCH: "/bin/true" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_ALLOW_HYPR; delete env.HYPRPI_MODELCHECK;
const logf = path.join(T, "daemon.log"), fd = fs.openSync(logf, "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
let fails = 0; const ok = (n, c, extra = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${extra ? ": " + extra : ""}`); };
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const c = await connect({ path: sock });
  const sp = (model) => c.call("orch.spawn", { thoughts: "A", prompt: "test", name: "Mc" + Math.random().toString(36).slice(2, 6), model }, { timeoutMs: 150000 });
  // W1: blocked model refused, with a suggestion.
  let err = ""; try { await sp(BAD); } catch (e) { err = e.message; }
  ok("blocked model refused", /can't run here/.test(err) && /wasn.t used/.test(err), err.slice(0, 260));
  ok("refusal suggests a model", /Use \S+\/\S+ instead/.test(err));
  // W2: working model starts; second time cached.
  let t0 = Date.now(); const r1 = await sp(GOOD).catch((e) => ({ error: e.message })); const first = Date.now() - t0;
  ok("working model starts", r1 && !r1.error && r1.model === GOOD, `${r1.model || r1.error} in ${first} ms`);
  t0 = Date.now(); const r2 = await sp(GOOD).catch((e) => ({ error: e.message })); const second = Date.now() - t0;
  ok("second spawn cached (fast)", r2 && !r2.error && second < 2000, `${second} ms`);
  const checks = (fs.readFileSync(logf, "utf8").match(/model check: /g) || []).length;
  ok("one real call per model", checks === 2, `${checks} calls logged`);
  const cache = JSON.parse(fs.readFileSync(path.join(state, "model-checks.json"), "utf8"));
  ok("cache file", cache[GOOD]?.ok === true && cache[BAD]?.ok === false);
  // Routing-config model: known-good, no call.
  const r3 = await sp("anthropic/claude-haiku-4-5").catch((e) => ({ error: e.message }));
  ok("ladder model needs no call", !r3.error && (fs.readFileSync(logf, "utf8").match(/model check: /g) || []).length === 2);
  c.close();
  const { isDefinite } = await import("../lib/modelcheck.mjs");
  ok("429 / timeout are transient", !isDefinite("429: rate limit") && !isDefinite("no answer within 90 s") && !isDefinite("ECONNRESET"));
  ok("guardrail / not found are definite", isDefinite('404: {"message":"0 endpoints … guardrail') && isDefinite('Error: Model "x/y" not found.'));
} finally { d.kill("SIGTERM"); await sleep(400); try { d.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
