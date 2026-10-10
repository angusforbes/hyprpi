#!/usr/bin/env node
// J381 proof: a spawn that asks for a small budget gets the floor from hyprpi.jsonc budgets.floor /
// floorByKind; no budget = the defaults. Isolated daemon (J333 guard) with HYPRPI_ORCH_LAUNCH=true, so no
// agent starts; the spawn answers with the budget it set.
//   node test/budget-floor.mjs   (exit 0 = pass; reads the live config's budgets)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../lib/client.mjs";
import { loadPolicy } from "../lib/policy.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = loadPolicy().budgets || {}, F = B.floor || {}, FK = B.floorByKind || {};
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j381-")), sock = path.join(T, "d.sock"), state = path.join(T, "state");
fs.mkdirSync(state);
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, HYPRPI_TEST: "1", HYPRPI_ORCH_LAUNCH: "/bin/true" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_ALLOW_HYPR;
const fd = fs.openSync(path.join(T, "daemon.log"), "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
let fails = 0; const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${n}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`); };
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const c = await connect({ path: sock });
  const sp = (extra) => c.call("orch.spawn", { thoughts: "A", prompt: "test", name: "Floor" + Math.random().toString(36).slice(2, 6), ...extra }).then((r) => r.budget);
  eq("small budget -> floor", await sp({ budget: { tokens: 150000, minutes: 25 } }), { tokens: F.tokens, minutes: F.minutes });
  eq("no budget -> defaults", await sp({}), { tokens: B.tokens, minutes: B.minutes });
  eq("hard kind floor", await sp({ complexity: "hard", budget: { tokens: 150000, minutes: 25 } }), { tokens: FK.hard?.tokens ?? F.tokens, minutes: FK.hard?.minutes ?? F.minutes });
  eq("bigger than floor kept", await sp({ budget: { tokens: 5000000, minutes: 600 } }), { tokens: 5000000, minutes: 600 });
  c.close();
} finally { d.kill("SIGTERM"); await sleep(400); try { d.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
