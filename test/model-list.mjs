#!/usr/bin/env node
// J389/J397 proof: a model NOT on the host's scoped model list (pi's enabledModels; Kimi isn't on it, and hyprpi.jsonc has no modelDeny any more) is refused at spawn_agent (orch.spawn), open_agent
// (thoughts.open) and set_model (thoughts.setModel), before any test call, with a suggestion; an allowed
// model still passes the deny check. Isolated daemon (J333 guard), HYPRPI_ORCH_LAUNCH=/bin/true.
//   node test/model-list.mjs   (exit 0 = pass; uses the live ~/.pi/agent/settings.json enabledModels)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../lib/client.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const KIMI = "nvidia/moonshotai/kimi-k3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j389-")), sock = path.join(T, "d.sock"), state = path.join(T, "state");
fs.mkdirSync(state);
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, HYPRPI_TEST: "1", HYPRPI_ORCH_LAUNCH: "/bin/true", HYPRPI_MODELCHECK: "0" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_ALLOW_HYPR;
const logf = path.join(T, "daemon.log"), fd = fs.openSync(logf, "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const refused = async (fn) => { try { await fn(); return ""; } catch (e) { return e.message; } };
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const c = await connect({ path: sock });
  // An agent to switch (set_model) and to be the room's member.
  const ag = await connect({ path: sock });
  await ag.call("agent.hello", { agent_id: "hp-j389probe", pid: process.pid, cwd: T, name: "J389probe" });
  const msgs = {
    "spawn_agent": await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "DenyA", model: KIMI })),
    "spawn_agent :high": await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "DenyB", model: KIMI + ":high" })),
    "open_agent": await refused(() => c.call("thoughts.open", { room: "A", task: "x", model: KIMI })),
    "set_model": await refused(() => c.call("thoughts.setModel", { room: "A", agent: "hp-j389probe", model: KIMI })),
    "openrouter kimi": await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "DenyC", model: "openrouter/~moonshotai/kimi-latest" })),
    "any unlisted model (spawn)": await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "DenyE", model: "openrouter/google/gemini-pro-latest" })),
    "any unlisted model (set_model)": await refused(() => c.call("thoughts.setModel", { room: "A", agent: "hp-j389probe", model: "openrouter/google/gemini-pro-latest" })),
  };
  for (const [k, m] of Object.entries(msgs)) ok(`${k} refused`, /scoped model list/.test(m) && /Use \S+ instead/.test(m), m.slice(0, 200));
  const listed = await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "AllowE", model: "nvidia/openai/gpt-oss-20b" }));
  ok("an explicitly listed nvidia model passes", !listed, listed);
  const policyOnly = (await c.call("models.audit", {})); ok("models.audit: every model hyprpi.jsonc names is on the list", Array.isArray(policyOnly.notOnList) && policyOnly.notOnList.length === 0, JSON.stringify(policyOnly.notOnList));
  const allowed = await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "AllowD", model: "anthropic/claude-haiku-4-5" }));
  ok("allowed model passes", !allowed, allowed);
  ok("no test call made", !/model check: /.test(fs.readFileSync(logf, "utf8")));
  ag.close(); c.close();
} finally { d.kill("SIGTERM"); await sleep(400); try { d.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
