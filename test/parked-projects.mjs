#!/usr/bin/env node
// J645 (P11 step 69a; Angus D8/D9, 65a, 70a): in world D a project with no live owner shows as parked: grey name and ⏸ on the
// project board, in the agents panel and in the finder. Display only, from today's data. Other worlds unchanged.
//   A) lib/parked.mjs: the rule (archived no; Thoughts-written no; no writer or a writer not connected yes; only PARKED_WORLDS).
//   B) an isolated daemon (own socket/state/config, no Hyprland signature; only a fake hyprctl on PATH, so HYPRPI_ALLOW_HYPR is safe), boards D and C, one live fake agent in D:
//      board.get marks D's projects (parked / not), C's never; the finder (--list --rich) shows "⏸ parked" grey for D's parked
//      project and its place in the world colour for the live one, C's unchanged; the board panel and the agents panel (real
//      panels in a pty) draw the parked name grey with ⏸, the live one in the world colour.
//   --shots: also save each panel's raw terminal output to $TMPDIR/shots (kept in the run folder with --keep), for screenshots.
//   node test/run.mjs test/parked-projects.mjs   (exit 0 = pass)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
import { projectParked, PARKED_MARK, PARKED_WORLDS } from "../lib/parked.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const shotsAt = process.argv.indexOf("--shots"), SHOTS = shotsAt > 0 ? (fs.mkdirSync(path.join(os.tmpdir(), "shots"), { recursive: true }), path.join(os.tmpdir(), "shots")) : ""; // (inside the guard: its own /tmp; the run folder keeps it)

// ---- A) the rule
const live = (id) => id === "hp-live";
ok("A a project whose writer is live: not parked", !projectParked({ writer: "hp-live", status: "active" }, "D", live));
ok("A … whose writer isn't connected: parked", projectParked({ writer: "hp-gone", status: "active" }, "D", live));
ok("A … with no writer: parked", projectParked({ writer: "", status: "active" }, "D", live));
ok("A … archived: not parked (it's archived)", !projectParked({ writer: "hp-gone", status: "archived" }, "D", live));
ok("A … written by Thoughts (inbox cards): never parked", !projectParked({ writer: "thoughts:D", status: "active" }, "D", live));
ok("A J701: every world A–G parks a project with no live owner", ["A", "B", "C", "D", "E", "F", "G"].every((w) => projectParked({ writer: "hp-gone", status: "active" }, w, live)));
ok("A … but not H or I (old code there; they join at their next deploy)", !projectParked({ writer: "hp-gone", status: "active" }, "H", live) && !projectParked({ writer: "hp-gone", status: "active" }, "I", live));
ok("A worlds A–G; the mark is ⏸", [...PARKED_WORLDS].sort().join() === "A,B,C,D,E,F,G" && PARKED_MARK === "⏸");

