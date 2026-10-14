#!/usr/bin/env node
// J472: the phone app's remote world (rworld.mjs + server.mjs), without touching the real remote machine.
//  1. offline: an expired / missing Teleport login (a stand-in tsh whose `status` fails) and an unreachable ssh host both make
//     the world show as offline with a hint; no `tsh ssh` is started while the login isn't valid; the rest of the app still answers.
//  2. the allowlist: only list / agent.prompt / agent.interrupt / thoughts.get / thoughts.send; a session path outside
//     ~/.hyprpi-h/sessions/<agent>/ is refused before anything is sent.
//  (Live reads and sends against the real world H are checked by hand; see the job report.)
//   node test/run.mjs test/remote-world.mjs   (exit 0 = pass; its own temp daemon, never the live one)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j472-")), RD = path.join(T, "remote"), BIN = path.join(T, "bin");
fs.mkdirSync(RD); fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, "tsh"), `#!/bin/sh\necho "$@" >> ${T}/tsh.log\nif [ "$1" = status ]; then echo "ERROR: Not logged in." >&2; exit 1; fi\nexit 9\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [path.join(BIN, "tsh"), "ssh", "me@example.invalid"], label: "Test" }));
process.env.HYPRPI_REMOTE_DIR = RD;
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const r = await import("../remote-control/rworld.mjs");
const w = r.remoteOf("H");
ok("world H from the private file (h.json)", w && w.letter === "H" && w.dir === ".hyprpi-h" && w.label === "Test");
let e = await r.call(w, "list").then(() => null, (x) => x);
ok("expired login: offline with a hint", e?.offline && /tsh login/.test(e.message), e?.message);
ok("no tsh ssh was started", !fs.readFileSync(path.join(T, "tsh.log"), "utf8").includes("ssh"));
ok("offline remembered (no retry storm)", /tsh login/.test(r.offline("world-h")));
e = await r.call(w, "board.item", {}).then(() => null, (x) => x); ok("allowlist", /not allowed/.test(e?.message || ""));
ok("session path check", (await r.sessionCopy(w, "/etc/passwd")) === null && (await r.sessionCopy(w, "/home/x/.hyprpi-h/sessions/a/../../.ssh/id.jsonl")) === null && (await r.sessionCopy(w, "/home/x/.hyprpi-g/sessions/a/s.jsonl")) === null);
// an unreachable plain-ssh host: offline, quickly (BatchMode, ConnectTimeout)
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: ["ssh", "-o", "ConnectTimeout=3", "nobody@192.0.2.1"] }));
const r2 = await import("../remote-control/rworld.mjs?x=2"); const w2 = r2.remoteOf("H");
const t0 = Date.now(); e = await r2.call(w2, "list").then(() => null, (x) => x);
ok("unreachable host: offline", e && /world-h|reach|ended/.test(e.message) && r2.offline("world-h"), `${e?.message} (${Date.now() - t0} ms)`);
// the phone server with that world offline: H listed with its hint, the other worlds still served. J575: against a temp daemon of
// its own (socket, state, config and runtime folder in T): the server used to inherit no HYPRPI_SOCKET and reach the LIVE daemon.
const PORT = 19000 + Math.floor(Math.random() * 900);
const sock = path.join(T, "d.sock"), cfg = path.join(T, "cfg"), run = path.join(T, "run");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true }); fs.mkdirSync(run);
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const denv = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: path.join(T, "state"), XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(T, "xdg"), XDG_RUNTIME_DIR: run, HYPRPI_TEST: "1", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRLAND_INSTANCE_SIGNATURE: "j472-bogus", HYPRPI_REMOTE_DIR: RD };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_WORKSPACE", "WAYLAND_DISPLAY"]) delete denv[k];
const daemon = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: denv, stdio: ["ignore", fs.openSync(path.join(T, "d.log"), "w"), fs.openSync(path.join(T, "d.err"), "w")] });
for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((z) => setTimeout(z, 200));
ok("a temp daemon of the test's own is up (never the live one)", fs.existsSync(sock), sock);
// a throwaway agent in world A on that daemon, so the server has a local world besides H ("the rest still answers")
const { connect } = await import("../lib/client.mjs");
const fake = await connect({ path: sock, onEvent: () => {} }).catch(() => null);
if (fake) await fake.call("agent.hello", { agent_id: "hp-j472fake", pid: process.pid, name: "Fake472", want_workspace: 2, cwd: T }).catch(() => {});
const srv = spawn(process.execPath, [path.join(ROOT, "remote-control/server.mjs")], { env: { ...denv, HYPRPI_REMOTE_PORT: String(PORT) }, stdio: "ignore" });
try {
  let st = null; for (let i = 0; i < 40 && !st; i++) { await new Promise((z) => setTimeout(z, 250)); try { st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json(); } catch { /* not yet */ } }
  const ag = await (await fetch(`http://127.0.0.1:${PORT}/api/agents?world=H`)).json();
  ok("server: H in the worlds, offline with a hint", st?.worlds?.some((x) => x.id === "H") && /reach|ended|world-h/.test(ag.offline || ""), JSON.stringify(ag).slice(0, 300));
  st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
  ok("server: the rest still answers", st.worlds.length > 1 && st.worlds.find((x) => x.id === "H")?.offline, JSON.stringify(st.worlds.map((x) => [x.id, !!x.offline])));
} finally { srv.kill(); try { fake?.close(); } catch { /* gone */ } daemon.kill(); }
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
