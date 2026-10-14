#!/usr/bin/env node
// J555 W6 (Angus 20a): every world's Projects panel Decisions view (^F) shows ALL worlds' open decisions, the remote worlds' over
// their links (marked 📡), each answerable there. No network, no desktop: isolated daemons (the laptop's, with worlds A, B and a
// sandboxed G; world H's "machine", state <tmp>/.hyprpi-h/state, reached through omnistation/rlink.mjs and a stand-in ssh), the
// panels under `script`, test/lib-screen.mjs reads their screens.
//  1. world A's projects panel, ^F: A's own decision first, then B's (the laptop daemon) and H's (over H's link, marked 📡);
//     G's host board (history: G is sandboxed, its decisions are in its own panels) is not listed
//  2. answering H's decision in A's panel reaches H's daemon (the item becomes a Next item there)
//  3. answering a local one still works: B's (another world on the laptop daemon) and A's own
//  4. the same view in a link panel of H (omnistation/panel-link.sh H board) lists the laptop worlds' decisions too, and answers them
//  5. H's link down: A's view shows one "📡 H offline (link down)" line, never starts a link, and keeps answering keys
//   node test/all-decisions.mjs   (exit 0 = pass; KEEP=1 keeps the temp folder on a failure)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn, spawnSync } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { Screen } = await import(path.join(ROOT, "test/lib-screen.mjs"));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await f()) return true; } catch { /* not yet */ } await sleep(step); } return false; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j555d-")), F = (n) => path.join(T, n);
// the laptop daemon: worlds A and B (room logs), G sandboxed (worlds/world-g.json), H bound to a remote machine
const LS = F("lstate"), LCFG = F("lcfg"), LSOCK = F("l.sock");
// world H's machine
const RH = F(".hyprpi-h"), HS = path.join(RH, "state"), HCFG = F("hcfg"), HSOCK = F("h.sock");
// the laptop's panels
const LH = F("lh"), RUN = F("run"), RD = F("remote");
for (const d of [path.join(LS, "boards"), path.join(LS, "rooms"), path.join(LCFG, "hyprpi", "remote"), path.join(LCFG, "hyprpi", "worlds"), path.join(HS, "boards"), path.join(HCFG, "hyprpi"), path.join(LH, ".config", "hyprpi", "remote"), RUN, RD])
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const now = Date.now();
for (const c of [LCFG, HCFG]) {
  fs.writeFileSync(path.join(c, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
  fs.writeFileSync(path.join(c, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
}
const SSH = F("fakessh"), PIDS = F("remote.pids");
fs.writeFileSync(SSH, `#!/bin/sh\necho $$ >> ${PIDS}\nexec env HYPRPI_STATE=${HS} HYPRPI_SOCKET=${HSOCK} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")}\n`, { mode: 0o755 });
const binding = JSON.stringify({ ssh: [SSH, "host"] });
for (const f of [path.join(RD, "h.json"), path.join(LCFG, "hyprpi", "remote", "h.json"), path.join(LH, ".config", "hyprpi", "remote", "h.json")]) fs.writeFileSync(f, binding);
fs.writeFileSync(path.join(LCFG, "hyprpi", "worlds", "world-g.json"), JSON.stringify({ sandbox: "world-g", world: "G", workspaces: [61, 69] }));
for (const r of ["A", "B", "G"]) fs.writeFileSync(path.join(LS, "rooms", `${r}.jsonl`), "");
const by = { id: "", name: "someone" };
const card = (room, id, name, q, opts, ts) => ({ room, projects: [{ id, name, title: name, icon: "🧭", status: "active", members: [], writer: "", created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 1, N: 0, H: 0 },
  items: [{ h: "D1", sec: "decide", text: q, by, ts, updated: ts, options: opts.map((t, i) => ({ key: "abcdefgh"[i], text: t })), recommend: "a", default: "a" }] }] });
fs.writeFileSync(path.join(LS, "boards", "A.json"), JSON.stringify(card("A", "p-alpha", "alpha", "Paint the alpha shed?", ["alpha red", "alpha blue"], now - 5000)));
fs.writeFileSync(path.join(LS, "boards", "B.json"), JSON.stringify(card("B", "p-beta", "beta", "Move the beta meeting?", ["beta monday", "beta friday"], now - 4000)));
fs.writeFileSync(path.join(LS, "boards", "G.json"), JSON.stringify(card("G", "p-gamma", "gamma", "Old sandboxed gamma history?", ["gamma one", "gamma two"], now - 3000)));
fs.writeFileSync(path.join(HS, "boards", "H.json"), JSON.stringify(card("H", "p-omni", "omni", "Ship the omni thing?", ["omni now", "omni next week"], now - 6000)));

const clean = (e) => { for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK", "HYPRPI_REMOTE_PANEL", "HYPRPI_SANDBOX_WORLD", "KITTY_WINDOW_ID", "HYPRPI_THEME_COLORS", "HYPRPI_WORLD_COLORS"]) delete e[k]; return e; };
const dEnv = (sock, st, cfg) => clean({ ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: st, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1" });
const started = [];
const ld = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: dEnv(LSOCK, LS, LCFG), stdio: "ignore" }); started.push(ld);
const hd = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: dEnv(HSOCK, HS, HCFG), stdio: "ignore" }); started.push(hd);
// the laptop side: panels and the link (the laptop daemon by HYPRPI_SOCKET; link sockets under XDG_RUNTIME_DIR)
const PENV = clean({ ...process.env, HOME: LH, XDG_RUNTIME_DIR: RUN, XDG_STATE_HOME: path.join(LH, ".state"), XDG_CONFIG_HOME: path.join(LH, ".config"), HYPRPI_REMOTE_DIR: RD, HYPRPI_SOCKET: LSOCK,
  HYPRPI_TEST: "1", HYPRPI_TEST_LAPTOP_ACT: "/bin/true", HYPRPI_LINK_LOG: F("link.log"), HYPRPI_LINK_PING_MS: "1000", HYPRPI_DECISIONS_POLL_MS: "1000", TERM: "xterm-256color" });
delete PENV.HYPRPI_STATE;
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const { linkSocket } = await import(path.join(ROOT, "lib/paths.mjs"));
const boardOf = async (sock, room) => { const c = await connect({ path: sock }); try { return await c.call("board.get", { room }); } finally { c.close(); } };
const d1 = async (sock, room) => (await boardOf(sock, room)).projects[0].items.find((x) => x.h === "D1" || x.resolution) || null;
const answered = async (sock, room) => { const b = await boardOf(sock, room); const it = b.projects[0].items[0]; return it && it.sec === "next" ? it : null; };
const linkUp = () => spawnSync(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H", "--status"], { env: PENV, encoding: "utf8" }).stdout || "";
const linkProcs = () => spawnSync("sh", ["-c", `for p in $(ls /proc | grep -E '^[0-9]+$'); do tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q "omnistation/rlink.mjs H" && tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_RUNTIME_DIR=${RUN}" && echo $p; done`], { encoding: "utf8" }).stdout.split("\n").filter((x) => x && !x.includes("--status")).map(Number);
function startPanel(cmd) {
  const scr = new Screen(140, 50), p = spawn("script", ["-qfc", `stty cols 140 rows 50; exec ${cmd}`, "/dev/null"], { env: PENV, stdio: ["pipe", "pipe", "ignore"] });
  p.stdout.on("data", (b) => scr.feed(b.toString()));
  const key = async (k, ms = 300) => { p.stdin.write(k); await sleep(ms); };
  const type = async (s, ms = 300) => { for (const ch of s) p.stdin.write(ch); await sleep(ms); };
  return { p, scr, key, type };
}
const CUR = (scr) => (scr.dump().split("\n").find((l) => l.includes("▸")) || ""); // the current decision's header line
const toTop = async (P) => { for (let i = 0; i < 6; i++) await P.key("\x1b[1;5A", 60); await sleep(200); };
const toward = async (P, word) => { await toTop(P); for (let i = 0; i < 6 && !CUR(P.scr).includes(word); i++) await P.key("\x1b[1;5B", 250); return CUR(P.scr).includes(word); };
let A = null, HP = null, link = null;
try {
  for (let i = 0; i < 50 && !(fs.existsSync(LSOCK) && fs.existsSync(HSOCK)); i++) await sleep(200);
  link = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H"], { env: PENV, stdio: "ignore" }); started.push(link);
  ok("0 setup: world H's link is up", await waitFor(() => linkUp().includes(": up"), 10000), linkUp());

  // 1 world A's panel
  A = startPanel(`${process.execPath} ${path.join(ROOT, "mockups/board-tui.mjs")} A`);
  ok("0 A's projects panel shows its board", await waitFor(() => A.scr.find("@alpha"), 10000), A.scr.dump().slice(0, 800));
  await A.key("\x06", 500);
  ok("1 ^F in A lists A's own decision", await waitFor(() => A.scr.find("Paint the alpha shed?"), 4000), A.scr.dump());
  ok("1 … and world B's (the laptop daemon)", await waitFor(() => A.scr.find("Move the beta meeting?") && A.scr.find("beta friday"), 6000), A.scr.dump());
  ok("1 … and world H's, over its link", await waitFor(() => A.scr.find("Ship the omni thing?") && A.scr.find("omni next week"), 6000), A.scr.dump());
  const lines = A.scr.dump().split("\n");
  const hdr = (w) => lines.find((l) => l.includes(w) && l.includes("waiting:")) || "";
  ok("1 each labelled with its world, H marked 📡", /\bA 🧭 @alpha/.test(hdr("@alpha")) && /\bB 🧭 @beta/.test(hdr("@beta")) && /📡 H 🧭 @omni/.test(hdr("@omni")), [hdr("@alpha"), hdr("@beta"), hdr("@omni")].join(" | "));
  const row = (s) => A.scr.find(s)?.y ?? 99;
  ok("1 this world's first, then the others in letter order", row("@alpha") < row("@beta") && row("@beta") < row("@omni"), lines.join("\n"));
  ok("1 G's host board (history: G is sandboxed) is not listed", !A.scr.find("gamma"), "");

  // 2 answer H's from A
  ok("2 ^↓ reaches H's decision", await toward(A, "@omni"), A.scr.dump());
  await A.type("2"); await A.key("\r", 1200);
  ok("2 \"2⏎\" on H's decision in A's panel reaches H's daemon: D1 is now a Next item there (option b)", await waitFor(async () => /omni next week/.test((await answered(HSOCK, "H"))?.resolution || ""), 6000),
    JSON.stringify(await d1(HSOCK, "H")) + "\n" + A.scr.dump().split("\n").slice(-4).join(" | "));
  ok("2 … the note says so, and H's decision leaves A's list", await waitFor(() => A.scr.find("📡 H: @omni D1") && !A.scr.find("Ship the omni thing?"), 5000), A.scr.dump().split("\n").slice(-6).join(" | "));
  ok("2 nothing of H's was written on the laptop daemon", !fs.existsSync(path.join(LS, "boards", "H.json")), "");

  // 3 local ones still answer: B's (another laptop world), then A's own
  ok("3 ^↑↓ reaches B's decision", await toward(A, "@beta"), A.scr.dump());
  await A.key("\x1b1", 1200); // Alt+1: option a at once
  ok("3 Alt+1 on B's decision answers it on the laptop daemon's board B", await waitFor(async () => /beta monday/.test(JSON.stringify(await answered(LSOCK, "B")) || ""), 6000), JSON.stringify(await d1(LSOCK, "B")));
  ok("3 ^↑↓ reaches A's own decision", await toward(A, "@alpha"), A.scr.dump());
  await A.key("\r", 1200); // ⏎ alone: the recommendation
  ok("3 ⏎ on A's own decision answers it as before (the recommendation, board A)", await waitFor(async () => /alpha red/.test(JSON.stringify(await answered(LSOCK, "A")) || ""), 6000), JSON.stringify(await d1(LSOCK, "A")));

  // 4 the same view in H's link panel lists the laptop's worlds
  { const c = await connect({ path: LSOCK }); await c.call("board.item", { room: "B", action: "add", project: "p-beta", section: "decide", text: "Order more beta chairs?", options: ["beta yes", "beta no"], recommend: "a" }); c.close(); }
  HP = startPanel(`${path.join(ROOT, "omnistation/panel-link.sh")} H board`);
  ok("4 H's link panel shows H's board", await waitFor(() => HP.scr.find("@omni"), 12000), HP.scr.dump().slice(0, 600));
  await HP.key("\x06", 600);
  ok("4 ^F in H's link panel lists world B's open decision from the laptop (B 🧭 @beta)", await waitFor(() => HP.scr.find("Order more beta chairs?") && HP.scr.find("B 🧭 @beta"), 8000), HP.scr.dump());
  ok("4 … and not the answered ones", !HP.scr.find("Move the beta meeting?") && !HP.scr.find("Paint the alpha shed?"), HP.scr.dump());
  await toTop(HP); await HP.key("\x1b2", 1500); // Alt+2 on the only one
  ok("4 Alt+2 there answers it on the laptop daemon's board B", await waitFor(async () => (await boardOf(LSOCK, "B")).projects[0].items.some((x) => x.sec === "next" && /beta no/.test(JSON.stringify(x))), 6000), JSON.stringify((await boardOf(LSOCK, "B")).projects[0].items));
  await HP.key("\x11", 800); try { HP.p.kill(); } catch { /* gone */ } HP = null;

  // 5 H's link down: one offline line in A's view, nothing hangs, no link started
  { const c = await connect({ path: HSOCK }); await c.call("board.item", { room: "H", action: "add", project: "p-omni", section: "decide", text: "Second omni question?", options: ["x", "y"] }); c.close(); }
  ok("5 (H's new decision shows in A's view while the link is up)", await waitFor(() => A.scr.find("Second omni question?"), 6000), A.scr.dump());
  for (const p of linkProcs()) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  await waitFor(() => !linkProcs().length && !fs.existsSync(linkSocket("H", PENV)), 6000);
  ok("5 A's view shows \"📡 H offline (link down)\" instead of H's decisions", await waitFor(() => A.scr.find("📡 H offline (link down)") && !A.scr.find("Second omni question?"), 8000), A.scr.dump());
  { const c = await connect({ path: LSOCK }); await c.call("board.item", { room: "A", action: "add", project: "p-alpha", section: "decide", text: "Alpha after the drop?", options: ["drop one", "drop two"], recommend: "b" }); c.close(); }
  ok("5 … and keeps working: a new local decision shows at once", await waitFor(() => A.scr.find("Alpha after the drop?"), 5000), A.scr.dump());
  await toTop(A); const t5 = Date.now(); await A.key("\r", 200);
  ok("5 … and answers (⏎ takes ★ b, on board A) with H down", await waitFor(async () => /drop two/.test(JSON.stringify((await boardOf(LSOCK, "A")).projects[0].items.filter((x) => x.sec === "next"))), 5000) && Date.now() - t5 < 5500, JSON.stringify((await boardOf(LSOCK, "A")).projects[0].items));
  await sleep(2500);
  ok("5 no link was started from the panel (no rlink, no ssh)", !linkProcs().length && !fs.existsSync(linkSocket("H", PENV)), String(linkProcs()));
} finally {
  for (const P of [A, HP]) if (P) { try { P.p.stdin.write("\x11"); } catch { /* gone */ } }
  await sleep(500);
  for (const P of [A, HP]) if (P) { try { P.p.kill(); } catch { /* gone */ } }
  for (const p of linkProcs()) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  for (const p of (fs.existsSync(PIDS) ? fs.readFileSync(PIDS, "utf8") : "").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } }
  for (const c of started) { try { c.kill(); } catch { /* gone */ } }
  await sleep(400);
  if (fails && process.env.KEEP) console.log("kept " + T); else fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `all-decisions: ${fails} FAILED` : "all-decisions: all pass"); process.exit(fails ? 1 : 0);
