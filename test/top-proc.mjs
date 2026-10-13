#!/usr/bin/env node
// J557 proof for lib/top-proc.mjs (read-only process sampler for the hyprpi top view).
//   node test/top-proc.mjs
// A) synthetic /proc trees (temp dirs): stat parsing, CPU deltas, pid reuse, nested owners, detached env
//    attribution, unattributed Pi buckets, non-agent exclusion, unreadable / exited processes, remote
//    owners, RSS, memory and swap.
// B) the real /proc with a few tiny dummy processes of our own (sleep / a short shell loop), killed at the end.
// C) cost: sample time and the sampler's own CPU on the real /proc at a 2 s cadence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ProcSampler, parseStat, isPiArgv } from "../lib/top-proc.mjs";

let fails = 0;
const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x !== "" ? ": " + (typeof x === "string" ? x : JSON.stringify(x)) : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j557-top-"));

// ---- synthetic /proc builder
function mkRoot(name) {
  const root = path.join(T, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function writeSystem(root, { up = 1000, cpu = [1000, 0, 500, 8000, 100, 0, 0, 0], cores = 4, mem = {} } = {}) {
  const lines = [`cpu  ${cpu.join(" ")} 0 0`];
  for (let i = 0; i < cores; i++) lines.push(`cpu${i} 1 2 3 4 5 6 7 8 0 0`);
  lines.push("intr 1 2 3", "ctxt 5");
  fs.writeFileSync(path.join(root, "stat"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(root, "loadavg"), "1.50 0.75 0.25 3/900 12345\n");
  fs.writeFileSync(path.join(root, "uptime"), `${up.toFixed(2)} 99999.00\n`);
  const m = { MemTotal: 16000000, MemFree: 1000000, MemAvailable: 8000000, SwapTotal: 4000000, SwapFree: 3000000, ...mem };
  fs.writeFileSync(path.join(root, "meminfo"), Object.entries(m).map(([k, v]) => `${(k + ":").padEnd(16)}${String(v).padStart(10)} kB`).join("\n") + "\nHugePages_Total:       0\nActive(anon):    123 kB\n");
}
function writeProc(root, p) {
  const d = path.join(root, String(p.pid));
  fs.mkdirSync(d, { recursive: true });
  const f = [p.state || "S", p.ppid ?? 1, p.pid, p.pid, 0, -1, 4194304, 0, 0, 0, 0, p.utime ?? 0, p.stime ?? 0, p.cutime ?? 0, p.cstime ?? 0, 20, 0, 1, 0, p.start ?? 100, 1000000, p.rss ?? 0, "18446744073709551615", 0, 0];
  fs.writeFileSync(path.join(d, "stat"), `${p.pid} (${p.comm ?? "x"}) ${f.join(" ")}\n`);
  fs.writeFileSync(path.join(d, "cmdline"), (p.argv || [p.comm ?? "x"]).join("\0") + "\0");
  const env = { PATH: "/usr/bin", SECRET_TOKEN: "do-not-leak", ...(p.env || {}) };
  fs.writeFileSync(path.join(d, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
}

// ---- A0) parsers
{
  const s = parseStat("123 (we ird) (x)) R 45 1 1 0 -1 0 0 0 0 0 7 3 900 900 20 0 1 0 555 1000 12 0\n");
  ok("A0 stat comm with spaces and parentheses (last ')' wins)", s && s.comm === "we ird) (x)" && s.ppid === 45 && s.ticks === 10 && s.startTicks === 555 && s.rssPages === 12, s);
  ok("A0 cutime/cstime are not in ticks", s.ticks === 10);
  ok("A0 garbage stat → null", parseStat("nonsense") === null);
  ok("A0 pi argv: the pi binary", isPiArgv(["/home/u/.local/share/mise/installs/pi/latest/pi/pi", "--model", "x"]));
  ok("A0 pi argv: node + bin/pi", isPiArgv(["node", "/usr/lib/node_modules/.bin/pi", "-e", "ext.ts"]));
  ok("A0 pi argv: node + pi-coding-agent cli.js after flags", isPiArgv(["/opt/node/bin/node", "--enable-source-maps", "/x/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"]));
  ok("A0 pi argv: node + mise pi dist/bundle/cli.js", isPiArgv(["node", "/home/u/.local/share/mise/installs/pi/1.0.2/pi/dist/bundle/cli.js"]));
  ok("A0 not pi: node server.js", !isPiArgv(["node", "/srv/server.js", "pi"]));
  ok("A0 not pi: node -e 'pi'", !isPiArgv(["node", "-e", "require('/x/pi')"]));
  ok("A0 not pi: python pi.py / pipewire", !isPiArgv(["python3", "pi.py"]) && !isPiArgv(["/usr/bin/pipewire"]));
}

// ---- A) the main synthetic tree
const R = mkRoot("main");
writeSystem(R);
const P = {
  init: { pid: 1, ppid: 0, comm: "systemd", start: 1, rss: 3000, utime: 500 },
  // owner A: kitty root 100 → pi 101 → bash 102 → odd comm 103; nested owner B root 110 under 101
  k100: { pid: 100, ppid: 1, comm: "kitty", start: 1000, rss: 10000, utime: 100, stime: 10 },
  p101: { pid: 101, ppid: 100, comm: "pi", start: 1010, rss: 50000, utime: 1000, stime: 100, cutime: 7, env: { HYPRPI_AGENT_ID: "id-A" } },
  b102: { pid: 102, ppid: 101, comm: "bash", start: 1020, rss: 1000, utime: 10, env: { HYPRPI_AGENT_ID: "id-A" } },
  w103: { pid: 103, ppid: 102, comm: "a b) (c", start: 1030, rss: 100, env: { HYPRPI_AGENT_ID: "id-A" } },
  p110: { pid: 110, ppid: 101, comm: "pi", start: 2000, rss: 40000, utime: 300, env: { HYPRPI_AGENT_ID: "id-B" } },
  c111: { pid: 111, ppid: 110, comm: "rg", start: 2100, rss: 2000, utime: 5 },
  // detached env attribution
  d200: { pid: 200, ppid: 1, comm: "sleep", start: 3000, rss: 300, env: { HYPRPI_AGENT_ID: "id-A" } },
  d201: { pid: 201, ppid: 200, comm: "cat", start: 3001, rss: 200, env: { PATH: "/bin" } },
  d202: { pid: 202, ppid: 1, comm: "tail", start: 3002, rss: 400, env: { HYPRPI_NAME: "Bee" } },
  d203: { pid: 203, ppid: 1, comm: "tail", start: 3003, rss: 400, env: { HYPRPI_NAME: "Dup" } },
  d206: { pid: 206, ppid: 200, comm: "sleep", start: 3006, rss: 400, env: { HYPRPI_AGENT_ID: "hp-unknown" } },
  // remote world owner: local ssh root 300; detached HYPRPI_REMOTE_WORLD=H; a Z one stays out
  s300: { pid: 300, ppid: 1, comm: "ssh", start: 4000, rss: 5000, utime: 40 },
  s301: { pid: 301, ppid: 1, comm: "socat", start: 4001, rss: 600, env: { HYPRPI_REMOTE_WORLD: "H" } },
  s302: { pid: 302, ppid: 1, comm: "socat", start: 4002, rss: 600, env: { HYPRPI_REMOTE_WORLD: "Z" } },
  // unattributed Pi buckets
  u400: { pid: 400, ppid: 1, comm: "pi", start: 5000, rss: 30000, utime: 200 },
  u401: { pid: 401, ppid: 400, comm: "bash", start: 5001, rss: 900, utime: 1 },
  u402: { pid: 402, ppid: 1, comm: "node-MainThread", start: 5002, rss: 25000, argv: ["node", "/x/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", "--prompt", "secret prompt"] },
  u405: { pid: 405, ppid: 1, comm: "pi", start: 5005, rss: 20000, env: { HYPRPI_AGENT_ID: "hp-gone" } },
  // not agents
  n403: { pid: 403, ppid: 1, comm: "node", start: 5003, rss: 70000, utime: 9000, argv: ["node", "/srv/server.js"] },
  n404: { pid: 404, ppid: 1, comm: "node", start: 5004, rss: 70000, argv: ["node", "-e", "require('/x/pi')"] },
  n500: { pid: 500, ppid: 1, comm: "firefox", start: 6000, rss: 900000, utime: 99999 },
  kth: { pid: 2, ppid: 0, comm: "kthreadd", start: 0 },
  kw: { pid: 50, ppid: 2, comm: "kworker/0:1", start: 2 },
};
for (const p of Object.values(P)) writeProc(R, p);
// unreadable process (stat 000) and one with unreadable environ; an exited one (dir, no stat)
const isRoot = process.getuid && process.getuid() === 0;
writeProc(R, { pid: 600, ppid: 1, comm: "locked", start: 7000 }); fs.chmodSync(path.join(R, "600", "stat"), 0o000);
writeProc(R, { pid: 601, ppid: 1, comm: "noenv", start: 7001 }); fs.chmodSync(path.join(R, "601", "environ"), 0o000);
fs.mkdirSync(path.join(R, "700"));
fs.mkdirSync(path.join(R, "self")); // non-numeric entries are ignored

const owners = [
  { id: "id-A", name: "Alpha", world: "C", pids: [100], envIds: ["id-A"] },
  { id: "id-B", name: "Bee", world: "C", pids: [110], envIds: ["id-B"] },
  { id: "id-C", name: "Dup", world: "C", pids: [], envIds: ["id-C"] },
  { id: "id-D", name: "Dup", world: "D", pids: [], envIds: ["id-D"] },
  { id: "id-E", name: "Gone", world: "D", pids: [99999], envIds: ["id-E"] },
  { id: "id-R", name: "Remote", world: "H", pids: [300], envIds: ["id-R"], envWorld: "H", remote: true },
  { id: "id-L", name: "Local", world: "H", pids: [], envIds: ["id-L"] },
];
let mono = 0;
const S = new ProcSampler({ procRoot: R, clockTicks: 100, pageSize: 4096, now: () => mono });
const r1 = await S.sample(owners);
const G = (r, id) => r.groups.find((g) => g.id === id);
const pidsOf = (r, id) => (G(r, id) || r.unattributed.find((u) => u.id === id) || {}).pids;
{
  ok("A1 first sample: intervalSeconds and every CPU null", r1.intervalSeconds === null && r1.system.cpuPercent === null && r1.totals.cpuPercent === null && r1.processes.every((p) => p.cpuPercent === null) && r1.groups.every((g) => g.cpuPercent === null));
  ok("A1 system: cores, load, uptime", r1.system.cpuCores === 4 && JSON.stringify(r1.system.loadAverage) === "[1.5,0.75,0.25]" && r1.system.uptimeSeconds === 1000);
  ok("A1 memory and swap in bytes", r1.system.memoryTotalBytes === 16000000 * 1024 && r1.system.memoryAvailableBytes === 8000000 * 1024 && r1.system.swapTotalBytes === 4000000 * 1024 && r1.system.swapUsedBytes === 1000000 * 1024, r1.system);
  ok("A1 every owner listed, in order", r1.groups.map((g) => g.id).join() === "id-A,id-B,id-C,id-D,id-E,id-R,id-L");
  ok("A1 owner A: its tree minus nested B, plus detached env-matched 200/201", JSON.stringify(pidsOf(r1, "id-A")) === "[100,101,102,103,200,201]", pidsOf(r1, "id-A"));
  ok("A1 nested owner B separate (root 110 + child), plus HYPRPI_NAME=Bee (unique name)", JSON.stringify(pidsOf(r1, "id-B")) === "[110,111,202]", pidsOf(r1, "id-B"));
  ok("A1 no pid in two groups", (() => { const all = [...r1.groups, ...r1.unattributed].flatMap((g) => g.pids); return all.length === new Set(all).size; })());
  const a = G(r1, "id-A");
  ok("A1 RSS = resident pages × PAGESIZE summed", a.rssBytes === (10000 + 50000 + 1000 + 100 + 300 + 200) * 4096, a.rssBytes);
  ok("A1 group uptime from the primary root (kitty 100: 1000 - 10 s)", a.uptimeSeconds === 990, a.uptimeSeconds);
  ok("A1 piCount / processCount", a.piCount === 1 && a.processCount === 6 && G(r1, "id-B").piCount === 1);
  ok("A1 odd comm kept intact in the row", r1.processes.find((p) => p.pid === 103)?.comm === "a b) (c");
  ok("A1 duplicate name 'Dup': no name match (203 not attributed)", G(r1, "id-C").processCount === 0 && G(r1, "id-D").processCount === 0 && !r1.processes.some((p) => p.pid === 203));
  ok("A1 unknown HYPRPI_AGENT_ID under an env-matched parent is not inherited (206 out of A)", !pidsOf(r1, "id-A").includes(206) && !r1.processes.some((p) => p.pid === 206));
  const e = G(r1, "id-E");
  ok("A1 owner with no live local pid: null metrics, zero counts", e && e.cpuPercent === null && e.rssBytes === null && e.uptimeSeconds === null && e.processCount === 0 && e.pids.length === 0, e);
  ok("A1 remote owner: its local root + HYPRPI_REMOTE_WORLD=H only", JSON.stringify(pidsOf(r1, "id-R")) === "[300,301]", pidsOf(r1, "id-R"));
  ok("A1 local owner in world H gets nothing from envWorld; Z stays out", G(r1, "id-L").processCount === 0 && !r1.processes.some((p) => p.pid === 302));
  const u = r1.unattributed;
  ok("A1 unattributed buckets: pi 400 (+ bash 401), node-run Pi CLI 402, unknown agent pi 405", JSON.stringify(u.map((b) => b.pids).sort()) === JSON.stringify([[400, 401], [402], [405]].sort()), u.map((b) => b.pids));
  ok("A1 bucket ids and names", u.some((b) => b.id === "unattributed:400:5000" && b.name === "pi (pid 400)") && u.some((b) => /^hp-gone \(pid 405/.test(b.name)), u.map((b) => [b.id, b.name]));
  ok("A1 processes rows point at their group; agentLike marks Pi", r1.processes.find((p) => p.pid === 401).ownerId === "unattributed:400:5000" && r1.processes.find((p) => p.pid === 402).agentLike && !r1.processes.find((p) => p.pid === 401).agentLike);
  ok("A1 non-agents excluded (node server, node -e, firefox, systemd, kernel threads)", ![403, 404, 500, 1, 2, 50].some((x) => r1.processes.some((p) => p.pid === x)));
  const expectProcs = 6 + 3 + 2 + 2 + 1 + 1;
  ok("A1 totals = attributed groups + unattributed buckets, each process once", r1.totals.processCount === expectProcs && r1.processes.length === expectProcs && r1.totals.rssBytes === [...r1.groups, ...r1.unattributed].reduce((s, g) => s + (g.rssBytes || 0), 0), r1.totals);
  if (!isRoot) ok("A1 unreadable stat: counted, reported, no crash", r1.scan.unreadable === 1 && r1.limitations.some((l) => /unreadable \(permission\)/.test(l)), r1.limitations);
  ok("A1 exited process (no stat) does not crash and is counted as vanished", r1.scan.vanished >= 1);
  if (!isRoot) ok("A1 unreadable environ reported as an attribution limit", r1.limitations.some((l) => /environment unreadable for/.test(l)), r1.limitations);
  ok("A1 owner E's missing root reported", r1.limitations.some((l) => /no live local process.*id-E/.test(l)));
  const json = JSON.stringify(r1);
  ok("A1 no raw environment or command line leaks", !/SECRET_TOKEN|do-not-leak|secret prompt|server\.js|PATH=/.test(json));
}

// ---- A2) second sample: CPU deltas, pid reuse, cache
{
  mono += 2000; // 2 s later
  writeSystem(R, { up: 1002, cpu: [1150, 0, 550, 8600, 100, 0, 0, 0] }); // Δtotal 800, Δbusy 200 → 25 %
  const bump = (p, du, extra = {}) => writeProc(R, { ...p, utime: (p.utime || 0) + du, ...extra });
  bump(P.k100, 10); bump(P.p101, 50, { cutime: 99999, cstime: 99999 }); bump(P.b102, 20); bump(P.d200, 4);
  bump(P.p110, 30); bump(P.c111, 10); bump(P.s300, 6); bump(P.u400, 100); bump(P.n500, 400);
  // pid reuse: 402 is now a different node process (new start time) running something else
  writeProc(R, { pid: 402, ppid: 1, comm: "node-MainThread", start: 100150, rss: 1000, utime: 8, argv: ["node", "/srv/other.js"] });
  // a brand-new child of A born during the interval (start 1001.0 s ≥ previous uptime 1000 s): all its ticks count
  writeProc(R, { pid: 104, ppid: 101, comm: "git", start: 100100, utime: 6, rss: 10 });
  // cache: 400's cmdline changes without a new start time → identity cached, still Pi (comm "pi" anyway);
  // 401 also changes cmdline to look like pi: same pid+start+comm → cache keeps "not pi"
  fs.writeFileSync(path.join(R, "401", "cmdline"), "pi\0");
  // 103 exits during the interval
  fs.rmSync(path.join(R, "103"), { recursive: true });
  const r2 = await S.sample(owners);
  ok("A2 interval 2 s, system CPU 25 %", r2.intervalSeconds === 2 && r2.system.cpuPercent === 25, [r2.intervalSeconds, r2.system.cpuPercent]);
  const cpu = (pid) => r2.processes.find((p) => p.pid === pid)?.cpuPercent;
  ok("A2 per-process CPU = Δ(utime+stime)/(2 s × 100) × 100 (cutime ignored)", cpu(100) === 5 && cpu(101) === 25 && cpu(102) === 10 && cpu(200) === 2 && cpu(201) === 0, [cpu(100), cpu(101), cpu(102), cpu(200)]);
  ok("A2 new process born in the interval: all its ticks (6 → 3 %)", cpu(104) === 3);
  const a = G(r2, "id-A"), b = G(r2, "id-B");
  ok("A2 owner A CPU = 5+25+10+3+2+0 = 45 (nested B not double counted)", a.cpuPercent === 45 && JSON.stringify(a.pids) === "[100,101,102,104,200,201]", [a.cpuPercent, a.pids]);
  ok("A2 owner B CPU = 15+5+0 = 20", b.cpuPercent === 20, b.cpuPercent);
  ok("A2 remote owner CPU from its local root only (3 %)", G(r2, "id-R").cpuPercent === 3);
  ok("A2 reused pid 402 dropped its cached Pi identity (no longer a bucket)", !r2.unattributed.some((u) => u.pids.includes(402)) && !r2.processes.some((p) => p.pid === 402));
  ok("A2 identity cached by pid+start+comm (401 still not Pi after its cmdline changed)", r2.processes.find((p) => p.pid === 401)?.agentLike === false);
  ok("A2 bucket 400 CPU 50 %", r2.unattributed.find((u) => u.id === "unattributed:400:5000").cpuPercent === 50, r2.unattributed.find((u) => u.id === "unattributed:400:5000"));
  ok("A2 totals CPU sums groups + buckets; firefox's 200 % not included", r2.totals.cpuPercent === Math.round(([...r2.groups, ...r2.unattributed].reduce((s, g) => s + (g.cpuPercent || 0), 0)) * 100) / 100 && r2.totals.cpuPercent < 150, r2.totals.cpuPercent);
  ok("A2 no 'first sample' limitation any more", !r2.limitations.some((l) => /first sample/.test(l)));

  // pid reuse with a start time BEFORE the previous sample (impossible / inconsistent): CPU unknown, not guessed
  mono += 2000; writeSystem(R, { up: 1004, cpu: [1200, 0, 600, 9200, 100, 0, 0, 0] });
  writeProc(R, { ...P.c111, start: 2101, utime: 500 });
  const r3 = await S.sample(owners);
  ok("A3 inconsistent start time: CPU null, limitation reported", r3.processes.find((p) => p.pid === 111).cpuPercent === null && r3.limitations.some((l) => /CPU unknown for 1/.test(l)));
  ok("A3 group sum keeps the known members (B = 110 only, 0 %)", G(r3, "id-B").cpuPercent === 0);
}

// ---- A4) owner root fallback and races
{
  const R4 = mkRoot("fallback"); writeSystem(R4, { up: 500 });
  writeProc(R4, { pid: 10, ppid: 1, comm: "sleep", start: 2000, env: { HYPRPI_AGENT_ID: "id-X" } });
  writeProc(R4, { pid: 11, ppid: 1, comm: "sleep", start: 1000, env: { HYPRPI_AGENT_ID: "id-X" } });
  writeProc(R4, { pid: 20, ppid: 1, comm: "pi", start: 3000 });
  const s4 = new ProcSampler({ procRoot: R4, clockTicks: 100, pageSize: 4096, now: () => 0 });
  const r = await s4.sample([{ id: "id-X", name: "X", world: "A", pids: [77], envIds: ["id-X"] }, { id: "id-Y", name: "Y", world: "A", pids: [20], envIds: [] }, { id: "id-Z", name: "Z", world: "A", pids: [20], envIds: [] }]);
  ok("A4 no live root: uptime from the oldest member (11: 500-10)", G(r, "id-X").uptimeSeconds === 490, G(r, "id-X"));
  ok("A4 a pid given to two owners: first keeps it, reported", G(r, "id-Y").processCount === 1 && G(r, "id-Z").processCount === 0 && r.limitations.some((l) => /both id-Y and id-Z/.test(l)));
  const bad = new ProcSampler({ procRoot: path.join(T, "does-not-exist"), clockTicks: 100, pageSize: 4096 });
  const rb = await bad.sample([{ id: "q", pids: [1] }]);
  ok("A4 missing procRoot: no crash, nulls, limitation", rb.system.memoryTotalBytes === null && rb.groups[0].rssBytes === null && rb.limitations.some((l) => /cannot list/.test(l)));
  const rz = await bad.sample();
  ok("A4 sample() with no owners", Array.isArray(rz.groups) && rz.groups.length === 0);
}

// ---- A5) incremental scans: unrelated old processes are not re-read between full scans
{
  const R5 = mkRoot("incr"); writeSystem(R5, { up: 1000 });
  writeProc(R5, { pid: 10, ppid: 1, comm: "kitty", start: 100, rss: 10 });
  for (let i = 0; i < 50; i++) writeProc(R5, { pid: 1000 + i, ppid: 1, comm: "daemon" + i, start: 200 + i });
  writeProc(R5, { pid: 60, ppid: 1, comm: "sh", start: 99900 }); // young (999 s, uptime 1000 s)
  let m5 = 0;
  const s5 = new ProcSampler({ procRoot: R5, clockTicks: 100, pageSize: 4096, now: () => m5, fullScanEvery: 4 });
  const own = [{ id: "K", name: "K", world: "A", pids: [10], envIds: [] }];
  const x1 = await s5.sample(own);
  ok("A5 first sample is a full scan", x1.scan.full && x1.scan.statsRead === 52, x1.scan);
  m5 += 2000; writeSystem(R5, { up: 1002 });
  writeProc(R5, { pid: 11, ppid: 10, comm: "bash", start: 100150 }); // new child of the root
  writeProc(R5, { pid: 60, ppid: 1, comm: "pi", start: 99900 }); // the young shell exec'd into pi
  const x2 = await s5.sample(own);
  ok("A5 between full scans the 50 old unrelated processes keep their cached record", !x2.scan.full && x2.scan.cachedUnrelated === 50 && x2.scan.statsRead === 3, x2.scan);
  ok("A5 a new child of a root is picked up at once", JSON.stringify(G(x2, "K").pids) === "[10,11]");
  ok("A5 a young process that exec'd into pi is re-read and becomes a bucket", x2.unattributed.some((u) => u.pids.includes(60)));
  m5 += 2000; writeSystem(R5, { up: 1004 });
  const x3 = await s5.sample([...own, { id: "D", name: "D", world: "A", pids: [1003], envIds: [] }]);
  ok("A5 an owners change forces a full scan; a newly registered old root is read", x3.scan.full && G(x3, "D").processCount === 1 && G(x3, "D").cpuPercent === null, [x3.scan, G(x3, "D")]);
  m5 += 2000; writeSystem(R5, { up: 1006 });
  const x4 = await s5.sample([...own, { id: "D", name: "D", world: "A", pids: [1003], envIds: [] }]);
  ok("A5 periodic full scan every fullScanEvery samples; the new root has CPU once seen twice", x4.scan.full && G(x4, "D").cpuPercent === 0, [x4.scan, G(x4, "D")]);
}

// ---- A6) monitor (own pid), rootPiCount, getconf failure
{
  const R6 = mkRoot("monitor"); writeSystem(R6, { up: 1000 });
  writeProc(R6, { pid: 77, ppid: 1, comm: "node-MainThread", start: 100, utime: 10, rss: 500, argv: ["node", "/x/bin/hyprpi", "top"] }); // the monitor: not agent-related
  writeProc(R6, { pid: 20, ppid: 1, comm: "pi", start: 200, rss: 10 });
  writeProc(R6, { pid: 21, ppid: 20, comm: "pi", start: 300, rss: 10 }); // an in-process helper pi under root 20
  writeProc(R6, { pid: 30, ppid: 1, comm: "python3", start: 400, rss: 10 }); // a proxy root
  writeProc(R6, { pid: 31, ppid: 30, comm: "pi", start: 500, rss: 10 });
  writeProc(R6, { pid: 40, ppid: 1, comm: "pi", start: 600, rss: 10 });
  writeProc(R6, { pid: 41, ppid: 1, comm: "pi", start: 700, rss: 10 });
  writeProc(R6, { pid: 50, ppid: 1, comm: "sleep", start: 800, rss: 10, env: { HYPRPI_AGENT_ID: "env-only" } });
  writeProc(R6, { pid: 51, ppid: 1, comm: "pi", start: 900, rss: 10, env: { HYPRPI_AGENT_ID: "env-only" } });
  let m6 = 0;
  const s6 = new ProcSampler({ procRoot: R6, clockTicks: 100, pageSize: 4096, now: () => m6, fullScanEvery: 1000, selfPid: 77 });
  const own6 = [
    { id: "P", pids: [20], envIds: [] }, { id: "Q", pids: [30], envIds: [] }, { id: "TWO", pids: [40, 41], envIds: [] },
    { id: "ENV", pids: [], envIds: ["env-only"] }, { id: "NONE", pids: [], envIds: [] },
  ];
  const y1 = await s6.sample(own6);
  ok("A6 monitor on the first sample: pid + RSS, CPU unknown", y1.monitor.pid === 77 && y1.monitor.rssBytes === 500 * 4096 && y1.monitor.cpuPercent === null, y1.monitor);
  m6 += 2000; writeSystem(R6, { up: 1002 });
  writeProc(R6, { pid: 77, ppid: 1, comm: "node-MainThread", start: 100, utime: 12, rss: 600, argv: ["node", "/x/bin/hyprpi", "top"] });
  const y2 = await s6.sample(own6);
  ok("A6 monitor read fresh between full scans: CPU 1 %, RSS 600 pages", !y2.scan.full && y2.monitor.cpuPercent === 1 && y2.monitor.rssBytes === 600 * 4096, [y2.scan.full, y2.monitor]);
  ok("A6 an unrelated monitor stays out of processes and totals", !y2.processes.some((p) => p.pid === 77) && y2.totals.processCount === 8, y2.totals);
  const rp = (id) => [G(y2, id).piCount, G(y2, id).rootPiCount];
  ok("A6 rootPiCount: Pi root with a helper pi → piCount 2, rootPiCount 1", JSON.stringify(rp("P")) === "[2,1]", rp("P"));
  ok("A6 rootPiCount: Python proxy root → 0 (its pi child is not a root)", JSON.stringify(rp("Q")) === "[1,0]", rp("Q"));
  ok("A6 rootPiCount: two Pi roots → 2", JSON.stringify(rp("TWO")) === "[2,2]", rp("TWO"));
  ok("A6 rootPiCount without a live root uses the oldest member (sleep → 0)", JSON.stringify(rp("ENV")) === "[1,0]", rp("ENV"));
  ok("A6 rootPiCount of an empty owner is 0", G(y2, "NONE").rootPiCount === 0);
  ok("A6 main fixture: kitty root 0, pi root 1, bucket 1", G(r1, "id-A").rootPiCount === 0 && G(r1, "id-B").rootPiCount === 1 && r1.unattributed.every((u) => u.rootPiCount === 1));
  // a monitor that IS attributed (under an owner's root) counts there as normal and is still reported
  const s7 = new ProcSampler({ procRoot: R6, clockTicks: 100, pageSize: 4096, now: () => 0, selfPid: 21 });
  const z = await s7.sample(own6);
  ok("A6 an attributed monitor counts in its group and in monitor", G(z, "P").pids.includes(21) && z.monitor.pid === 21 && z.monitor.rssBytes === 10 * 4096);
  // getconf unavailable: refuse clearly instead of guessing CLK_TCK / PAGESIZE; injected values need no getconf
  const mod = new URL("../lib/top-proc.mjs", import.meta.url).href;
  const code = `import(${JSON.stringify(mod)}).then(({ProcSampler}) => { try { new ProcSampler(); console.log("NO-THROW"); } catch (e) { console.log("THREW " + e.message); } try { new ProcSampler({ clockTicks: 100, pageSize: 4096 }); console.log("INJECTED-OK"); } catch (e) { console.log("INJECTED-THREW " + e.message); } })`;
  const g = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { PATH: path.join(T, "no-bin") }, encoding: "utf8" });
  ok("A6 getconf missing → constructor throws a clear error", /THREW top-proc: getconf CLK_TCK failed .*pass clockTicks explicitly/.test(g.stdout), (g.stdout + g.stderr).trim().replace(/\n/g, " | "));
  ok("A6 injected clockTicks/pageSize need no getconf", /INJECTED-OK/.test(g.stdout), g.stdout.trim().replace(/\n/g, " | "));
}

// ---- A7) explicit unknown identities cannot fall through to a reused name; Unicode name-only markers work
{
  const R7 = mkRoot("identity-barrier"); writeSystem(R7);
  writeProc(R7, { pid: 200, ppid: 1, comm: "pi", env: { HYPRPI_AGENT_ID: "old-agent", HYPRPI_NAME: "ReusedName" } });
  writeProc(R7, { pid: 201, ppid: 200, comm: "sleep" });
  writeProc(R7, { pid: 202, ppid: 1, comm: "pi", env: { HYPRPI_AGENT_ID: "remote-old", HYPRPI_NAME: "ReusedName", HYPRPI_REMOTE_WORLD: "H" } });
  writeProc(R7, { pid: 203, ppid: 1, comm: "pi", env: { HYPRPI_NAME: "Éclair" } });
  writeProc(R7, { pid: 204, ppid: 1, comm: "pi", env: { HYPRPI_AGENT_ID: "current-agent", HYPRPI_NAME: "Éclair" } });
  writeProc(R7, { pid: 205, ppid: 1, comm: "pi", env: { HYPRPI_AGENT_ID: "current-agent", HYPRPI_REMOTE_WORLD: "H" } });
  const r = await new ProcSampler({ procRoot: R7, clockTicks: 100, pageSize: 4096, selfPid: 999 }).sample([
    { id: "current-agent", name: "ReusedName", world: "A", pids: [], envIds: ["current-agent"] },
    { id: "unicode-agent", name: "Éclair", world: "B", pids: [], envIds: [] },
    { id: "transport:H", name: "H transport", world: "H", pids: [], envIds: [], envWorld: "H", remote: true },
  ]);
  ok("A7 unknown explicit id blocks reused-name attribution and descendants", JSON.stringify(r.unattributed.find((u) => u.pids.includes(200))?.pids) === "[200,201]");
  ok("A7 known explicit id beats name and world markers", JSON.stringify(G(r, "current-agent").pids) === "[204,205]");
  ok("A7 unknown remote id can still identify aggregate world transport", JSON.stringify(G(r, "transport:H").pids) === "[202]");
  ok("A7 UTF-8 name-only identity matches the daemon's name", JSON.stringify(G(r, "unicode-agent").pids) === "[203]");
}

// ---- B) real /proc with our own tiny dummies
const kids = [];
try {
  const tag = "j557-" + process.pid;
  // every dummy gets its own process group (detached: pgid = its pid), so cleanup can signal exactly that group
  const root = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], { stdio: "ignore", detached: true }); kids.push(root);
  const busy = spawn("sh", ["-c", "i=0; while [ $i -lt 3000000 ]; do i=$((i+1)); done; sleep 30"], { stdio: "ignore", detached: true }); kids.push(busy);
  const det = spawn("sleep", ["30"], { stdio: "ignore", detached: true, env: { PATH: process.env.PATH, HYPRPI_AGENT_ID: tag } }); kids.push(det);
  await sleep(150);
  const owners = [{ id: "root", name: "Root" + tag, world: "T", pids: [root.pid], envIds: [] }, { id: "busy", name: "Busy" + tag, world: "T", pids: [busy.pid], envIds: [] }, { id: "det", name: "Det" + tag, world: "T", pids: [], envIds: [tag] }, { id: "nothing", name: "N" + tag, world: "T", pids: [], envIds: [] }];
  const s = new ProcSampler();
  ok("B getconf values fetched", s.clockTicks > 0 && s.pageSize > 0, [s.clockTicks, s.pageSize]);
  const b1 = await s.sample(owners);
  await sleep(500);
  const b2 = await s.sample(owners);
  ok("B real tree: sh + its two sleeps", G(b2, "root").processCount === 3 && G(b2, "root").pids.includes(root.pid), G(b2, "root"));
  ok("B real CPU: the busy shell loop shows CPU (>20 %)", G(b2, "busy").cpuPercent > 20, G(b2, "busy").cpuPercent);
  ok("B real detached HYPRPI_AGENT_ID match", JSON.stringify(G(b2, "det").pids) === JSON.stringify([det.pid]));
  ok("B real RSS > 0 and uptime ≥ 0", G(b2, "root").rssBytes > 0 && G(b2, "root").uptimeSeconds >= 0);
  ok("B real system numbers present", b2.system.cpuPercent != null && b2.system.cpuCores >= 1 && b2.system.memoryTotalBytes > 0 && b1.system.uptimeSeconds > 0);
  ok("B monitor = this test process, read fresh, with CPU and RSS", b2.monitor.pid === process.pid && b2.monitor.rssBytes > 0 && typeof b2.monitor.cpuPercent === "number", b2.monitor);
  ok("B owner with nothing: null metrics", G(b2, "nothing").rssBytes === null && G(b2, "nothing").processCount === 0);
  ok("B unrelated system processes excluded (pid 1, kernel threads)", !b2.processes.some((p) => p.pid === 1 || p.pid === 2 || p.ppid === 2));
  console.log(`info B: real scan saw ${b2.scan.processesSeen} processes, ${b2.unattributed.length} unattributed pi bucket(s), ${b2.processes.length} agent-related processes; limitations: ${b2.limitations.join(" | ") || "none"}`);
} finally {
  // Signal only the process groups we created (pgid = each dummy's own pid), never a broad pkill or our own
  // group; then wait for the leaders to close and check that nothing in those groups is left.
  const groups = kids.map((k) => k.pid).filter((p) => p > 0 && p !== process.pid);
  const closed = kids.map((k) => (k.exitCode !== null || k.signalCode !== null ? Promise.resolve() : new Promise((r) => k.once("close", r))));
  for (const g of groups) { try { process.kill(-g, "SIGTERM"); } catch {} }
  await Promise.race([Promise.all(closed), sleep(3000)]);
  const pgrpOf = (n) => { try { const t = fs.readFileSync(`/proc/${n}/stat`, "latin1"); return Number(t.slice(t.lastIndexOf(")") + 2).split(" ")[2]); } catch { return null; } };
  const leftIn = () => fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n) && groups.includes(pgrpOf(n)));
  let left = leftIn();
  for (let i = 0; left.length && i < 20; i++) { await sleep(100); left = leftIn(); }
  if (left.length) for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch {} }
  ok("B cleanup: no process left in the dummies' own process groups", left.length === 0, left.join(","));
}

