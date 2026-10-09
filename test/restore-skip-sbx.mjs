#!/usr/bin/env node
// Restore all skips the sandbox relay pseudo-agents (sbx-*, model "sandboxed"): they come back with their
// relay, so restorePlan must neither restore them nor list them as "couldn't be restored". An isolated
// daemon (J333 guard) over a seeded agents.json, asked for restore.status.
//   node test/restore-skip-sbx.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../lib/client.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "restore-sbx-")), state = path.join(T, "state"), sock = path.join(T, "d.sock");
fs.mkdirSync(state);
const sess = path.join(T, "s.jsonl"); fs.writeFileSync(sess, "");
fs.writeFileSync(path.join(state, "agents.json"), JSON.stringify({
  "sbx-world-g": { id: "sbx-world-g", name: "world-g", open: true, model: "sandboxed", workspace: 61 },
  "sbx-doorman-g": { id: "sbx-doorman-g", name: "Doorman-G", open: true, workspace: 68 },
  "hp-relaylike": { id: "hp-relaylike", name: "RelayLike", open: true, model: "sandboxed", workspace: 62 },
  "hp-gone": { id: "hp-gone", name: "Gone", open: true, session: path.join(T, "missing.jsonl"), workspace: 3 },
  "hp-ok": { id: "hp-ok", name: "Ok", open: true, session: sess, workspace: 4, cwd: T },
}));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, HYPRPI_TEST: "1" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_ALLOW_HYPR;
const fd = fs.openSync(path.join(T, "daemon.log"), "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
let ok = false;
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const c = await connect({ path: sock });
  const plan = await c.call("restore.status", { scope: "all" });
  c.close();
  const restored = plan.agents.map((a) => a.id).sort(), missing = plan.missing.map((m) => m.id).sort();
  console.log("restorable:", restored.join(", ") || "-", "| couldn't be restored:", missing.join(", ") || "-");
  ok = restored.join() === "hp-ok" && missing.join() === "hp-gone";
} finally { d.kill("SIGTERM"); await sleep(400); try { d.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(T, { recursive: true, force: true }); }
console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1);
