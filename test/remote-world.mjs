#!/usr/bin/env node
// J472: the phone app's remote world (rworld.mjs + server.mjs), without touching the real remote machine.
//  1. offline: an expired / missing Teleport login (a stand-in tsh whose `status` fails) and an unreachable ssh host both make
//     the world show as offline with a hint; no `tsh ssh` is started while the login isn't valid; the rest of the app still answers.
//  2. the allowlist: only list / agent.prompt / agent.interrupt / thoughts.get / thoughts.send; a session path outside
//     ~/.hyprpi-h/sessions/<agent>/ is refused before anything is sent.
//  (Live reads and sends against the real world H are checked by hand; see the job report.)
//   node test/remote-world.mjs   (exit 0 = pass)
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
// the phone server with that world offline: H listed with its hint, the other worlds still served
const PORT = 19000 + Math.floor(Math.random() * 900);
const srv = spawn(process.execPath, [path.join(ROOT, "remote-control/server.mjs")], { env: { ...process.env, HYPRPI_REMOTE_PORT: String(PORT), HYPRPI_REMOTE_DIR: RD }, stdio: "ignore" });
try {
  let st = null; for (let i = 0; i < 40 && !st; i++) { await new Promise((z) => setTimeout(z, 250)); try { st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json(); } catch { /* not yet */ } }
  const ag = await (await fetch(`http://127.0.0.1:${PORT}/api/agents?world=H`)).json();
  ok("server: H in the worlds, offline with a hint", st?.worlds?.some((x) => x.id === "H") && /reach|ended|world-h/.test(ag.offline || ""), JSON.stringify(ag).slice(0, 300));
  st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
  ok("server: the rest still answers", st.worlds.length > 1 && st.worlds.find((x) => x.id === "H")?.offline);
} finally { srv.kill(); }
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