// ---- C) cost on the real /proc at a 2 s cadence, with every live Pi process on this machine as an owner
// root (read-only), averaged over 15 samples so one periodic full scan is included.
{
  const probe = new ProcSampler();
  const p0 = await probe.sample([]);
  const realOwners = p0.unattributed.map((u, i) => ({ id: "o" + i, name: "o" + i, world: "T", pids: [Number(u.id.split(":")[1])], envIds: ["no-such-id-" + i] }));
  const s = new ProcSampler();
  let t = performance.now(); const u0 = process.cpuUsage();
  await s.sample(realOwners);
  const firstMs = performance.now() - t, firstCpu = process.cpuUsage(u0);
  const N = 15, u1 = process.cpuUsage(); t = performance.now();
  let last;
  for (let i = 0; i < N; i++) last = await s.sample(realOwners);
  const steadyMs = (performance.now() - t) / N, c = process.cpuUsage(u1), cpuMs = (c.user + c.system) / 1000 / N;
  const pct = (cpuMs / 2000) * 100;
  console.log(`info C: ${last.scan.processesSeen} processes, ${realOwners.length} owners, ${last.processes.length} attributed; first sample ${firstMs.toFixed(1)} ms wall / ${((firstCpu.user + firstCpu.system) / 1000).toFixed(1)} ms CPU; average of ${N} (incl. a full scan) ${steadyMs.toFixed(1)} ms wall / ${cpuMs.toFixed(1)} ms CPU per sample = ${pct.toFixed(2)} % of one CPU at 2 s`);
  ok("C average cost under 1 % of one CPU at a 2 s cadence", pct < 1, pct.toFixed(2) + " %");
}

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\nall ok");
process.exit(fails ? 1 : 0);
