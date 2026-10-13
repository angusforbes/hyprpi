#!/usr/bin/env node
// J555 W2 (stage 1): a remote world's Thoughts panel running on the LAPTOP (omnistation/panel-link.sh H search) against world H's
// daemon through the world's link (omnistation/rlink.mjs → a stand-in ssh → rlink-remote.mjs → an isolated daemon whose state is
// <tmp>/.hyprpi-h/state). No network, no desktop: the panel runs under `script`, a small terminal model reads its screen.
//  1. it shows world H's Thoughts thread (from the remote daemon)
//  2. typing shows at once: keystroke-to-screen time measured (it's local now; the old pty panel paid a network round trip)
//  3. ⏎ sends to Thoughts-H there
//  4. an image pasted from the laptop's clipboard goes over the link to the machine and Thoughts-H gets it (its path there)
//  5. Ctrl+click on an agent and on a link in the thread: done on the laptop (laptop-act focus / open), nothing on the machine
//  6. the link dropped (ssh killed): the panel reconnects by itself and sends again
//   node test/link-thoughts.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { Screen } = await import(path.join(ROOT, "test/lib-screen.mjs"));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await f()) return true; } catch { /* not yet */ } await sleep(step); } return false; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j555t-")), RH = path.join(T, ".hyprpi-h"), S = path.join(RH, "state"), cfg = path.join(T, "cfg"), dsock = path.join(T, "d.sock");
const LH = path.join(T, "lh"), LB = path.join(T, "lbin"), RUN = path.join(T, "run"), RD = path.join(T, "remote"), F = (n) => path.join(T, n);
for (const d of [path.join(S, "thoughts"), path.join(cfg, "hyprpi"), LH, path.join(LH, "Screenshots"), LB, RUN, RD]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const now = Date.now();
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
fs.writeFileSync(path.join(S, "thoughts", "H.thread.jsonl"), JSON.stringify({ ts: now, role: "thoughts", text: "See https://example.com/linkcheck and ask @omni-alpha today." }) + "\n");
const denv = { ...process.env, HYPRPI_SOCKET: dsock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK"]) delete denv[k];
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: denv, stdio: "ignore" });
const SSH = F("fakessh"), PIDS = F("remote.pids");
fs.writeFileSync(SSH, `#!/bin/sh\necho $$ >> ${PIDS}\nexec env HYPRPI_STATE=${S} HYPRPI_SOCKET=${dsock} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [SSH, "host"] }));
// the laptop: its clipboard holds a PNG; laptop-act is a stand-in that records what it was asked
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
fs.writeFileSync(F("clip.png"), PNG);
fs.writeFileSync(path.join(LB, "wl-paste"), `#!/bin/sh\ncase "$*" in *list-types*) echo image/png ;; *"--type image/png"*) cat ${F("clip.png")} ;; *) : ;; esac\n`, { mode: 0o755 });
fs.writeFileSync(F("act"), `#!/bin/sh\necho "$*" >> ${F("act.log")}\n`, { mode: 0o755 });
const LENV = { ...process.env, HOME: LH, PATH: `${LB}:${process.env.PATH}`, XDG_RUNTIME_DIR: RUN, XDG_STATE_HOME: path.join(LH, ".state"), XDG_CONFIG_HOME: path.join(LH, ".config"), HYPRPI_REMOTE_DIR: RD,
  HYPRPI_TEST: "1", HYPRPI_TEST_LAPTOP_ACT: F("act"), HYPRPI_LINK_LOG: F("link.log"), HYPRPI_LINK_PING_MS: "1000", TERM: "xterm-256color" };
for (const k of ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_AGENT_ID", "HYPRPI_SOCKET", "HYPRPI_STATE", "HYPRPI_REMOTE_PANEL", "KITTY_WINDOW_ID"]) delete LENV[k];
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const read = (n) => { try { return fs.readFileSync(F(n), "utf8"); } catch { return ""; } };
let panel = null, scr = null;
const key = async (k, ms = 300) => { panel.stdin.write(k); await sleep(ms); };
const click = async (at, ctrl) => { const b = ctrl ? 16 : 0; panel.stdin.write(`\x1b[<${b};${at.x};${at.y}M`); await sleep(40); panel.stdin.write(`\x1b[<${b};${at.x};${at.y}m`); await sleep(1200); };
const thread = async () => { const c = await connect({ path: dsock }); try { return (await c.call("thoughts.get", { room: "H" })).entries || []; } finally { c.close(); } };
const linkPid = () => { try { const p = Number(fs.readFileSync(path.join(RUN, "hyprpi", "link-h.pid"), "utf8")); return p; } catch { return 0; } };
try {
  for (let i = 0; i < 50 && !fs.existsSync(dsock); i++) await sleep(200);
  const al = await connect({ path: dsock }); await al.call("agent.hello", { agent_id: "h-omni-alpha", pid: process.pid, name: "omni-alpha", want_workspace: 71, cwd: T });
  scr = new Screen(120, 34);
  panel = spawn("script", ["-qfc", `stty cols 120 rows 34; exec ${path.join(ROOT, "omnistation/panel-link.sh")} H search`, "/dev/null"], { env: LENV, stdio: ["pipe", "pipe", "ignore"] });
  panel.stdout.on("data", (b) => scr.feed(b.toString()));
  // 1
  ok("1 the laptop panel shows world H's Thoughts thread (through the link)", await waitFor(() => scr.find("linkcheck"), 15000), scr.dump().slice(0, 600));
  // 2 keystroke-to-screen, 10 keys
  const times = [];
  for (const ch of "qwertzuiop") { const t0 = process.hrtime.bigint(); panel.stdin.write(ch); const seen = await waitFor(() => scr.find("qwertzuiop".slice(0, times.length + 1)), 2000, 1); times.push(Number(process.hrtime.bigint() - t0) / 1e6); if (!seen) break; }
  const med = times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)];
  console.log(`     keystroke→screen: median ${med.toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms (${times.length} keys)`);
  ok("2 typing shows at once (median under 60 ms here; no network round trip)", times.length === 10 && med < 60, JSON.stringify(times));
  // 3
  await key("\x7f".repeat(10), 300); await key("hello over the link", 200); await key("\r", 1500);
  ok("3 ⏎ sends to Thoughts-H on the machine", await waitFor(async () => (await thread()).some((e) => e.role === "you" && e.text === "hello over the link"), 6000), JSON.stringify((await thread()).slice(-2)));
  // 4 paste an image (Ctrl+V): its laptop path goes in the box; ⏎ uploads it and Thoughts-H gets the path THERE
  await key("\x16", 1200);
  ok("4 Ctrl+V puts the laptop screenshot's path in the box", await waitFor(() => scr.find("pi-clipboard-"), 4000), scr.dump().slice(-800));
  await key(" what is this", 200); await key("\r", 2500);
  const e4 = (await thread()).find((e) => e.role === "you" && /what is this/.test(e.text || ""));
  const rp = (e4?.images || [])[0] || "";
  ok("4 the image went over the link: Thoughts-H got a path on the machine, the file is there (600) and the text names it", rp.startsWith(path.join(RH, "clipboard")) && fs.existsSync(rp) && (fs.statSync(rp).mode & 0o777) === 0o600 && fs.readFileSync(rp).equals(PNG) && e4.text.includes(rp) && !e4.text.includes(LH), JSON.stringify(e4));
  // 5 Ctrl+click: an agent, a link
  let at = scr.find("omni-alpha"); if (at) await click({ x: at.x + 1, y: at.y }, true);
  ok("5 Ctrl+click on @omni-alpha → laptop-act H focus omni-alpha (on the laptop)", read("act.log").split("\n").includes("H focus omni-alpha"), read("act.log"));
  at = scr.find("https://example.com/linkcheck"); if (at) await click({ x: at.x + 3, y: at.y }, true);
  ok("5 Ctrl+click on the link → laptop-act H open URL", read("act.log").split("\n").includes("H open https://example.com/linkcheck"), read("act.log"));
  // 6 the link drops: the panel reconnects by itself and works again
  const n = read("remote.pids").split("\n").filter(Boolean);
  try { process.kill(Number(n.at(-1)), "SIGKILL"); } catch { /* gone */ }
  ok("6 the link comes back by itself", await waitFor(() => read("remote.pids").split("\n").filter(Boolean).length > n.length, 10000), read("link.log").slice(-300));
  await sleep(2500);
  await key("after the drop", 200); await key("\r", 2500);
  ok("6 … and the panel sends again", await waitFor(async () => (await thread()).some((e) => e.role === "you" && e.text === "after the drop"), 8000), scr.dump().slice(-600));
  al.close?.();
} finally {
  if (panel) { try { panel.stdin.write("\x11"); } catch { /* gone */ } await sleep(500); try { panel.kill(); } catch { /* gone */ } }
  // the link this test started (its socket's owner): end it by its own idle rule's signal path
  try { const c = (await import("node:child_process")).spawnSync("sh", ["-c", `for p in $(ls /proc | grep -E '^[0-9]+$'); do tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q "omnistation/rlink.mjs H" && tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=${RUN}" && kill $p; done`]); } catch { /* none */ }
  for (const p of read("remote.pids").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } }
  d.kill(); await sleep(400);
  if (fails && process.env.KEEP) console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `link-thoughts: ${fails} FAILED` : "link-thoughts: all pass"); process.exit(fails ? 1 : 0);