// ---- B) isolated daemon
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j645-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), B = path.join(S, "bin");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(path.join(S, "boards")); fs.mkdirSync(B);
fs.writeFileSync(path.join(B, "hyprctl"), `#!/bin/sh\ncase "$*" in *clients*) echo '[]';; *activeworkspace*) echo '{"id":31}';; *monitors*) echo '[]';; *) echo '{}';; esac\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, topics: false }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const now = Date.now(), card = (id, name, writer, members, extra = {}) => ({ id, name, title: `${name} card`, icon: "📦", status: "active", members, writer, created: now, updated: now, by: "x", where: { text: `${name} where`, by: "x", ts: now }, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [], ...extra });
fs.writeFileSync(path.join(S, "boards", "D.json"), JSON.stringify({ room: "D", projects: [card("p-alive", "alive", "hp-live", ["hp-live"]), card("p-sleepy", "sleepy", "hp-gone", ["hp-gone"]), card("p-orphan", "orphan", "", []), card("p-inbox", "inbox-d", "thoughts:D", [])] }));
fs.writeFileSync(path.join(S, "boards", "C.json"), JSON.stringify({ room: "C", projects: [card("p-cproj", "cproj", "hp-gone2", ["hp-gone2"])] }));
const env = { ...process.env, PATH: `${B}:${process.env.PATH}`, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(S, "xs"), HYPRLAND_INSTANCE_SIGNATURE: "j645-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_ALLOW_HYPR: "1", COLUMNS: "110", LINES: "40", TERM: "xterm-256color", COLORTERM: "truecolor" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "HYPRPI_REMOTE_PANEL", "HYPRPI_REMOTE_LINK"]) delete env[k];
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", "pipe", "pipe"] }); const dl = fs.openSync(path.join(S, "d.log"), "w"); d.stdout.on("data", (b) => fs.writeSync(dl, b)); d.stderr.on("data", (b) => fs.writeSync(dl, b));
const kids = [];
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const agent = await connect({ path: sock, onEvent: () => {} });
  await agent.call("agent.hello", { agent_id: "hp-live", pid: process.pid, name: "Lively", want_workspace: 32, cwd: S });
  const api = await connect({ path: sock, onEvent: () => {} });
  const bd = await api.call("board.get", { room: "D" }), bc = await api.call("board.get", { room: "C" });
  const pk = (b, n) => b.projects.find((p) => p.name === n)?.parked;
  ok("B board.get D: @alive (live owner) not parked", pk(bd, "alive") === false);
  ok("B board.get D: @sleepy (owner not connected) and @orphan (no owner) parked", pk(bd, "sleepy") === true && pk(bd, "orphan") === true);
  ok("B board.get D: inbox-d (Thoughts' card) not parked", pk(bd, "inbox-d") === false);
  ok("B J701 board.get C: @cproj (owner not connected) is parked too now", pk(bc, "cproj") === true);
  ok("B display only: the board file has no parked field written", !fs.readFileSync(path.join(S, "boards", "D.json"), "utf8").includes("parked"));

  // finder
  const fl = execFileSync(process.execPath, [path.join(ROOT, "mockups/finder"), "--list", "--rich"], { env, encoding: "utf8", timeout: 20000 });
  const fline = (n) => { const ls = fl.split("\n"), i = ls.findIndex((l) => l.includes("@" + n + " ")); return i < 0 ? "" : ls[i] + "\n" + (ls[i + 1] || ""); };
  ok("B finder: @sleepy shows ⏸ parked, grey (dim), no world colour", /⏸\t📦 @sleepy · ⏸ parked/.test(fline("sleepy")) && /<font color="dim">@sleepy · ⏸ parked<\/font>/.test(fline("sleepy")), fline("sleepy"));
  ok("B finder: @alive keeps its place in the world colour, no parked mark", !/parked/.test(fline("alive")) && /<font color="#[0-9a-f]{6}">/.test(fline("alive")), fline("alive"));
  ok("B J701 finder: world C's @cproj shows ⏸ parked in grey", /<font color="dim">@cproj · ⏸ parked<\/font>/.test(fline("cproj")), fline("cproj"));
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, "finder.txt"), fl);

  // the panels, real, in a pty (script); raw output kept for the colour checks
  const panel = async (file, room, ms = 5000) => {
    const out = path.join(S, `${path.basename(file)}-${room}.out`);
    const p = spawn("script", ["-qfec", `stty cols 110 rows 40; exec ${process.execPath} ${path.join(ROOT, "mockups", file)} ${room}`, out], { env, stdio: ["pipe", "ignore", "ignore"] }); kids.push(p);
    await sleep(ms); try { p.kill("SIGTERM"); } catch { /* gone */ } await sleep(300);
    const raw = fs.readFileSync(out, "utf8");
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${file.replace(/\.mjs$/, "")}-${room}.ansi`), raw);
    return raw;
  };
  // the foreground in force at "@name": replay the SGR codes before it (0 and 39 reset; 38;2;r;g;b sets): neutral grey = parked,
  // null = the default colour (ParkedCheck: a bare "last 38;2 before" read the ◌ mark's grey instead of the name's)
  const fgAt = (raw, name) => { const i = raw.lastIndexOf("@" + name); if (i < 0) return undefined; const from = raw.lastIndexOf("\n", i); let cur = null;
    for (const m of raw.slice(Math.max(0, from), i).matchAll(/\x1b\[([0-9;]*)m/g)) { const ps = m[1].split(";"); for (let k = 0; k < ps.length; k++) { if (ps[k] === "" || ps[k] === "0" || ps[k] === "39") cur = null; else if (ps[k] === "38" && ps[k + 1] === "2") { cur = ps.slice(k + 2, k + 5).map(Number); k += 4; } } }
    return cur; };
  const greyish = (raw, name) => { const c = fgAt(raw, name); if (!c) return c === null ? false : null; return Math.max(...c) - Math.min(...c) < 40; };
  const bt = await panel("board-tui.mjs", "D");
  ok("B board panel D: @sleepy is drawn with ⏸ parked", /@sleepy[^\n]{0,40}⏸ parked/.test(bt.replace(/\x1b\[[0-9;]*m/g, "")), "");
  ok("B board panel D: @sleepy's name is grey (a neutral 24-bit colour)", greyish(bt, "sleepy") === true);
  ok("B board panel D: @alive has no parked mark, in a non-grey (world) colour", !/@alive[^\n]{0,40}⏸/.test(bt.replace(/\x1b\[[0-9;]*m/g, "")) && greyish(bt, "alive") === false);
  const bc2 = await panel("board-tui.mjs", "C");
  ok("B J701 board panel C: @cproj shows ⏸ parked, grey", /@cproj[^\n]{0,40}⏸ parked/.test(bc2.replace(/\x1b\[[0-9;]*m/g, "")) && greyish(bc2, "cproj") === true);
  const at = await panel("agents-tui.mjs", "D");
  const atp = at.replace(/\x1b\[[0-9;]*m/g, "");
  ok("B agents panel D: @sleepy's row starts with ⏸", /⏸ +📦 +@sleepy/.test(atp), (atp.match(/.{0,10}@sleepy.{0,10}/) || [""])[0]);
  ok("B agents panel D: @sleepy's name is grey", greyish(at, "sleepy") === true);
  ok("B agents panel D: @alive has no ⏸ and isn't grey (its name in the panel's normal colour, as before)", !/⏸ +📦 +@alive/.test(atp) && greyish(at, "alive") === false);
  api.close?.(); agent.close?.();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } } d.kill(); }
console.log(fails ? `parked-projects: ${fails} FAILED (state ${S})` : "parked-projects: all pass"); process.exit(fails ? 1 : 0);
