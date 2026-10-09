#!/usr/bin/env node
// J328: end-to-end test of the GPU lease on an ISOLATED daemon + relay (own socket, state, config, no notification bus),
// so nothing reaches the owner's screen or the live relay. Needs docker + the CDI spec + the python:3.12-slim image for the
// GPU parts (tiny jobs only: a 256 MiB allocation). Stands in for the Doorman's model by writing its drop-box request itself;
// Angus's approval is the decision file the panel / toast writes.
//   node docker/gpu/e2e-isolated.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, "../..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-e2e-"));
const P = (...a) => path.join(T, ...a);
const env0 = { ...process.env, XDG_CONFIG_HOME: P("config"), XDG_STATE_HOME: P("state"), HYPRPI_SOCKET: P("d.sock"), HYPRPI_STATE: P("dstate"), HYPRPI_NO_ADOPT: "1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" };
const env = env0;
delete env.HYPRPI_AGENT_ID;
// The isolated daemon must NOT reach the live Hyprland session (it manages panels and would open/close real windows; a first
// run of this test did): no instance signature, no Wayland display, and an empty runtime dir so hyprctl finds nothing.
for (const k of ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_ROOM", "HYPRPI_WORLD"]) delete env[k];
env.XDG_RUNTIME_DIR = P("run"); fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };
for (const d of ["config/hyprpi/worlds", "state", "dstate", "ws", "ws/sub", "inbox-w", "dws", "dinbox", "dcard"]) fs.mkdirSync(P(d), { recursive: true });
fs.writeFileSync(P("config/hyprpi/sbx-relay.json"), JSON.stringify({ sandboxes: [
  { name: "world-t", agent_id: "sbx-world-t", workspace: P("ws"), inbox: P("inbox-w"), workspace_num: 69, container: "pi-sbx:test" },
  { name: "doorman-t", doorman_for: "world-t", reports_to: "Thoughts-A", workspace: P("dws"), inbox: P("dinbox"), card: P("dcard"), workspace_num: 61 }] }));
