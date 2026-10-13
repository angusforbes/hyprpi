#!/usr/bin/env node
// J553 (J543 follow-up 8): on a remote world's machine the daemon's "MODEL LIST: … NOT on the host's scoped list" audit counted
// routing models the box uses under its own names (lib/routing.mjs localModel) as unlisted. An isolated daemon whose state is
// <tmp>/.hyprpi-h/state (a remote machine), a private pi settings dir (enabledModels = the box's nv-inference names) and a stand-in
// `pi --list-models`: models.audit names only what really can't run there; the same daemon off a remote machine names them all.
//   node test/remote-model-audit.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
async function run(remote) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "j553-audit-")), S = remote ? path.join(T, ".hyprpi-h", "state") : path.join(T, "state");
  const cfg = path.join(T, "cfg"), PD = path.join(T, "pi"), sock = path.join(T, "d.sock");
  fs.mkdirSync(S, { recursive: true }); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(PD);
  fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, thoughtsModel: "nv-inference/azure/anthropic/claude-opus-5-5" }));
  fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } },
    routing: { default: "ordinary", ladder: ["anthropic/claude-haiku-4-5:low", "anthropic/claude-sonnet-5-5:medium"], kinds: { simple: 0, ordinary: 1, review: "openai-codex/gpt-6.1-sol:high", odd: "acme/not-there-1" } } }));
  fs.writeFileSync(path.join(PD, "settings.json"), JSON.stringify({ enabledModels: ["nv-inference/azure/anthropic/claude-opus-5-5", "nv-inference/azure/anthropic/claude-sonnet-5-5", "nv-inference/azure/anthropic/claude-haiku-5-5", "nv-inference/openai/openai/gpt-6.1-sol"] }));
  const LP = path.join(T, "listpi");
  fs.writeFileSync(LP, "#!/bin/sh\nprintf 'provider model\\nnv-inference azure/anthropic/claude-opus-5-5\\nnv-inference azure/anthropic/claude-sonnet-5-5\\nnv-inference azure/anthropic/claude-haiku-5-5\\nnv-inference openai/openai/gpt-6.1-sol\\nanthropic claude-haiku-4-5\\nanthropic claude-sonnet-5-5\\nopenai-codex gpt-6.1-sol\\nacme not-there-1\\n'\n", { mode: 0o755 });
  const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, PI_CODING_AGENT_DIR: PD, HYPRPI_PI: LP, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1", HYPRPI_MODELCHECK: "0" };
  for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_SANDBOX_WORLD"]) delete env[k];
  const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", "ignore", "ignore"] });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
    const c = await connect({ path: sock, onEvent: () => {} });
    const a = await c.call("models.audit", {}); c.close?.();
    return (a.notOnList || []).map((b) => b.model);
  } finally { d.kill(); await sleep(300); fs.rmSync(T, { recursive: true, force: true }); }
}
const rem = await run(true), lap = await run(false);
ok("on a remote machine only the model the box can't run is named (acme/not-there-1)", JSON.stringify(rem) === JSON.stringify(["acme/not-there-1"]), JSON.stringify(rem));
ok("off a remote machine (the laptop) every unlisted one is still named", ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol", "acme/not-there-1"].every((m) => lap.includes(m)), JSON.stringify(lap));
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
