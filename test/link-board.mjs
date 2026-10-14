#!/usr/bin/env node
// J555 (board): a remote world's projects (board) panel running on the LAPTOP (omnistation/panel-link.sh H board) against world H's
// daemon through the world's link (omnistation/rlink.mjs → a stand-in ssh → rlink-remote.mjs → an isolated daemon whose state is
// <tmp>/.hyprpi-h/state). No network, no desktop: the panel runs under `script`, test/lib-screen.mjs reads its screen.
//  1. it shows world H's board: its projects, items and a Decide item (from the remote daemon)
//  2. Ctrl+click on an @agent and on a link in a card: done on the laptop (laptop-act H focus / open)
//  3. a job reference (J7) jumps to its item (board.open over the link)
//  4. the panel's own commands reach the remote board: /todo adds, /done edits, "D1 b" answers the decision
//  5. a pasted image (the laptop's clipboard) goes over the link: the card's text names its path on the machine, not the laptop's
//  6. the theme colours are the laptop's (its omarchy colors.toml), not the machine's
//  7. the link dropped (ssh killed): the panel reconnects by itself and its commands reach the board again
//  8. the panel's restart-on-new-code watches lib/tui/laptop.mjs too (the link panel's own module)
//   node test/link-board.mjs   (exit 0 = pass; KEEP=1 keeps the temp folder on a failure)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { Screen } = await import(path.join(ROOT, "test/lib-screen.mjs"));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await f()) return true; } catch { /* not yet */ } await sleep(step); } return false; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j555b-")), RH = path.join(T, ".hyprpi-h"), S = path.join(RH, "state"), cfg = path.join(T, "cfg"), dsock = path.join(T, "d.sock");
const LH = path.join(T, "lh"), LB = path.join(T, "lbin"), RUN = path.join(T, "run"), RD = path.join(T, "remote"), F = (n) => path.join(T, n);
const THEME = path.join(LH, ".local/state/omarchy/current/theme");
for (const d of [path.join(S, "boards"), path.join(cfg, "hyprpi"), LH, path.join(LH, "Screenshots"), LB, RUN, RD, THEME, path.join(RH, "theme")]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const now = Date.now();
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
// world H's board on the machine: @omni (a Decide item, an item with an @agent and a link, job J7's item) and @second (a J7 reference)
const by = { id: "", name: "Thoughts-H" };
const it = (h, sec, text, x = {}) => ({ h, sec, text, by, ts: now, updated: now, ...x });
const proj = (id, name, title, items, seq) => ({ id, name, title, icon: "🛰", status: "active", members: ["h-omni-alpha"], writer: "h-omni-alpha", created: now, updated: now, by: "x", where: null, next_step: null, seq, items });
fs.writeFileSync(path.join(S, "boards", "H.json"), JSON.stringify({ room: "H", projects: [
  proj("p-omni", "omni", "the omni world project", [
    it("D1", "decide", "Ship the omni thing?", { options: [{ key: "a", text: "now" }, { key: "b", text: "next week" }], recommend: "a", default: "a" }),
    it("N1", "next", "ask @omni-alpha about https://example.com/boardlink"),
    it("N2", "next", "⟦J7 v1 · running⟧ build the widget (omni-alpha)"),
  ], { D: 1, N: 2, H: 0 }),
  proj("p-second", "second", "another card", [it("N1", "next", "blocked on J7 for now")], { D: 0, N: 1, H: 0 }),
] }));
fs.writeFileSync(path.join(S, "briefs.json"), JSON.stringify({ next: 8, briefs: { J7: { id: "J7", version: 1, state: "running", created: now, updated: now, project: "p-omni", projectName: "omni", item: "N2", agent: "h-omni-alpha", agent_name: "omni-alpha", from: "Thoughts-H", room: "H", fields: { goal: "build the widget" }, history: [] } } }));
const denv = { ...process.env, HYPRPI_SOCKET: dsock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK"]) delete denv[k];
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: denv, stdio: "ignore" });
const SSH = F("fakessh"), PIDS = F("remote.pids");
fs.writeFileSync(SSH, `#!/bin/sh\necho $$ >> ${PIDS}\nexec env HYPRPI_STATE=${S} HYPRPI_SOCKET=${dsock} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [SSH, "host"] }));
// the laptop's theme (world H = the 8th colour, color9) and the machine's own copy of a theme (J532), which must NOT be used
const LAPTOP_C9 = "a1b2c3", MACHINE_C9 = "0f1e2d", rgbOf = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";");
fs.writeFileSync(path.join(THEME, "colors.toml"), `foreground = "#dddddd"\nbackground = "#111111"\ncolor9 = "#${LAPTOP_C9}"\n`);
fs.writeFileSync(path.join(RH, "theme", "colors.toml"), `foreground = "#dddddd"\nbackground = "#111111"\ncolor9 = "#${MACHINE_C9}"\n`);
// the laptop: its clipboard holds a PNG; laptop-act is a stand-in that records what it was asked
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
fs.writeFileSync(F("clip.png"), PNG);
fs.writeFileSync(path.join(LB, "wl-paste"), `#!/bin/sh\ncase "$*" in *list-types*) echo image/png ;; *"--type image/png"*) cat ${F("clip.png")} ;; *) : ;; esac\n`, { mode: 0o755 });
fs.writeFileSync(path.join(LB, "wl-copy"), `#!/bin/sh\ncat > /dev/null\n`, { mode: 0o755 });
fs.writeFileSync(F("act"), `#!/bin/sh\necho "$*" >> ${F("act.log")}\n`, { mode: 0o755 });
const LENV = { ...process.env, HOME: LH, PATH: `${LB}:${process.env.PATH}`, XDG_RUNTIME_DIR: RUN, XDG_STATE_HOME: path.join(LH, ".state"), XDG_CONFIG_HOME: path.join(LH, ".config"), HYPRPI_REMOTE_DIR: RD,
  HYPRPI_TEST: "1", HYPRPI_TEST_LAPTOP_ACT: F("act"), HYPRPI_LINK_LOG: F("link.log"), HYPRPI_LINK_PING_MS: "1000", TERM: "xterm-256color" };
for (const k of ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_AGENT_ID", "HYPRPI_SOCKET", "HYPRPI_STATE", "HYPRPI_REMOTE_PANEL", "KITTY_WINDOW_ID", "HYPRPI_THEME_COLORS", "HYPRPI_WORLD_COLORS"]) delete LENV[k];
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const read = (n) => { try { return fs.readFileSync(F(n), "utf8"); } catch { return ""; } };
let panel = null, scr = null, raw = "";
const key = async (k, ms = 300) => { panel.stdin.write(k); await sleep(ms); };
const type = async (s, ms = 300) => { for (const ch of s) panel.stdin.write(ch); await sleep(ms); };
const click = async (at, ctrl) => { const b = ctrl ? 16 : 0; panel.stdin.write(`\x1b[<${b};${at.x};${at.y}M`); await sleep(40); panel.stdin.write(`\x1b[<${b};${at.x};${at.y}m`); await sleep(1200); };
const board = async () => { const c = await connect({ path: dsock }); try { return await c.call("board.get", { room: "H" }); } finally { c.close(); } };
const items = async (pid) => ((await board()).projects.find((p) => p.id === pid)?.items || []);
try {
  for (let i = 0; i < 50 && !fs.existsSync(dsock); i++) await sleep(200);
  const al = await connect({ path: dsock }); await al.call("agent.hello", { agent_id: "h-omni-alpha", pid: process.pid, name: "omni-alpha", want_workspace: 71, cwd: T });
  scr = new Screen(120, 40);
  panel = spawn("script", ["-qfc", `stty cols 120 rows 40; exec ${path.join(ROOT, "omnistation/panel-link.sh")} H board`, "/dev/null"], { env: LENV, stdio: ["pipe", "pipe", "ignore"] });
  panel.stdout.on("data", (b) => { const s = b.toString(); raw += s; scr.feed(s); });
  // 1
  ok("1 the laptop panel shows world H's board (through the link): both cards", await waitFor(() => scr.find("@omni") && scr.find("@second"), 15000), scr.dump().slice(0, 1200));
  ok("1 … their items, and the Decide item with its options", await waitFor(() => scr.find("build the widget") && scr.find("blocked on J7") && scr.find("Ship the omni thing?") && scr.find("next week"), 4000), scr.dump());
  await key("\x06", 800); // ^F: the Decisions view
  ok("1 ^F: the Decisions view lists H's open decision (D1 and its options)", await waitFor(() => scr.find("decisions @omni D1") && scr.find("Ship the omni thing?") && scr.find("next week"), 4000), scr.dump().slice(-900));
  await key("\x06", 800); // back to the cards
  // 2 Ctrl+click: an agent, a link
  let at = scr.find("@omni-alpha about"); if (at) await click({ x: at.x + 2, y: at.y }, true);
  ok("2 Ctrl+click on @omni-alpha → laptop-act H focus omni-alpha (on the laptop)", read("act.log").split("\n").includes("H focus omni-alpha"), read("act.log") + "\n" + scr.dump().slice(-400));
  at = scr.find("https://example.com/boardlink"); if (at) await click({ x: at.x + 3, y: at.y }, true);
  ok("2 Ctrl+click on the link → laptop-act H open URL", read("act.log").split("\n").includes("H open https://example.com/boardlink"), read("act.log"));
  // 3 a job reference on @second's card → J7's item on @omni (board.open over the link)
  at = scr.find("J7 for now"); if (at) await click({ x: at.x, y: at.y }, true);
  ok("3 Ctrl+click on J7 opens @omni's card at N2 (board.open through the link)", await waitFor(() => scr.find("projects @omni ·") && scr.find("(again: N2"), 4000), scr.dump().slice(-600));
  await key("\x1b", 400); await key("\x1b", 400); // back to all projects
  // 4 the panel's own commands
  await type("/todo @omni buy milk on H"); await key("\r", 1500);
  ok("4 /todo @omni … adds a Next item on the machine's board", await waitFor(async () => (await items("p-omni")).some((x) => x.sec === "next" && x.text === "buy milk on H")), JSON.stringify(await items("p-omni")));
  await type("/done @omni N1 checked over the link"); await key("\r", 1500);
  ok("4 /done @omni N1 … edits it there (done, verified)", await waitFor(async () => (await items("p-omni")).some((x) => x.h === "N1" && x.sec === "done")), JSON.stringify(await items("p-omni")));
  await type("@omni D1 b"); await key("\r", 1500);
  ok("4 \"@omni D1 b\" answers the decision there", await waitFor(async () => { const x = (await items("p-omni")).find((y) => y.h === "D1"); return x && x.sec !== "decide"; }), JSON.stringify((await items("p-omni")).find((y) => y.h === "D1")) + " " + scr.dump().split("\n").slice(-4).join(" | "));
  // 5 a pasted image: Ctrl+V puts the laptop file's path in the box; ⏎ uploads it and the card names its path on the machine
  await type("/note @omni see "); await key("\x16", 1200);
  ok("5 Ctrl+V puts the laptop screenshot's path in the box", await waitFor(() => scr.find("pi-clipboard-"), 4000), scr.dump().split("\n").slice(-4).join(" | "));
  await key("\r", 2500);
  const h5 = (await items("p-omni")).find((x) => x.sec === "heard" && /^see /.test(x.text || ""));
  const rp = (/(\/\S+pi-clipboard-\S+\.png)/.exec(h5?.text || "") || [])[1] || "";
  ok("5 the image went over the link: the card's text names a file on the machine (600, the same bytes), not the laptop's path", rp.startsWith(path.join(RH, "clipboard")) && fs.existsSync(rp) && (fs.statSync(rp).mode & 0o777) === 0o600 && fs.readFileSync(rp).equals(PNG) && !h5.text.includes("~/Screenshots") && !h5.text.includes(LH), JSON.stringify(h5));
  // 6 theme
  ok("6 the theme colours are the laptop's (world H drawn in the laptop's color9, never the machine's)", raw.includes(`38;2;${rgbOf(LAPTOP_C9)}m`) && !raw.includes(rgbOf(MACHINE_C9)), "");
  // 7 the link drops: the panel reconnects by itself and works again
  const n = read("remote.pids").split("\n").filter(Boolean);
  try { process.kill(Number(n.at(-1)), "SIGKILL"); } catch { /* gone */ }
  ok("7 the link comes back by itself", await waitFor(() => read("remote.pids").split("\n").filter(Boolean).length > n.length, 10000), read("link.log").slice(-300));
  await waitFor(() => !scr.find("daemon offline"), 8000); await sleep(1500);
  await type("/todo @omni after the drop"); await key("\r", 2000);
  ok("7 … and the panel's commands reach the board again", await waitFor(async () => (await items("p-omni")).some((x) => x.text === "after the drop"), 8000), scr.dump().split("\n").slice(-4).join(" | "));
  // 8 laptop.mjs is in the panel's restart watch list
  // (J597: the watch list is the panel's import graph, lib/tui/code-watch.mjs)
  const { codeFilesOf } = await import("../lib/tui/code-watch.mjs");
  ok("8 board-tui restarts onto a new lib/tui/laptop.mjs too", /const CODE = codeFilesOf\(/.test(fs.readFileSync(path.join(ROOT, "mockups/board-tui.mjs"), "utf8")) && codeFilesOf(path.join(ROOT, "mockups/board-tui.mjs")).includes(path.join(ROOT, "lib/tui/laptop.mjs")), "");
  al.close?.();
} finally {
  if (panel) { try { panel.stdin.write("\x11"); } catch { /* gone */ } await sleep(500); try { panel.kill(); } catch { /* gone */ } }
  // the link this test started (the rlink.mjs whose runtime dir is this test's): ended by pid
  try { (await import("node:child_process")).spawnSync("sh", ["-c", `for p in $(ls /proc | grep -E '^[0-9]+$'); do tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q "omnistation/rlink.mjs H" && tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=${RUN}" && kill $p; done`]); } catch { /* none */ }
  for (const p of read("remote.pids").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } }
  d.kill(); await sleep(400);
  if (fails && process.env.KEEP) console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `link-board: ${fails} FAILED` : "link-board: all pass"); process.exit(fails ? 1 : 0);
