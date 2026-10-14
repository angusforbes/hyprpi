#!/usr/bin/env node
// J555 W1: a remote world's panel link (omnistation/rlink.mjs ⇄ rlink-remote.mjs), without a network: the "remote machine" is an
// isolated daemon whose state is <tmp>/.hyprpi-h/state (world H's), reached through a stand-in ssh that runs rlink-remote.mjs there.
//  1. a panel connection through the link (lib/client.mjs with HYPRPI_REMOTE_LINK=H) gets world H's daemon; two at once
//  2. link.upload writes a pasted image on the machine (600) and answers its path; a bad name is refused
//  3. a forced drop (the ssh killed): panel connections close, the link comes back by itself, a new connection works
//  4. a hung link (the remote end stopped, no answers): found dead by the keepalive, ended and brought back
//  5. an expired Teleport login: no ssh is started, the link says why and waits
//  6. idle: with no panel for a while the link ends and removes its socket
//   node test/rlink.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f, ms = 8000) => { for (let t = 0; t < ms; t += 100) { try { if (await f()) return true; } catch { /* not yet */ } await sleep(100); } return false; };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j555-")), RH = path.join(T, ".hyprpi-h"), S = path.join(RH, "state"), cfg = path.join(T, "cfg"), dsock = path.join(T, "d.sock");
const RUN = path.join(T, "run"), RD = path.join(T, "remote"), LOG = path.join(T, "link.log");
for (const d of [S, path.join(cfg, "hyprpi"), RUN, RD]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const denv = { ...process.env, HYPRPI_SOCKET: dsock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_NOTIFY_TEST: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "HYPRPI_REMOTE_HOME", "HYPRPI_REMOTE_LINK"]) delete denv[k];
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env: denv, stdio: "ignore" });
// the stand-in ssh: runs the remote end against that daemon, notes its pid; the binding names it (its basename decides "tsh")
const SSH = path.join(T, "fakessh"), PIDS = path.join(T, "remote.pids");
fs.writeFileSync(SSH, `#!/bin/sh\necho $$ >> ${PIDS}\nexec env HYPRPI_STATE=${S} HYPRPI_SOCKET=${dsock} ${process.execPath} ${path.join(ROOT, "omnistation/rlink-remote.mjs")}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [SSH, "host"] }));
const lenv = { ...process.env, XDG_RUNTIME_DIR: RUN, HYPRPI_REMOTE_DIR: RD, HYPRPI_LINK_LOG: LOG, HYPRPI_LINK_PING_MS: "1000", HYPRPI_LINK_IDLE_MS: "4000" };
const { linkSocket } = await import(path.join(ROOT, "lib/paths.mjs"));
const LSOCK = linkSocket("H", lenv);
process.env.XDG_RUNTIME_DIR = RUN; process.env.HYPRPI_REMOTE_LINK = "H"; // this test is "a laptop panel of world H"
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
const pidsNow = () => (fs.existsSync(PIDS) ? fs.readFileSync(PIDS, "utf8").split("\n").filter(Boolean).map(Number) : []);
let link = null;
try {
  for (let i = 0; i < 50 && !fs.existsSync(dsock); i++) await sleep(200);
  link = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H"], { env: lenv, stdio: "ignore" });
  // 1
  let closed = 0;
  const a = await (async () => { for (let i = 0; i < 50; i++) { try { return await connect({ onClose: () => closed++ }); } catch { await sleep(100); } } throw new Error("no link socket"); })();
  ok("1 the link socket is private (600)", (fs.statSync(LSOCK).mode & 0o777) === 0o600);
  const l1 = await a.call("list", {});
  ok("1 a panel connection through the link reaches world H's daemon", JSON.stringify((l1.rooms || []).map((r) => r.id)) === '["H"]', JSON.stringify(l1.rooms));
  const b = await connect({ onClose: () => closed++ });
  const [x1, x2] = await Promise.all([a.call("room.current", {}), b.call("thoughts.get", { room: "H" })]);
  ok("1 two connections at once, each answered on its own channel", x1.room === "H" && x2.room === "H", JSON.stringify([x1, x2]).slice(0, 200));
  // 2
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
  const u = await a.call("link.upload", { name: "pi-clipboard-test.png", data: png.toString("base64") });
  ok("2 an upload is written on the machine, 600, and its path answered", u.path === path.join(RH, "clipboard", "pi-clipboard-test.png") && (fs.statSync(u.path).mode & 0o777) === 0o600 && fs.readFileSync(u.path).equals(png), JSON.stringify(u));
  const ub = await a.call("link.upload", { name: "../evil.sh", data: "eA==" }).then(() => "", (e) => e.message);
  ok("2 a bad upload name is refused", /bad name/.test(ub), ub);
  // 3
  const before = pidsNow().length;
  try { process.kill(pidsNow().at(-1), "SIGKILL"); } catch { /* gone */ }
  ok("3 a forced drop closes the panels' connections (they reconnect by themselves)", await waitFor(() => closed >= 2, 5000), `closed ${closed}`);
  ok("3 the link comes back by itself (a new ssh)", await waitFor(() => pidsNow().length > before, 8000), JSON.stringify(pidsNow()));
  const c = await (async () => { for (let i = 0; i < 40; i++) { try { return await connect(); } catch { await sleep(250); } } return null; })(); const l3 = c ? await c.call("list", {}).catch((e) => ({ err: e.message })) : { err: "no connection" };
  ok("3 a new connection works after it", (l3.rooms || []).some((r) => r.id === "H"), JSON.stringify(l3).slice(0, 200));
  // 4 the remote end hangs (stopped): the keepalive finds it (3 s here) and brings the link back
  const n4 = pidsNow().length, stuck = pidsNow().at(-1);
  // (the stand-in's shell exec'd node: same pid) stop it
  try { process.kill(stuck, "SIGSTOP"); } catch { /* gone */ }
  ok("4 a hung link is found dead by the keepalive and replaced", await waitFor(() => pidsNow().length > n4, 12000), fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").slice(-400) : "");
  try { process.kill(stuck, "SIGCONT"); process.kill(stuck, "SIGKILL"); } catch { /* gone */ }
  const c2 = await (async () => { for (let i = 0; i < 40; i++) { try { const x = await connect(); await x.call("list", {}, { timeoutMs: 3000 }); return x; } catch { await sleep(250); } } return null; })();
  ok("4 … and works again", !!c2);
  c.close?.(); c2?.close?.(); a.close?.(); b.close?.();
  // 6 idle: no panel for 4 s → it ends and removes its socket
  ok("6 with no panel for a while the link ends and removes its sockets", await waitFor(() => link.exitCode !== null && !fs.existsSync(LSOCK) && !fs.existsSync(LSOCK.replace(/\.sock$/, ".ctl")), 15000), `exit ${link.exitCode}, sock ${fs.existsSync(LSOCK)}`);
  // 5 an expired Teleport login: a `tsh` whose status fails; no ssh may start
  const TB = path.join(T, "tbin"); fs.mkdirSync(TB); const TSH = path.join(TB, "tsh"), TLOG = path.join(T, "tsh.log");
  fs.writeFileSync(TSH, `#!/bin/sh\necho "$*" >> ${TLOG}\n[ "$1" = status ] && { echo "ERROR: Not logged in." >&2; exit 1; }\nexit 9\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(RD, "h.json"), JSON.stringify({ ssh: [TSH, "ssh", "me@host"] }));
  link = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H"], { env: lenv, stdio: "ignore" });
  await waitFor(() => fs.existsSync(LSOCK.replace(/\.sock$/, ".ctl")), 5000); await sleep(1500);
  const st = await new Promise((res) => { const p = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink.mjs"), "H", "--status"], { env: lenv }); let o = ""; p.stdout.on("data", (x) => { o += x; }); p.on("close", () => res(o)); });
  ok("5 an expired login: the link is down and says to run tsh login", /down \(.*tsh login/.test(st), st);
  ok("5 … and no ssh was started", !fs.readFileSync(TLOG, "utf8").includes("ssh"), fs.readFileSync(TLOG, "utf8"));
  // (LinkAgents) while the link is down a panel can't connect at all (as with a daemon that isn't running): no half-open channel
  ok("5 … and a panel's connect fails at once while it's down (the panel socket isn't there)", await connect({ timeout: 1000 }).then((x) => { x.close?.(); return false; }, () => true) && !fs.existsSync(LSOCK));
} finally {
  try { link?.kill(); } catch { /* gone */ }
  for (const p of pidsNow()) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  d.kill(); await sleep(300);
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
