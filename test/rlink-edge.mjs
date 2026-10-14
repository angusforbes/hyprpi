#!/usr/bin/env node
// J555 (LinkCheck): two edges of omnistation/rlink.mjs, with stand-ins (no network):
//  1. an ssh stuck before its hello (a login prompt that never ends) and deaf to TERM: ended with KILL after the hello limit, and
//     a new one is tried
//  2. the world's daemon gone for good while the link is up and no panel is open: the link's daemon probes don't count as panels,
//     so the link still ends by itself (6 × idle while it can't serve)
//   node test/rlink-edge.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(100); } return false; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j555e-")), F = (n) => path.join(T, n), RD = F("remote"), RUN = F("run");
fs.mkdirSync(RD); fs.mkdirSync(RUN, { mode: 0o700 });
const pids = () => (fs.existsSync(F("pids")) ? fs.readFileSync(F("pids"), "utf8").split("\n").filter(Boolean).map(Number) : []);
const procs = [];
try {
  // 1: a stand-in "ssh" that never says hello and ignores TERM
  fs.writeFileSync(F("stuck"), `#!/usr/bin/env python3\nimport os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen(${JSON.stringify(F("pids"))}, "a").write(f"{os.getpid()}\\n")\ntime.sleep(600)\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [F("stuck"), "host"] }));
  const env = { ...process.env, XDG_RUNTIME_DIR: RUN, HYPRPI_REMOTE_DIR: RD, HYPRPI_LINK_HELLO_MS: "1500", HYPRPI_LINK_PING_MS: "1000", HYPRPI_LINK_LOG: F("log") };
  delete env.HYPRPI_REMOTE_LINK;
  const l1 = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H"], { env, stdio: "ignore" }); procs.push(l1);
  ok("1 a stuck ssh deaf to TERM is killed and a new one tried", await waitFor(() => pids().length >= 2, 15000), JSON.stringify(pids()));
  const first = pids()[0]; let alive = true; try { process.kill(first, 0); } catch { alive = false; }
  ok("1 … the first one is really gone (KILL)", !alive);
  l1.kill(); await sleep(300); for (const p of pids()) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  // 2: link up (a remote end that says hi) but no daemon socket behind it; no panel ever: the link must still end
  fs.writeFileSync(F("pids"), "");
  const S = path.join(T, ".hyprpi-h", "state"); fs.mkdirSync(S, { recursive: true });
  fs.writeFileSync(F("ok"), `#!/bin/sh\necho $$ >> ${F("pids")}\nexec env HYPRPI_STATE=${S} HYPRPI_SOCKET=${F("no-daemon.sock")} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [F("ok"), "host"] }));
  const l2 = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H"], { env: { ...env, HYPRPI_LINK_IDLE_MS: "1500" }, stdio: "ignore" }); procs.push(l2);
  // a panel connects once (so the daemon is found down and probes start), then leaves
  await waitFor(() => fs.existsSync(path.join(RUN, "hyprpi", "link-h.sock")), 8000);
  process.env.XDG_RUNTIME_DIR = RUN; process.env.HYPRPI_REMOTE_LINK = "H";
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  try { const c = await connect({ timeout: 1000 }); await c.call("list", {}, { timeoutMs: 1500 }).catch(() => {}); c.close(); } catch { /* fine */ }
  ok("2 the daemon is found down and probed", await waitFor(() => /daemon down/.test(fs.existsSync(F("log")) ? fs.readFileSync(F("log"), "utf8") : ""), 5000));
  ok("2 with no panel, the link still ends by itself (probes aren't panels)", await waitFor(() => l2.exitCode !== null, 25000), fs.readFileSync(F("log"), "utf8").slice(-300));
} finally {
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
  for (const p of pids()) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  await sleep(300); fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `rlink-edge: ${fails} FAILED` : "rlink-edge: all pass"); process.exit(fails ? 1 : 0);
