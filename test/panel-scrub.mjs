#!/usr/bin/env node
// J553 (9): a LOCAL panel never writes a terminal command that came from an agent. J543 cut them (lib/client.mjs scrub) only in a
// remote world's panel (HYPRPI_REMOTE_PANEL=1); now every panel TUI asks for it (connect({ scrub: true })), other clients don't.
//   A) scrubTerminalCommands: OSC (52 clipboard, 2 title, 8 link), DCS / APC, their C1 forms, CSI that isn't a colour (clear, mouse
//      reporting off), ESC c and other controls are cut; colours (SGR), tab, newline, CR stay
//   B) connect(): { scrub: true } cleans replies and events; without it (and outside a remote panel) the strings come as they are
//      (agents' pi extension, bin/hyprpi); HYPRPI_REMOTE_PANEL=1 still turns it on by default (J543)
//   C) the four real panels (Stream, Thoughts, Projects, agents) in a pseudo-terminal against an isolated daemon (no Hyprland, own
//      state and socket): an agent's Stream post, a Thoughts entry and a project's text carrying OSC 52 / a title / DCS / a mouse-off
//      CSI show their words but none of those bytes reach the terminal, and each panel's own title (OSC 2) still does
//   node test/panel-scrub.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + String(x).slice(0, 1500) : ""}`); };
const { scrubTerminalCommands: S, connect } = await import(path.join(ROOT, "lib/client.mjs"));

// ---- A) the scrub itself
const cases = [
  ["a\x1b]52;c;ZXZpbA==\x07b", "ab", "OSC 52 (clipboard write)"], ["a\x1b]2;evil\x1b\\b", "ab", "OSC 2 (title), ST-ended"],
  ["a\x1b]8;;file:///x\x1b\\link\x1b]8;;\x1b\\b", "alinkb", "OSC 8 (hyperlink): the words stay"], ["a\x1bPqdcs\x1b\\b", "ab", "DCS"],
  ["a\x1b_apc\x07b", "ab", "APC"], ["a\x9d52;c;eA==\x9cb", "ab", "8-bit OSC"], ["a\x9b2Jb", "ab", "8-bit CSI"],
  ["a\x1b[2Jb\x1b[?1000lc\x1b[Hd", "abcd", "CSI that isn't a colour (clear, mouse off, cursor)"], ["a\x1bcb", "ab", "ESC c (reset)"],
  ["\x1b[31mred\x1b[0m \x1b[38;2;1;2;3mx\x1b[m", "\x1b[31mred\x1b[0m \x1b[38;2;1;2;3mx\x1b[m", "colours (SGR) stay"],
  ["t\tn\nr\r\x07\x0e.", "t\tn\nr\r.", "tab / newline / CR stay; BEL, shift-out go"], ["plain ünïcode π 📡", "plain ünïcode π 📡", "plain text untouched"],
];
for (const [i, want, what] of cases) ok(`scrub: ${what}`, S(i) === want, JSON.stringify(S(i)));
ok("scrub: nested objects and arrays", JSON.stringify(S({ a: ["\x1b]0;t\x07ok", { b: 1 }], c: null })) === '{"a":["ok",{"b":1}],"c":null}');

// ---- B) connect(): who gets it
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j553s-")), F = (n) => path.join(T, n);
const EVIL = "\x1b]52;c;ZXZpbA==\x07\x1b]2;pwned-title\x07\x1bPpwn-dcs\x1b\\\x1b[?1000l";
const fake = net.createServer((s) => {
  s.on("data", (d) => { for (const l of d.toString().split("\n").filter(Boolean)) { const m = JSON.parse(l); s.write(JSON.stringify({ id: m.id, result: { text: `r ${EVIL} r` } }) + "\n"); } });
  s.write(JSON.stringify({ event: "message", data: { text: `e ${EVIL} e` } }) + "\n");
});
await new Promise((r) => fake.listen(F("fake.sock"), r));
async function through(opts, env) {
  const saved = process.env.HYPRPI_REMOTE_PANEL; if (env) process.env.HYPRPI_REMOTE_PANEL = env; else delete process.env.HYPRPI_REMOTE_PANEL;
  let ev = null; const c = await connect({ path: F("fake.sock"), onEvent: (_e, d) => { ev = d.text; }, ...opts });
  const r = await c.call("x"); await sleep(50); c.close();
  if (saved === undefined) delete process.env.HYPRPI_REMOTE_PANEL; else process.env.HYPRPI_REMOTE_PANEL = saved;
  return { r: r.text, ev };
}
let t = await through({ scrub: true });
ok("connect({ scrub: true }): reply and event cleaned", t.r === "r  r" && t.ev === "e  e", JSON.stringify(t));
t = await through({});
ok("connect() (not a panel): strings as they are", t.r === `r ${EVIL} r` && t.ev === `e ${EVIL} e`, JSON.stringify(t));
t = await through({}, "1");
ok("connect() in a remote panel (HYPRPI_REMOTE_PANEL=1): cleaned by default (J543)", t.r === "r  r" && t.ev === "e  e", JSON.stringify(t));
fake.close();

