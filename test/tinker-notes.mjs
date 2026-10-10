#!/usr/bin/env node
// Tinker from the search panel: the "🔧 tinker sent to the workshop" line and the agent's 🔧 result are
// written to the panel world's Thoughts thread AND are drawn (not quiet) by the shared thread rules
// (lib/thoughts-lines.mjs: search panel + phone), read back from the thread file the way a restarted
// panel reads it. Also: a panel's world must be one letter ("AB" is ignored), the room panel gets no
// thread line, and other automatic 🔧 notes stay quiet.
// Isolated daemon only (own socket/state/cfg, fake hyprctl + kitty, bogus Hyprland signature).
//   node test/tinker-notes.mjs     (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../lib/client.mjs";
import { threadKind } from "../lib/thoughts-lines.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, what) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) fails++; };
const visible = (e) => !["hidden", "quiet"].includes(threadKind(e));

// 1. The rules alone.
ok(visible({ role: "note", text: "🔧 tinker sent to the workshop (world D): fix the thing" }), "rule: sent line is visible");
ok(visible({ role: "note", text: "🔧 tinker sent to the workshop (world D), queued: a free agent there picks it up: x" }), "rule: queued sent line is visible");
for (const k of ["done", "plan", "decide", "stuck"]) ok(visible({ role: "note", text: `🔧 🧹 Sweep (workshop D #12): ${k}: result` }), `rule: ${k} result is visible`);
ok(!visible({ role: "note", text: "🔧 drop-off ab12cd34: some text" }), "rule: the routing label stays quiet");
ok(!visible({ role: "note", text: "🔧 something else automatic" }), "rule: other 🔧 notes stay quiet");

// 2. End to end on an isolated daemon.
const T = fs.mkdtempSync(path.join(os.tmpdir(), "tinker-notes-"));
const sig = "bogus-" + path.basename(T);
for (const d of ["state", "run", "bin", "cfg/hyprpi"]) fs.mkdirSync(path.join(T, d), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(T, "bin/hyprctl"), '#!/bin/sh\ncase "$*" in *-j*) case "$*" in *activeworkspace*|*activewindow*) echo "{}";; *) echo "[]";; esac;; *) echo ok;; esac\n', { mode: 0o755 });
fs.writeFileSync(path.join(T, "bin/kitty"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.writeFileSync(path.join(T, "cfg/hyprpi/config.json"), JSON.stringify({ tinkerViaThoughts: false }));
fs.writeFileSync(path.join(T, "state/workshop.json"), JSON.stringify({ workshop: "A" }));
const env = { ...process.env, HYPRPI_SOCKET: path.join(T, "sock"), HYPRPI_STATE: path.join(T, "state"), XDG_CONFIG_HOME: path.join(T, "cfg"),
  XDG_RUNTIME_DIR: path.join(T, "run"), HYPRLAND_INSTANCE_SIGNATURE: sig, HYPRPI_NO_ADOPT: "1", PATH: `${path.join(T, "bin")}:${process.env.PATH}` };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "PI_SESSION_FILE", "PI_SESSION_ID", "WAYLAND_DISPLAY"]) delete env[k];
const daemon = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(T, "d.log"), "w"), "inherit"] });
const thread = (w) => { try { return fs.readFileSync(path.join(T, "state/thoughts", `${w}.thread.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const room = (w) => { try { return fs.readFileSync(path.join(T, "state/rooms", `${w}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
try {
  for (let i = 0; i < 50 && !fs.existsSync(env.HYPRPI_SOCKET); i++) await sleep(100);
  await sleep(300);
  const opts = { path: env.HYPRPI_SOCKET };
  const agent = async (id) => { const c = await connect(opts); await c.call("agent.hello", { agent_id: id, pid: process.pid, session: "", cwd: "/tmp", name: id, acks: false }); return c; };
  const panel = await connect(opts);

  // Search panel in world C, workshop A.
  const a1 = await agent("tst-n1");
  await panel.call("tinker", { text: "NOTE-TEST one", via: "search-tui", panel: "search", world: "C" });
  await sleep(5000);
  await a1.call("room.post", { text: "🔧 done: NOTE-TEST one finished" });
  await sleep(1000);
  const c = thread("C");
  const sent = c.find((e) => /tinker sent to the workshop \(world A\).*NOTE-TEST one/.test(e.text));
  const res = c.find((e) => /\(workshop A #\d+\): done: NOTE-TEST one finished/.test(e.text));
  ok(sent && visible(sent), "search panel: sent line is in thread C and drawn");
  ok(res && visible(res), "search panel: the agent's result is in thread C and drawn");
  ok(room("C").some((m) => /NOTE-TEST one finished/.test(m.text)), "search panel: result relayed to room C");

  // Room panel in world B: room relay, no thread line.
  const a2 = await agent("tst-n2");
  await panel.call("tinker", { text: "NOTE-TEST two", via: "panel", panel: "room", world: "B" });
  await sleep(5000);
  await a2.call("room.post", { text: "🔧 decide: NOTE-TEST two which?" });
  await sleep(1000);
  ok(room("B").some((m) => /NOTE-TEST two which/.test(m.text)), "room panel: result relayed to room B");
  ok(!thread("B").some((e) => /NOTE-TEST two/.test(e.text)), "room panel: no thread line");

  // A bad world ("AB") is ignored: no thread line anywhere for it.
  const a3 = await agent("tst-n3");
  await panel.call("tinker", { text: "NOTE-TEST three", via: "search-tui", panel: "search", world: "AB" });
  await sleep(1000);
  const any3 = fs.readdirSync(path.join(T, "state/thoughts")).filter((f) => f.endsWith(".thread.jsonl"))
    .some((f) => fs.readFileSync(path.join(T, "state/thoughts", f), "utf8").includes("NOTE-TEST three"));
  ok(!any3, 'world "AB" is rejected (no thread line)');
  a3.close?.();
} finally {
  daemon.kill();
  await sleep(300);
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
