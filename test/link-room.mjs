#!/usr/bin/env node
// J555 W2 (stage 2, room): a remote world's Stream (room) panel running on the LAPTOP (omnistation/panel-link.sh H room) against
// world H's daemon through the world's link (omnistation/rlink.mjs → a stand-in ssh → rlink-remote.mjs → an isolated daemon whose
// state is <tmp>/.hyprpi-h/state). No network, no desktop: the panel runs under `script`, test/lib-screen.mjs reads its screen,
// laptop-act is a stand-in that logs what it was asked, the machine's remote.sh a stand-in that logs its starts.
//  1. it shows world H's room (from the remote daemon), drawn in the LAPTOP's theme colours (world H = the theme's color9 here)
//  2. ⏎ posts to room H there, as Angus
//  3. a screenshot pasted from the laptop's clipboard (Ctrl+V) goes over the link to the machine: the post names its path THERE
//     (a room post and an @Name message); without the J555 fix the post named a laptop file the agents can't read
//  4. Ctrl+click on an agent / an http link / a file:// link in the stream: done on the laptop (laptop-act focus / open / file)
//  5. /board and /projects → laptop-act panel board (the room panel's way to the projects panel; it has no job links of its own)
//  6. Ctrl+N and /new → laptop-act new; /new DIR → agent.startRemote: the machine's remote.sh starts one in DIR
//  7. the link dropped (ssh killed): the panel reconnects by itself, shows what was posted meanwhile, and posts again
//   node test/link-room.mjs   (exit 0 = pass; KEEP=1 keeps the temp folder of a failed run)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn, spawnSync } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { Screen } = await import(path.join(ROOT, "test/lib-screen.mjs"));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await f()) return true; } catch { /* not yet */ } await sleep(step); } return false; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j555r-")), RH = path.join(T, ".hyprpi-h"), S = path.join(RH, "state"), cfg = path.join(T, "cfg"), dsock = path.join(T, "d.sock");
const LH = path.join(T, "lh"), LB = path.join(T, "lbin"), RUN = path.join(T, "run"), RD = path.join(T, "remote"), F = (n) => path.join(T, n), PROJ = path.join(T, "proj");
for (const d of [S, path.join(cfg, "hyprpi"), LH, path.join(LH, "Screenshots"), path.join(LH, ".local/state/omarchy/current/theme"), LB, RUN, RD, PROJ]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
// the machine's remote.sh (agent.startRemote runs `bash REMOTE_DIR/remote.sh start SLUG`): a stand-in that logs
fs.writeFileSync(path.join(RH, "remote.sh"), `#!/bin/bash\necho "ARGS $* CWD=$HYPRPI_START_CWD" >> ${F("starts.log")}\n`, { mode: 0o755 });
const denv = { ...process.env, HYPRPI_SOCKET: dsock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK"]) delete denv[k];
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: denv, stdio: "ignore" });
const SSH = F("fakessh"), PIDS = F("remote.pids");
fs.writeFileSync(SSH, `#!/bin/sh\necho $$ >> ${PIDS}\nexec env HYPRPI_STATE=${S} HYPRPI_SOCKET=${dsock} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [SSH, "host"] }));
// the laptop: its theme (world H's colour is color9 = #a1b2c3), its clipboard holds a PNG, laptop-act is a stand-in that logs
fs.writeFileSync(path.join(LH, ".local/state/omarchy/current/theme/colors.toml"), `foreground = "#e0e0e0"\nbackground = "#101010"\ncolor9 = "#a1b2c3"\ncolor4 = "#0000ff"\n`);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
fs.writeFileSync(F("clip.png"), PNG);
fs.writeFileSync(path.join(LB, "wl-paste"), `#!/bin/sh\ncase "$*" in *list-types*) echo image/png ;; *"--type image/png"*) cat ${F("clip.png")} ;; *) : ;; esac\n`, { mode: 0o755 });
fs.writeFileSync(path.join(LB, "wl-copy"), `#!/bin/sh\ncat > /dev/null\n`, { mode: 0o755 });
fs.writeFileSync(F("act"), `#!/bin/sh\necho "$*" >> ${F("act.log")}\n`, { mode: 0o755 });
const LENV = { ...process.env, HOME: LH, PATH: `${LB}:${process.env.PATH}`, XDG_RUNTIME_DIR: RUN, XDG_STATE_HOME: path.join(LH, ".state"), XDG_CONFIG_HOME: path.join(LH, ".config"), HYPRPI_REMOTE_DIR: RD,
  HYPRPI_TEST: "1", HYPRPI_TEST_LAPTOP_ACT: F("act"), HYPRPI_LINK_LOG: F("link.log"), HYPRPI_LINK_PING_MS: "1000", TERM: "xterm-256color" };
for (const k of ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_AGENT_ID", "HYPRPI_SOCKET", "HYPRPI_STATE", "HYPRPI_REMOTE_PANEL", "KITTY_WINDOW_ID", "HYPRPI_THEME_COLORS", "HYPRPI_WORLD_COLORS", "HYPRPI_ROOM_TUI_STATE"]) delete LENV[k];
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const read = (n) => { try { return fs.readFileSync(F(n), "utf8"); } catch { return ""; } };
const acts = () => read("act.log").split("\n").filter(Boolean);
let panel = null, scr = null, raw = "";
const key = async (k, ms = 300) => { panel.stdin.write(k); await sleep(ms); };
const click = async (at, ctrl) => { const b = ctrl ? 16 : 0; panel.stdin.write(`\x1b[<${b};${at.x};${at.y}M`); await sleep(40); panel.stdin.write(`\x1b[<${b};${at.x};${at.y}m`); await sleep(1000); };
const roomMsgs = async () => { const c = await connect({ path: dsock }); try { return (await c.call("room.read", { room: "H", tail: true, limit: 200 })).messages || []; } finally { c.close(); } };
const human = async (re) => (await roomMsgs()).filter((m) => m.author?.kind === "human" && re.test(m.text || "")).at(-1);
const clipPath = (s) => /(?:~|\/)\S*pi-clipboard-[^\s]+?\.png/.exec(s || "")?.[0] || "";
const prompts = [];
try {
  for (let i = 0; i < 50 && !fs.existsSync(dsock); i++) await sleep(200);
  const al = await connect({ path: dsock, onEvent: (ev, data) => { if (ev === "prompt") prompts.push(data); } });
  await al.call("agent.hello", { agent_id: "h-omni-alpha", pid: process.pid, name: "omni-alpha", want_workspace: 71, cwd: T });
  await al.call("room.post", { room: "H", text: "See https://example.com/streamcheck and file:///srv/notes/remote-plan.md please." });
  scr = new Screen(140, 40);
  panel = spawn("script", ["-qfc", `stty cols 140 rows 40; exec ${path.join(ROOT, "omnistation/panel-link.sh")} H room`, "/dev/null"], { env: LENV, stdio: ["pipe", "pipe", "ignore"] });
  panel.stdout.on("data", (b) => { const s = b.toString(); raw += s; if (raw.length > 4e6) raw = raw.slice(-2e6); scr.feed(s); });
  // 1
  ok("1 the laptop panel shows world H's room (through the link)", await waitFor(() => scr.find("streamcheck") && scr.find("stream H"), 15000), scr.dump().slice(0, 900));
  ok("1 … in the laptop's theme colours (world H = its color9, #a1b2c3)", raw.includes("38;2;161;178;195"), JSON.stringify(raw.slice(-300)));
  // 2
  await key("hello from the laptop stream", 200); await key("\r", 1500);
  ok("2 ⏎ posts to room H on the machine, as Angus", await waitFor(async () => !!(await human(/^hello from the laptop stream$/)), 6000), JSON.stringify((await roomMsgs()).slice(-2)));
  // 3 a pasted screenshot: its laptop path in the box; ⏎ uploads it and the post names its path on the machine
  await key("\x16", 1200);
  ok("3 Ctrl+V puts the laptop screenshot's path in the box", await waitFor(() => scr.find("pi-clipboard-"), 4000), scr.dump().slice(-600));
  await key(" what is this", 200); await key("\r", 2500);
  const m3 = await human(/what is this/), p3 = clipPath(m3?.text);
  ok("3 the room post names the image's path ON THE MACHINE (uploaded over the link, 600, same bytes), not the laptop's", p3.startsWith(path.join(RH, "clipboard")) && fs.existsSync(p3) && (fs.statSync(p3).mode & 0o777) === 0o600 && fs.readFileSync(p3).equals(PNG) && !m3.text.includes(LH) && !m3.text.includes("~/"), JSON.stringify(m3));
  await key("@omni-alpha look ", 200); await key("\x16", 1200); await key("\r", 2500);
  const p4 = clipPath(prompts.at(-1)?.text);
  ok("3 … an @Name message too: omni-alpha gets the path on the machine", /look/.test(prompts.at(-1)?.text || "") && p4.startsWith(path.join(RH, "clipboard")) && fs.existsSync(p4), JSON.stringify(prompts));
  // 4 Ctrl+click
  let at = scr.find("omni-alpha"); if (at) await click({ x: at.x + 1, y: at.y }, true);
  ok("4 Ctrl+click on omni-alpha → laptop-act H focus omni-alpha", acts().includes("H focus omni-alpha"), acts().join(" | "));
  at = scr.find("https://example.com/streamcheck"); if (at) await click({ x: at.x + 3, y: at.y }, true);
  ok("4 Ctrl+click on the link → laptop-act H open URL", acts().includes("H open https://example.com/streamcheck"), acts().join(" | "));
  at = scr.find("file:///srv/notes"); if (at) await click({ x: at.x + 3, y: at.y }, true);
  ok("4 Ctrl+click on a file:// link → laptop-act H file (the machine's file, copied to the laptop)", acts().includes("H file /srv/notes/remote-plan.md"), acts().join(" | "));
  // 5
  await key("/board", 200); await key("\r", 1000);
  ok("5 /board → laptop-act H panel board", acts().filter((l) => l === "H panel board").length === 1, acts().join(" | "));
  await key("/projects", 200); await key("\r", 1000);
  ok("5 /projects → laptop-act H panel board", acts().filter((l) => l === "H panel board").length === 2, acts().join(" | "));
  // 6
  await key("\x0e", 1000);
  ok("6 Ctrl+N → laptop-act H new", acts().filter((l) => l === "H new").length === 1, acts().join(" | "));
  await sleep(2200); await key("/new", 200); await key("\r", 1000);
  ok("6 /new → laptop-act H new", acts().filter((l) => l === "H new").length === 2, acts().join(" | "));
  await sleep(2200); await key(`/new ${PROJ}`, 200); await key("\r", 2500);
  ok("6 /new DIR → the machine's remote.sh starts an agent in DIR (agent.startRemote over the link)", await waitFor(() => new RegExp(`^ARGS start r-[a-z]{3} CWD=${PROJ}$`, "m").test(read("starts.log")), 5000), read("starts.log") + " / " + scr.dump().slice(-300));
  ok("6 nothing was asked of the laptop's own hyprpi (only laptop-act)", acts().every((l) => /^H (focus|open|file|panel|new)\b/.test(l)), acts().join(" | "));
  // 7 the link drops: the panel reconnects by itself, catches up and posts again
  const n = read("remote.pids").split("\n").filter(Boolean);
  try { process.kill(Number(n.at(-1)), "SIGKILL"); } catch { /* gone */ }
  await al.call("room.post", { room: "H", text: "posted while the link was down" });
  ok("7 the link comes back by itself", await waitFor(() => read("remote.pids").split("\n").filter(Boolean).length > n.length, 10000), read("link.log").slice(-300));
  ok("7 … and the panel shows what was posted meanwhile", await waitFor(() => scr.find("posted while the link was down"), 10000), scr.dump().slice(-600));
  await key("after the drop", 200); await key("\r", 2500);
  ok("7 … and posts again", await waitFor(async () => !!(await human(/^after the drop$/)), 8000), scr.dump().slice(-600));
  al.close?.();
} finally {
  if (panel) { try { panel.stdin.write("\x11"); } catch { /* gone */ } await sleep(500); try { panel.kill(); } catch { /* gone */ } }
  // the link this test started (by its runtime dir), and the stand-in ssh ends
  try { spawnSync("sh", ["-c", `for p in $(ls /proc | grep -E '^[0-9]+$'); do tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q "omnistation/rlink.mjs H" && tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=${RUN}" && kill $p; done`]); } catch { /* none */ }
  for (const p of read("remote.pids").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } }
  d.kill(); await sleep(400);
  if (fails && process.env.KEEP) console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `link-room: ${fails} FAILED` : "link-room: all pass"); process.exit(fails ? 1 : 0);
