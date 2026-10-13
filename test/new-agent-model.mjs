#!/usr/bin/env node
// J534 (Angus: "the default model for now should be Opus 5.5, but configurable in hyprpi configs. And if started by Thoughts or an
// agent, then up to them depending on task"): which --model `hyprpi new` gives pi. Isolated: a temp config (hyprpi.jsonc written from the
// defaults), a fake pi that records its arguments, and `script` for the terminal `hyprpi new` runs pi in directly. No window, no daemon.
//   node test/new-agent-model.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
if (spawnSync("sh", ["-c", "command -v script"]).status !== 0) { console.log("SKIP no `script` (util-linux)"); process.exit(0); }
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j534-")), cfg = path.join(T, "cfg", "hyprpi"), argvFile = path.join(T, "argv");
fs.mkdirSync(cfg, { recursive: true });
fs.writeFileSync(path.join(T, "fakepi"), `#!/bin/sh\necho "$@" > ${argvFile}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "config.json"), JSON.stringify({ pi: path.join(T, "fakepi"), piArgs: [] }));
const run = (args, env = {}) => {
  try { fs.unlinkSync(argvFile); } catch { /* */ }
  const e = { ...process.env, XDG_CONFIG_HOME: path.join(T, "cfg"), HYPRPI_SOCKET: path.join(T, "s.sock"), HYPRPI_STATE: path.join(T, "st"), HYPRPI_NO_ENSURE: "1", ...env };
  for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_SPAWNED_BY", "HYPRPI_TWIN_OF", "HYPRPI_ROUTER"]) if (!(k in env)) delete e[k];
  const r = spawnSync("script", ["-qc", ["node", path.join(ROOT, "bin/hyprpi"), "new", ...args].map((x) => `'${x}'`).join(" "), "/dev/null"], { env: e, encoding: "utf8", timeout: 30000 });
  let argv = ""; try { argv = fs.readFileSync(argvFile, "utf8").trim(); } catch { /* pi never ran */ }
  const models = [...argv.matchAll(/--model (\S+)/g)].map((m) => m[1]);
  return { models, last: models.at(-1) || "", out: (r.stdout || "") + (r.stderr || "") };
};
const setKey = (v) => { const f = path.join(cfg, "hyprpi.jsonc"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/"newAgentModel": "[^"]*"/, `"newAgentModel": ${JSON.stringify(v)}`)); };

let r = run([]);
ok("Angus's own open (SUPER+A / hyprpi new): routing.newAgentModel, by default anthropic/claude-opus-5-5", r.last === "anthropic/claude-opus-5-5", JSON.stringify(r.models));
ok("the key is written, documented, into hyprpi.jsonc", /"newAgentModel": "anthropic\/claude-opus-5-5"/.test(fs.readFileSync(path.join(cfg, "hyprpi.jsonc"), "utf8")) && /J534: the model of an agent Angus opens himself/.test(fs.readFileSync(path.join(cfg, "hyprpi.jsonc"), "utf8")));
setKey("anthropic/claude-sonnet-5-5"); r = run([]);
ok("changing the key changes it", r.last === "anthropic/claude-sonnet-5-5", JSON.stringify(r.models));
r = run(["--", "--model", "anthropic/claude-haiku-4-5"]);
ok("an explicit --model wins (only it is passed)", r.models.length === 1 && r.last === "anthropic/claude-haiku-4-5", JSON.stringify(r.models));
r = run(["--", "--model", "anthropic/claude-haiku-4-5"], { HYPRPI_SPAWNED_BY: "hyprpi" });
ok("a spawn by Thoughts or an agent keeps its routed / explicit model", r.models.length === 1 && r.last === "anthropic/claude-haiku-4-5", JSON.stringify(r.models));
r = run([], { HYPRPI_SPAWNED_BY: "hyprpi" });
ok("a spawn without a model (e.g. a fork keeping its parent's) doesn't get the key's model", r.models.length === 0, JSON.stringify(r.models));
r = run([], { HYPRPI_AGENT_ID: "hp-caller" });
ok("an agent's own `hyprpi new` without --model: its choice, unchanged (no key model)", r.models.length === 0, JSON.stringify(r.models));
r = run(["--", "--fork", "/nonexistent.jsonl"]);
ok("a fork keeps its parent's model", r.models.length === 0, JSON.stringify(r.models));
setKey(""); r = run([]);
ok("an empty key: pi's own default", r.models.length === 0, JSON.stringify(r.models));
setKey("someprovider/not-on-the-list"); r = run([]);
ok("a model off the scoped list (J397) is skipped with a warning, not fatal", r.models.length === 0 && /isn't on the scoped model list/.test(r.out), r.out.slice(-200));
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `new-agent-model: ${fails} FAILED` : "new-agent-model: all pass");
process.exit(fails ? 1 : 0);
