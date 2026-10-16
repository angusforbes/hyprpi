#!/usr/bin/env node
// J701 (Angus 76a): the parked look (J645) in every world A–G. An isolated daemon with a board per world, each with @live-<w>
// (owner connected) and @asleep-<w> (owner not connected); the real board panel and agents panel per world in a pty, and the
// finder once. In each world: asleep grey with ⏸ parked, live not. World H (old code there): unchanged. --shots keeps the output.
//   node test/run.mjs test/parked-all-worlds.mjs   (exit 0 = pass)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const WORLDS = ["A", "B", "C", "D", "E", "F", "G"], SHOTS = process.argv.includes("--shots") ? (fs.mkdirSync(path.join(os.tmpdir(), "shots"), { recursive: true }), path.join(os.tmpdir(), "shots")) : "";
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j701-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), B = path.join(S, "bin");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(path.join(S, "boards")); fs.mkdirSync(B);
fs.writeFileSync(path.join(B, "hyprctl"), `#!/bin/sh\ncase "$*" in *clients*) echo '[]';; *activeworkspace*) echo '{"id":31}';; *) echo '[]';; esac\n`, { mode: 0o755 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, topics: false }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const now = Date.now(), card = (id, name, writer) => ({ id, name, title: `${name} card`, icon: "📦", status: "active", members: [writer], writer, created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [] });
for (const w of [...WORLDS, "H"]) { const l = w.toLowerCase(); fs.writeFileSync(path.join(S, "boards", `${w}.json`), JSON.stringify({ room: w, projects: [card(`p-l${l}`, `live-${l}`, `hp-live${l}`), card(`p-a${l}`, `asleep-${l}`, `hp-gone${l}`)] })); }
const env = { ...process.env, PATH: `${B}:${process.env.PATH}`, HYPRPI_ALLOW_HYPR: "1", HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(S, "xs"), HYPRLAND_INSTANCE_SIGNATURE: "j701-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", TERM: "xterm-256color", COLORTERM: "truecolor" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "HYPRPI_REMOTE_PANEL", "HYPRPI_REMOTE_LINK"]) delete env[k];
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", "ignore", "ignore"] });
const kids = [];
const fgAt = (raw, name) => { const i = raw.lastIndexOf("@" + name); if (i < 0) return undefined; let cur = null; for (const m of raw.slice(Math.max(0, raw.lastIndexOf("\n", i)), i).matchAll(/\x1b\[([0-9;]*)m/g)) { const ps = m[1].split(";"); for (let k = 0; k < ps.length; k++) { if (ps[k] === "" || ps[k] === "0" || ps[k] === "39") cur = null; else if (ps[k] === "38" && ps[k + 1] === "2") { cur = ps.slice(k + 2, k + 5).map(Number); k += 4; } } } return cur; };
const grey = (raw, n) => { const c = fgAt(raw, n); return c ? Math.max(...c) - Math.min(...c) < 40 : c === null ? false : null; };
const panel = async (file, room) => { const out = path.join(S, `${file}-${room}.out`); const p = spawn("script", ["-qfec", `stty cols 110 rows 30; exec ${process.execPath} ${path.join(ROOT, "mockups", file)} ${room}`, out], { env, stdio: ["pipe", "ignore", "ignore"] }); kids.push(p); await sleep(4500); try { p.kill("SIGTERM"); } catch { /* gone */ } await sleep(300); const raw = fs.readFileSync(out, "utf8"); if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${file.replace(/\.mjs$/, "")}-${room}.ansi`), raw); return raw; };
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const live = [];
  for (const [i, w] of [...WORLDS, "H"].entries()) { const c = await connect({ path: sock, onEvent: () => {} }); await c.call("agent.hello", { agent_id: `hp-live${w.toLowerCase()}`, pid: process.pid, name: `Live${w}`, want_workspace: (i < 9 ? i : 7) * 10 + 2, cwd: S }); live.push(c); }
  const fl = execFileSync(process.execPath, [path.join(ROOT, "mockups/finder"), "--list", "--rich"], { env, encoding: "utf8", timeout: 20000 });
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, "finder.txt"), fl);
  const fline = (n) => { const ls = fl.split("\n"), i = ls.findIndex((l) => l.includes("@" + n + " ")); return i < 0 ? "" : ls[i] + "\n" + (ls[i + 1] || ""); };
  for (const w of WORLDS) {
    const l = w.toLowerCase();
    const b = await panel("board-tui.mjs", w), a = await panel("agents-tui.mjs", w), bp = plain(b), ap = plain(a);
    const boardOk = /@asleep-[a-g][^\n]{0,30}⏸ parked/.test(bp) && grey(b, `asleep-${l}`) === true && !/@live-[a-g][^\n]{0,30}⏸/.test(bp) && grey(b, `live-${l}`) === false;
    const agentsOk = new RegExp(`⏸ +📦 +@asleep-${l}`).test(ap) && grey(a, `asleep-${l}`) === true && !new RegExp(`⏸ +📦 +@live-${l}`).test(ap) && grey(a, `live-${l}`) === false;
    const finderOk = new RegExp(`<font color="dim">@asleep-${l} · ⏸ parked</font>`).test(fline(`asleep-${l}`)) && !/parked/.test(fline(`live-${l}`));
    ok(`W2 world ${w}: board panel: @asleep-${l} grey with ⏸ parked, @live-${l} not`, boardOk);
    ok(`W2 world ${w}: agents panel: ⏸ and grey for @asleep-${l}, @live-${l} not`, agentsOk);
    ok(`W2 world ${w}: finder: @asleep-${l} "⏸ parked" in grey, @live-${l} not`, finderOk, fline(`asleep-${l}`).split("\n")[0]);
  }
  ok("world H (old code there) unchanged: its finder rows have no parked mark", fline("asleep-h") && !/parked/.test(fline("asleep-h")), fline("asleep-h").split("\n")[0]);
  for (const c of live) c.close();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } } d.kill(); }
console.log(fails ? `parked-all-worlds: ${fails} FAILED (state ${S})` : "parked-all-worlds: all pass"); process.exit(fails ? 1 : 0);