// ---- C) the real panels, local, against an isolated daemon
const H = F("home"), ST = F("state"), RUN = F("run"), BIN = F("bin");
for (const d of [path.join(H, ".config/hyprpi"), path.join(ST, "boards"), path.join(ST, "thoughts"), RUN, BIN]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(H, ".config/hyprpi/config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(H, ".config/hyprpi/hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const now = Date.now();
fs.writeFileSync(path.join(ST, "boards/H.json"), JSON.stringify({ room: "H", projects: [{ id: "p-sc", name: "scrubproj", title: `projtitle ${EVIL} end`, status: "active", members: ["h-alpha"], writer: "h-alpha", created: now, updated: now, by: "x", where: { text: `wheremark ${EVIL} done`, by: "alpha", ts: now }, next_step: null, seq: { D: 0, N: 1, H: 0 }, items: [{ h: "N1", sec: "next", text: `itemmark ${EVIL} fin`, by: { id: "", name: "x" }, ts: now, updated: now }] }] }));
fs.writeFileSync(path.join(ST, "thoughts/H.thread.jsonl"), JSON.stringify({ ts: now, role: "thoughts", text: `thoughtmark ${EVIL} over` }) + "\n");
for (const x of ["hyprctl", "gio", "xdg-open", "wl-paste", "wl-copy", "notify-send", "kitty"]) fs.writeFileSync(path.join(BIN, x), `#!/bin/sh\ncase "$1 $2" in "-j "*) case "$2" in clients|workspaces|monitors) echo '[]';; *) echo '{}';; esac;; esac\nexit 0\n`, { mode: 0o755 });
const ENV = { HOME: H, PATH: `${BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HYPRPI_STATE: ST, HYPRPI_SOCKET: path.join(RUN, "daemon.sock"), XDG_RUNTIME_DIR: RUN, XDG_CONFIG_HOME: path.join(H, ".config"), XDG_STATE_HOME: path.join(H, ".state"), HYPRPI_NO_ADOPT: "1", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", TERM: "xterm-256color", LANG: "C.UTF-8" };
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: ENV, stdio: ["ignore", "ignore", fs.openSync(F("daemon.err"), "w")] });
const panels = [];
try {
  for (let i = 0; i < 60 && !fs.existsSync(ENV.HYPRPI_SOCKET); i++) await sleep(200);
  ok("the isolated daemon runs", fs.existsSync(ENV.HYPRPI_SOCKET), fs.readFileSync(F("daemon.err"), "utf8").slice(-400));
  const alpha = await connect({ path: ENV.HYPRPI_SOCKET, onEvent: () => {} });
  await alpha.call("agent.hello", { agent_id: "h-alpha", pid: process.pid, name: "alpha", want_workspace: 71, cwd: H });
  await alpha.call("room.post", { text: `streammark ${EVIL} tail` });
  const run = (kind) => {
    const p = { kind, raw: "" };
    p.proc = spawn("script", ["-qfc", `stty cols 200 rows 40; exec ${process.execPath} ${path.join(ROOT, `mockups/${kind}-tui.mjs`)} H`, "/dev/null"], { env: ENV, stdio: ["pipe", "pipe", "ignore"] });
    p.proc.stdout.on("data", (b) => { p.raw += b.toString(); });
    panels.push(p); return p;
  };
  const room = run("room"), search = run("search"), board = run("board"), agents = run("agents");
  await sleep(5000);
  await alpha.call("room.post", { text: `livemark ${EVIL} tail` }); // (an event while the Stream is open)
  await sleep(2500);
  const bad = (raw) => ["ZXZpbA", "pwned-title", "pwn-dcs", "\x1b[?1000l"].filter((s) => raw.includes(s));
  const own = { room: "hyprpi-room H", search: "hyprpi-search H", board: "hyprpi-board H", agents: "hyprpi-router H" };
  const words = { room: ["streammark", "livemark"], search: ["thoughtmark"], board: ["projtitle", "itemmark", "wheremark"], agents: ["alpha", "wheremark"] };
  for (const p of panels) {
    const vis = p.raw.replace(/\x1b\[[0-9;?:]*[ -\/]*[@-~]/g, "");
    ok(`${p.kind}: shows the agent's words`, words[p.kind].every((w) => vis.includes(w)), vis.slice(-1500));
    ok(`${p.kind}: none of their terminal commands reach the terminal`, bad(p.raw).length === 0, JSON.stringify(bad(p.raw)));
    ok(`${p.kind}: its own title (OSC 2) still does`, p.raw.includes(`\x1b]2;${own[p.kind]}\x07`), JSON.stringify(p.raw.slice(0, 300)));
  }
  alpha.close();
} finally {
  for (const p of panels) { try { p.proc.stdin.write("\x11"); } catch { /* gone */ } }
  await sleep(600);
  for (const p of panels) { try { p.proc.kill("SIGKILL"); } catch { /* gone */ } }
  d.kill(); await sleep(300); try { d.kill("SIGKILL"); } catch { /* gone */ }
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `panel-scrub: ${fails} FAILED` : "panel-scrub: all pass");
process.exit(fails ? 1 : 0);
