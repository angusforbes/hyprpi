#!/usr/bin/env node
// J347 proof: an isolated daemon remaps saved agents' missing ~/Work/<project> cwds to ~/Harness/<project>,
// logs "cwd remapped" and persists it; existing and unmappable cwds stay as they are. Plus remapCwd() unit
// checks (config map, prefix boundaries). The J333 guard keeps the daemon off the desktop.
//   node test/cwd-remap.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remapCwd } from "../lib/paths.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const H = os.homedir(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const eq = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${got}${ok ? "" : ` (want ${want})`}`); };

// Unit checks.
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j347-"));
fs.mkdirSync(path.join(T, "Harness/proj/sub"), { recursive: true }); fs.mkdirSync(path.join(T, "New/x"), { recursive: true });
eq("moved project", remapCwd(path.join(T, "Work/proj"), {}, T), path.join(T, "Harness/proj"));
eq("moved subfolder", remapCwd(path.join(T, "Work/proj/sub"), {}, T), path.join(T, "Harness/proj/sub"));
eq("not moved stays", remapCwd(path.join(T, "Work/gone"), {}, T), path.join(T, "Work/gone"));
eq("prefix boundary", remapCwd(path.join(T, "Workshop/proj"), {}, T), path.join(T, "Workshop/proj"));
eq("existing stays", remapCwd(T, {}, T), T);
eq("config map (~)", remapCwd(path.join(T, "Old/x"), { "~/Old": "~/New" }, T), path.join(T, "New/x"));
eq("empty", remapCwd("", {}, T), "");

// Isolated daemon over a seeded agents.json.
const state = path.join(T, "state"), sock = path.join(T, "d.sock"); fs.mkdirSync(state);
const reg = {
  "hp-j347a": { id: "hp-j347a", cwd: path.join(H, "Work/hyprpi"), name: "A", open: false },
  "hp-j347b": { id: "hp-j347b", cwd: path.join(H, "Work/pi-docker/browser-test"), name: "B", open: false },
  "hp-j347c": { id: "hp-j347c", cwd: "/nonexistent/j347", name: "C", open: false },
  "hp-j347d": { id: "hp-j347d", cwd: path.join(H, "Work"), name: "D", open: false },
};
fs.writeFileSync(path.join(state, "agents.json"), JSON.stringify(reg));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, HYPRPI_TEST: "1" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_ALLOW_HYPR;
const logf = path.join(T, "daemon.log"), fd = fs.openSync(logf, "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  await sleep(800);
  const log = fs.readFileSync(logf, "utf8"), saved = JSON.parse(fs.readFileSync(path.join(state, "agents.json"), "utf8"));
  eq("logged", /cwd remapped for 2 saved agent/.test(log), true);
  eq("A persisted", saved["hp-j347a"].cwd, path.join(H, "Harness/hyprpi"));
  eq("B persisted", saved["hp-j347b"].cwd, path.join(H, "Harness/pi-docker/browser-test"));
  eq("C unchanged", saved["hp-j347c"].cwd, "/nonexistent/j347");
  eq("D unchanged", saved["hp-j347d"].cwd, path.join(H, "Work"));
  eq("guard on", /hypr actions disabled/.test(log), true);
} finally { d.kill("SIGTERM"); await sleep(400); try { d.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