fs.writeFileSync(P("config/hyprpi/worlds/world-t.json"), JSON.stringify({ sandbox: "world-t", gpu: { mode: "developer" } }));
fs.writeFileSync(P("ws/cuda_hello.py"), fs.readFileSync(path.join(HERE, "jobs/cuda_hello.py")));
fs.writeFileSync(P("ws/sub/data.txt"), "input data\n");
fs.symlinkSync("/etc/hostname", P("ws/link.py"));
const kids = [];
const start = (cmd, args) => { const c = spawn(cmd, args, { env, stdio: ["ignore", fs.openSync(P(`${path.basename(args[0])}.log`), "a"), fs.openSync(P(`${path.basename(args[0])}.err.log`), "a")] }); kids.push(c); return c; };
const finish = (code) => { for (const k of kids) try { k.kill(); } catch { /* */ } console.log(`\n${fails ? "FAILED" : "all passed"} (${T})`); process.exit(code); };
start(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"]);
for (let i = 0; i < 50 && !fs.existsSync(P("d.sock")); i++) await sleep(200);
ok(fs.existsSync(P("d.sock")), "isolated daemon is up");
start(process.execPath, [path.join(ROOT, "docker/sbx-relay.mjs"), "run"]);
const STATE = P("state/hyprpi/sbx-relay"), OUT = P("dws/.hyprpi-dropbox/outbox"), DIN = P("dinbox");
for (let i = 0; i < 50 && !fs.existsSync(OUT); i++) await sleep(200);
await sleep(1500);
let n = 0;
const ask = async (req) => { // a Doorman request; returns its result item from the Doorman's inbox
  const name = `r${++n}.json`; fs.writeFileSync(path.join(OUT, ".t"), JSON.stringify(req)); fs.renameSync(path.join(OUT, ".t"), path.join(OUT, name));
  for (let i = 0; i < 60; i++) { await sleep(250); for (const f of fs.readdirSync(DIN).filter((x) => x.endsWith(".json")).sort()) { const j = JSON.parse(fs.readFileSync(path.join(DIN, f), "utf8")); if (j.for === name) return j; } }
  return null;
};
const lease = (o = {}) => ({ op: "gpu_lease", for: "G agent Alpha", job: "tiny CUDA driver-API check: allocate 256 MiB, fill, read back", why: "e2e test of the GPU lease", script: "cuda_hello.py", files: ["sub/data.txt"], runtime: "python", time_s: 30, vram_mib: 1024, ...o });
const pending = () => fs.existsSync(path.join(STATE, "pending")) ? fs.readdirSync(path.join(STATE, "pending")) : [];
const decide = (id, v) => fs.writeFileSync(path.join(STATE, "decisions", `${id}.${v}`), "panel");
const waitInbox = async (pred, ms = 60000) => { for (let t = 0; t < ms; t += 500) { for (const f of fs.readdirSync(P("inbox-w")).filter((x) => x.endsWith(".json")).sort()) { const j = JSON.parse(fs.readFileSync(path.join(P("inbox-w"), f), "utf8")); if (pred(j)) return j; } await sleep(500); } return null; };

// 1. refusals before anything is held
let r = await ask(lease({ time_s: 9999 })); ok(r && !r.ok && /over this host's limit of 300 seconds/.test(r.error), `over-limit time refused: ${r?.error}`);
r = await ask(lease({ vram_mib: 4000 })); ok(r && !r.ok && /MiB of VRAM/.test(r.error), `over-limit VRAM refused: ${r?.error}`);
r = await ask(lease({ script: "link.py", files: [] })); ok(r && !r.ok && /symlink/.test(r.error), `symlinked file refused: ${r?.error}`);
r = await ask(lease({ files: ["../../etc/passwd"] })); ok(r && !r.ok && /bad file path/.test(r.error), `path outside the workspace refused: ${r?.error}`);
r = await ask(lease({ files: ["/etc/passwd"] })); ok(r && !r.ok, `absolute path refused: ${r?.error}`);
ok(pending().length === 0, "nothing was held by the refusals");
// 2. deny
r = await ask(lease()); ok(r?.ok && r.pending?.length === 1, `lease held for Angus: ${JSON.stringify(r?.pending)}`);
const held = JSON.parse(fs.readFileSync(path.join(STATE, "pending", pending()[0]), "utf8"));
ok(/DEVELOPER MODE/.test(held.text) && /not an approved NVIDIA route/.test(held.text) && /no network/.test(held.text) && /cuda_hello.py/.test(held.text) && held.shown[0] === "Thoughts-A", "the held text is labelled developer mode, names limits and the files, goes to Thoughts-A");
decide(held.id, "deny"); await sleep(1500);
ok(pending().length === 0 && !fs.existsSync(held.gpu.dir), "denied: nothing pending and the snapshot is gone");
ok(!!(await waitInbox((j) => j.type === "gpu" && j.status === "denied", 5000)), "the sandbox's inbox says denied");
// 3. approve and run
r = await ask(lease()); const h2 = JSON.parse(fs.readFileSync(path.join(STATE, "pending", pending()[0]), "utf8"));
fs.writeFileSync(P("ws/cuda_hello.py"), "print('CHANGED AFTER REQUEST')\n"); // the sandbox edits its file after the request: what runs is the snapshot
const smi0 = spawnSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { encoding: "utf8" }).stdout.trim();
decide(h2.id, "approve");
const done = await waitInbox((j) => j.type === "gpu" && ["ok", "failed", "timeout", "vram", "refused"].includes(j.status), 90000);
ok(done?.status === "ok", `the job ran: ${JSON.stringify(done)}`);
const smi1 = spawnSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { encoding: "utf8" }).stdout.trim();
console.log(`      GPU memory used: ${smi0} MiB before, ${smi1} MiB after`);
const md = done?.summary && fs.existsSync(done.summary) ? fs.readFileSync(done.summary, "utf8") : "";
ok(/allocated 256 MiB/.test(md) && !/CHANGED AFTER/.test(md), "the snapshot ran (not the edited file); the log is in the summary");
const outs = (done?.files || []).filter((f) => fs.existsSync(f)); ok(outs.some((f) => /cuda_hello\.txt$/.test(f) && /ok 256 MiB/.test(fs.readFileSync(f, "utf8"))), `result file landed in the sandbox's inbox: ${outs.map((f) => path.basename(f))}`);
ok(spawnSync("docker", ["ps", "-a", "--filter", "label=hyprpi.gpu=1", "-q"], { encoding: "utf8" }).stdout.trim() === "", "the worker container is destroyed");
ok(!fs.existsSync(h2.gpu.dir), "the lease folder is removed");
ok(!!(await waitInbox((j) => j.type === "message" && /^G agent Alpha: GPU lease .* finished: ok/.test(j.text), 3000)), "the asking agent is told through the sandbox's message path (gate routes 'Name: text')");
// 3b. isolation probe: no network, no host paths, caps dropped (read the log)
const addJob = (name, from) => fs.writeFileSync(P("ws", name), fs.readFileSync(path.join(HERE, "jobs", from)));
const runLease = async (o, ms = 90000) => { const before = pending(); const r = await ask(lease(o)); const id = (pending().find((x) => !before.includes(x)) || "").replace(/\.json$/, ""); if (!r?.ok || !id) { console.log("      (lease not held:", JSON.stringify(r), ")"); return { r, md: "" }; } const rec = JSON.parse(fs.readFileSync(path.join(STATE, "pending", id + ".json"), "utf8")); await sleep(800); decide(id, "approve"); const res = await waitInbox((j) => j.type === "gpu" && j.lease === rec.gpu.lease && j.status !== "running", ms); const md = res?.summary && fs.existsSync(res.summary) ? fs.readFileSync(res.summary, "utf8") : ""; return { r, res, md }; };
addJob("probe.py", "probe.py");
let x = await runLease({ script: "probe.py", files: [], job: "isolation probe", vram_mib: 128, time_s: 20 });
ok(x.res?.status === "ok" && /network 1\.1\.1\.1:53: BLOCKED/.test(x.md) && /dns: BLOCKED/.test(x.md) && /host dirs with content: \[\]/.test(x.md) && /mounts of interest: none/.test(x.md) && /write rootfs: BLOCKED/.test(x.md) && /CapEff:(\\t|\s)0{16}/.test(x.md) && /NoNewPrivs:(\\t|\s)1/.test(x.md), "worker isolation: no network or DNS, no host dirs or mounts, read-only root, no capabilities");
console.log(x.md.split("## Log")[1]?.trim().split("\n").map((l) => "      " + l).join("\n"));
// 3c. overruns
addJob("over_vram.py", "over_vram.py"); addJob("slow.py", "slow.py");
x = await runLease({ script: "over_vram.py", files: [], job: "VRAM overrun test: allocates 700 MiB against a 256 MiB budget", vram_mib: 256, time_s: 30 });
ok(x.res?.status === "vram" && x.res.ranSeconds < 10, `VRAM overrun killed (status ${x.res?.status}, ran ${x.res?.ranSeconds} s, peak ${x.res?.peakVramMib} MiB of 256)`);
x = await runLease({ script: "slow.py", files: [], job: "time overrun test: sleeps 60 s against a 3 s limit", vram_mib: 128, time_s: 3 });
ok(x.res?.status === "timeout" && x.res.ranSeconds < 8, `time overrun killed (status ${x.res?.status}, ran ${x.res?.ranSeconds} s of 3)`);
ok(spawnSync("docker", ["ps", "-a", "--filter", "label=hyprpi.gpu=1", "-q"], { encoding: "utf8" }).stdout.trim() === "", "no worker containers left");
console.log(`      GPU memory used at the end: ${spawnSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { encoding: "utf8" }).stdout.trim()} MiB (display baseline ${smi0})`);
// 4. gpu: off refuses
fs.writeFileSync(P("config/hyprpi/worlds/world-t.json"), JSON.stringify({ sandbox: "world-t", gpu: "off" }));
r = await ask(lease()); ok(r && !r.ok && /GPU leases are off for world-t/.test(r.error), `gpu: off refuses with a clear message: ${r?.error}`);
fs.writeFileSync(P("config/hyprpi/worlds/world-t.json"), JSON.stringify({ sandbox: "world-t", gpu: "bogus" }));
r = await ask(lease()); ok(r && !r.ok && /GPU leases are off/.test(r.error), `an unknown mode fails closed: ${r?.error}`);
finish(fails ? 1 : 0);
