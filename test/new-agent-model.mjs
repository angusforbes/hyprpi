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
// (J553) pi's model registry, for the scoped-list check: a stand-in `pi --list-models` (the real pi runs through mise, which refuses
// to start with this test's private XDG_STATE_HOME: "config files … are not trusted", so every listed model looked unlisted)
fs.writeFileSync(path.join(T, "listpi"), `#!/bin/sh\nprintf 'provider model context\\nanthropic claude-opus-5-5 1M\\nanthropic claude-sonnet-5-5 1M\\nanthropic claude-haiku-4-5 200K\\n'\n`, { mode: 0o755 });
const run = (args, env = {}) => {
  try { fs.unlinkSync(argvFile); } catch { /* */ }
  // (J534Check) every path isolated: config, socket, state, runtime and state homes; any daemon `hyprpi new` starts is reaped below
  const e = { ...process.env, XDG_CONFIG_HOME: path.join(T, "cfg"), XDG_RUNTIME_DIR: path.join(T, "run"), XDG_STATE_HOME: path.join(T, "xstate"), HYPRPI_SOCKET: path.join(T, "s.sock"), HYPRPI_STATE: path.join(T, "st"), HYPRLAND_INSTANCE_SIGNATURE: "j534-none", HYPRPI_PI: path.join(T, "listpi"), ...env };
  for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_FROM_DAEMON", "HYPRPI_TWIN_OF", "HYPRPI_ROUTER"]) if (!(k in env)) delete e[k];
  fs.mkdirSync(e.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const r = spawnSync("script", ["-qec", ["node", path.join(ROOT, "bin/hyprpi"), "new", ...args].map((x) => `'${x}'`).join(" "), "/dev/null"], { env: e, encoding: "utf8", timeout: 30000 });
  let argv = "", ran = false; try { argv = fs.readFileSync(argvFile, "utf8").trim(); ran = true; } catch { /* pi never ran */ }
  const models = [...argv.matchAll(/--model (\S+)/g)].map((m) => m[1]);
  return { ran, models, last: models.at(-1) || "", out: (r.stdout || "") + (r.stderr || "") };
};
const setKey = (v) => { const f = path.join(cfg, "hyprpi.jsonc"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/"newAgentModel": "[^"]*"/, `"newAgentModel": ${JSON.stringify(v)}`)); };

let r = run([]);
ok("Angus's own open (SUPER+A / hyprpi new): routing.newAgentModel, by default anthropic/claude-opus-5-5", r.last === "anthropic/claude-opus-5-5", JSON.stringify(r.models));
ok("the key is written, documented, into hyprpi.jsonc", /"newAgentModel": "anthropic\/claude-opus-5-5"/.test(fs.readFileSync(path.join(cfg, "hyprpi.jsonc"), "utf8")) && /J534: the model of an agent Angus opens himself/.test(fs.readFileSync(path.join(cfg, "hyprpi.jsonc"), "utf8")));
setKey("anthropic/claude-sonnet-5-5"); r = run([]);
ok("changing the key changes it", r.last === "anthropic/claude-sonnet-5-5", JSON.stringify(r.models));
r = run(["--", "--model", "anthropic/claude-haiku-4-5"]);
ok("an explicit --model wins (only it is passed)", r.models.length === 1 && r.last === "anthropic/claude-haiku-4-5", JSON.stringify(r.models));
r = run(["--", "--model", "anthropic/claude-haiku-4-5"], { HYPRPI_FROM_DAEMON: "1" });
ok("a spawn by Thoughts or an agent keeps its routed / explicit model", r.models.length === 1 && r.last === "anthropic/claude-haiku-4-5", JSON.stringify(r.models));
r = run([], { HYPRPI_FROM_DAEMON: "1" });
ok("a spawn without a model (e.g. a fork keeping its parent's) doesn't get the key's model", r.ran && r.models.length === 0, JSON.stringify(r));
r = run([], { HYPRPI_AGENT_ID: "hp-caller" });
ok("an agent's own `hyprpi new` without --model: its choice, unchanged (no key model)", r.ran && r.models.length === 0, JSON.stringify(r));
r = run(["--", "--fork", "/nonexistent.jsonl"]);
ok("a fork keeps its parent's model", r.ran && r.models.length === 0, JSON.stringify(r));
setKey(""); r = run([]);
ok("an empty key: pi's own default", r.ran && r.models.length === 0, JSON.stringify(r));
setKey("someprovider/not-on-the-list"); r = run([]);
ok("a model off the scoped list (J397) is skipped with a warning, not fatal", r.models.length === 0 && /isn't on the scoped model list/.test(r.out), r.out.slice(-200));
// J543: on a remote world's machine (state ~/.hyprpi-<x>/state) the key's model is the box's own name for it (the hub: only
// nv-inference in its models.json, no enabledModels), so a fresh start there never comes up on a model it can't reach
{ const PD = path.join(T, "pidir"); fs.mkdirSync(PD, { recursive: true }); fs.writeFileSync(path.join(PD, "settings.json"), "{}");
  fs.writeFileSync(path.join(PD, "models.json"), JSON.stringify({ providers: { "nv-inference": { models: [{ id: "azure/anthropic/claude-opus-5-5" }, { id: "azure/anthropic/claude-sonnet-5-5" }] } } }));
  setKey("anthropic/claude-opus-5-5"); fs.mkdirSync(path.join(T, ".hyprpi-i", "state"), { recursive: true });
  r = run([], { HYPRPI_STATE: path.join(T, ".hyprpi-i", "state"), PI_CODING_AGENT_DIR: PD });
  ok("J543 on a remote machine the key's model is the box's own (nv-inference/azure/anthropic/claude-opus-5-5)", r.last === "nv-inference/azure/anthropic/claude-opus-5-5", JSON.stringify(r.models) + r.out.slice(-200));
  r = run([], { PI_CODING_AGENT_DIR: PD });
  ok("J543 … and on the laptop it stays as configured", r.last === "anthropic/claude-opus-5-5", JSON.stringify(r.models)); }
// (J534Check) the config's "--" splits pi's options: a --model after it is prompt text, so the key's model still goes in
fs.writeFileSync(path.join(cfg, "config.json"), JSON.stringify({ pi: path.join(T, "fakepi"), piArgs: ["--"] })); setKey("anthropic/claude-opus-5-5");
r = run(["--", "--model", "x"]); { const a = fs.existsSync(argvFile) ? "" : ""; }
ok("options are read from the whole argv up to its first --: the key's model goes in, the caller's --model x after the config's -- is prompt text", r.ran && r.models[0] === "anthropic/claude-opus-5-5" && r.models.includes("x"), JSON.stringify(r));
// reap any daemon a `hyprpi new` started in this test (found by our temp paths in its environment)
for (const pid of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) { try { if (fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes(T)) process.kill(Number(pid), "SIGTERM"); } catch { /* gone or not ours */ } }
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `new-agent-model: ${fails} FAILED` : "new-agent-model: all pass");
process.exit(fails ? 1 : 0);
