// J557: read-only Linux process sampler for the hyprpi "top" view.
//
// ProcSampler reads /proc (or a synthetic procRoot in tests) and turns it into per-agent costs:
//   const s = new ProcSampler();            // CLK_TCK and PAGESIZE fetched once with getconf
//   await s.sample(owners);                 // first call primes; CPU is null until the second
//   await s.sample(owners);                 // CPU% over the interval since the previous call
//
// It never writes anything, signals, renices or launches agents/apps, and never exports a raw
// environment or command line: argv is only looked at to tell whether a process is the Pi CLI, and
// from the environment only HYPRPI_AGENT_ID, HYPRPI_NAME and HYPRPI_REMOTE_WORLD are kept (in a
// cache keyed by pid + start time + comm, dropped when the pid vanishes or is reused).
//
// Owners: [{ id, name, world, pids: [local root pids], envIds: [daemon ids], envWorld?: 'H', remote?: true }]
// Attribution, in order:
//   1. Tree: a process belongs to the nearest registered root among itself and its ancestors
//      (a nested child agent's root is nearer, so its costs are its own, never counted twice).
//   2. Detached (not under any root): nearest self-or-ancestor whose HYPRPI_AGENT_ID is one of an
//      owner's envIds, or whose HYPRPI_NAME is an owner name that is unique among the owners, or
//      whose HYPRPI_REMOTE_WORLD equals the envWorld of exactly one owner that declares envWorld.
//      An unknown HYPRPI_AGENT_ID blocks name matching and inheritance from above (it is some other
//      agent). An explicit matching remote-world marker may still identify its aggregate transport.
//   3. Unattributed: a recognisable Pi process (comm "pi", or node/bun running the Pi CLI) that is
//      still unowned starts a bucket; its unowned descendants join the nearest such bucket.
//   Everything else (unrelated system processes) is left out of groups, buckets and totals.
//
// Units: CPU% = Δ(utime+stime) / (elapsed monotonic s × CLK_TCK) × 100, so 100% = one logical CPU
// (cutime/cstime never counted). System CPU is 0-100 over all CPUs. RSS = stat resident pages ×
// PAGESIZE; sums of RSS count shared pages (libraries, shared memory) once per process, so a group's
// RSS is an upper bound of what it alone holds. Unknown values are null.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ENV_KEYS = ["HYPRPI_AGENT_ID", "HYPRPI_NAME", "HYPRPI_REMOTE_WORLD"];
const RUNTIME_COMMS = new Set(["node", "node-MainThread", "nodejs", "bun", "MainThread"]);
const RUNTIME_BINS = new Set(["node", "nodejs", "bun"]);
const PI_SCRIPT = /(?:^|\/)pi(?:\.m?js)?$|(?:^|\/)pi(?:-coding-agent)?\/dist\/(?:bundle\/)?(?:cli|rpc-entry)\.m?js$|\/pi-coding-agent\/.*(?:cli|rpc-entry)\.m?js$/;

// No silent guess: when getconf can't answer, the sampler refuses to start (tests inject the values).
function getconf(name) {
  let out = "";
  try { out = execFileSync("getconf", [name], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (e) { throw new Error(`top-proc: getconf ${name} failed (${e.code || e.message}); pass ${name === "CLK_TCK" ? "clockTicks" : "pageSize"} explicitly`); }
  const v = Number(out);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`top-proc: getconf ${name} gave ${JSON.stringify(out)}; pass ${name === "CLK_TCK" ? "clockTicks" : "pageSize"} explicitly`);
  return v;
}

const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// Parse /proc/<pid>/stat. comm is between the first "(" and the LAST ")" (it may hold spaces and parens).
export function parseStat(text) {
  const open = text.indexOf("("), close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  // Walk the space-separated fields after ")" without splitting them all. Field 3 (state) starts at close+2.
  const want = { 3: "state", 4: "ppid", 14: "utime", 15: "stime", 22: "start", 24: "rss" };
  const v = {};
  let field = 3, i = close + 2, got = 0;
  while (i < text.length && got < 6) {
    let j = text.indexOf(" ", i);
    if (j < 0) j = text.length;
    const k = want[field];
    if (k) { v[k] = text.slice(i, j); got++; }
    field++; i = j + 1;
  }
  const ppid = Number(v.ppid), utime = Number(v.utime), stime = Number(v.stime), startTicks = Number(v.start), rssPages = v.rss == null ? NaN : Number(v.rss);
  if (!Number.isFinite(pid) || v.ppid == null || !Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime) || v.start == null || !Number.isFinite(startTicks)) return null;
  return { pid, comm, state: v.state, ppid, ticks: utime + stime, startTicks, rssPages: Number.isFinite(rssPages) && rssPages >= 0 ? rssPages : null };
}

// Is this argv the Pi CLI? Only argv[0] and the first non-flag argument are looked at; nothing is kept.
export function isPiArgv(argv) {
  if (!argv || !argv.length) return false;
  const a0 = argv[0], base0 = path.basename(a0);
  if (base0 === "pi") return true;
  if (!RUNTIME_BINS.has(base0) && !/^node\d*$/.test(base0)) return false;
  for (let i = 1; i < argv.length && i < 8; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") return false; // inline code, not a CLI script
    if (a.startsWith("-")) { if (a === "-r" || a === "--require" || a === "--import" || a === "--loader") i++; continue; }
    return PI_SCRIPT.test(a);
  }
  return false;
}

function readText(file) { return fs.readFileSync(file, "latin1"); }

function errKind(e) {
  const c = e && e.code;
  if (c === "EACCES" || c === "EPERM") return "denied";
  return "gone"; // ENOENT, ESRCH, empty/garbled read: the process exited or was replaced mid-scan
}

export class ProcSampler {
  constructor({ procRoot = "/proc", clockTicks, pageSize, now, fullScanEvery = 15, youngSeconds = 10, selfPid } = {}) {
    this.fullScanEvery = fullScanEvery; // samples between full stat scans (15 × 2 s = 30 s)
    this.youngSeconds = youngSeconds; // processes younger than this are always re-read (exec changes comm)
    this.procRoot = procRoot;
    this.clockTicks = clockTicks > 0 ? clockTicks : getconf("CLK_TCK");
    this.pageSize = pageSize > 0 ? pageSize : getconf("PAGESIZE");
    this.selfPid = Number.isInteger(selfPid) && selfPid > 0 ? selfPid : process.pid; // the monitor process itself
    this.now = typeof now === "function" ? now : () => performance.now(); // monotonic ms (test seam)
    this.meta = new Map(); // pid -> { startTicks, comm, pi?, env? } identity cache
    this.buf = Buffer.allocUnsafe(4096);
    this.prev = null; // { mono, uptime, procs: Map pid -> { startTicks, ticks }, cpu: {busy,total} }
  }

  // open/read/close into one shared buffer: cheaper than readFileSync's fstat + growing reads on /proc
  _readStat(n) {
    const fd = fs.openSync(this._p(n, "stat"), "r");
    try {
      const k = fs.readSync(fd, this.buf, 0, this.buf.length, 0);
      if (k < this.buf.length) return this.buf.latin1Slice(0, k);
    } finally { fs.closeSync(fd); }
    return readText(this._p(n, "stat"));
  }

  _p(...parts) { return path.join(this.procRoot, ...parts.map(String)); }

  _system() {
    const sys = { cpuPercent: null, cpuCores: null, loadAverage: null, uptimeSeconds: null, memoryTotalBytes: null, memoryAvailableBytes: null, swapTotalBytes: null, swapUsedBytes: null };
    let cpu = null;
    try {
      const lines = readText(this._p("stat")).split("\n");
      let cores = 0;
      for (const l of lines) {
        if (l.startsWith("cpu ")) {
          const v = l.trim().split(/\s+/).slice(1).map(Number);
          // user nice system idle iowait irq softirq steal (guest is already inside user/nice)
          const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
          const total = user + nice + system + idle + iowait + irq + softirq + steal;
          cpu = { busy: total - idle - iowait, total };
        } else if (/^cpu\d+ /.test(l)) cores++;
      }
      sys.cpuCores = cores || null;
    } catch {}
    try {
      const la = readText(this._p("loadavg")).trim().split(/\s+/).slice(0, 3).map(Number);
      if (la.length === 3 && la.every(Number.isFinite)) sys.loadAverage = la;
    } catch {}
    try {
      const up = Number(readText(this._p("uptime")).trim().split(/\s+/)[0]);
      if (Number.isFinite(up)) sys.uptimeSeconds = up;
    } catch {}
    try {
      const m = {};
      for (const l of readText(this._p("meminfo")).split("\n")) {
        const r = /^(\w+(?:\([^)]*\))?):\s+(\d+)(?:\s+kB)?/.exec(l);
        if (r) m[r[1]] = Number(r[2]) * 1024;
      }
      if (m.MemTotal != null) sys.memoryTotalBytes = m.MemTotal;
      if (m.MemAvailable != null) sys.memoryAvailableBytes = m.MemAvailable;
      if (m.SwapTotal != null) sys.swapTotalBytes = m.SwapTotal;
      if (m.SwapTotal != null && m.SwapFree != null) sys.swapUsedBytes = m.SwapTotal - m.SwapFree;
    } catch {}
    return { sys, cpu };
  }

  // Identity metadata for a live process, cached by pid + startTicks + comm (an exec changes comm).
  _metaFor(rec) {
    let m = this.meta.get(rec.pid);
    if (!m || m.startTicks !== rec.startTicks || m.comm !== rec.comm) {
      m = { startTicks: rec.startTicks, comm: rec.comm };
      this.meta.set(rec.pid, m);
    }
    return m;
  }

  _isPi(rec) {
    const m = this._metaFor(rec);
    if (m.pi === undefined) {
      if (rec.comm === "pi") m.pi = true;
      else if (RUNTIME_COMMS.has(rec.comm) || /^node/.test(rec.comm) || rec.comm === "bun") {
        try {
          const raw = readText(this._p(rec.pid, "cmdline"));
          // Only the first few argv entries are split out; the rest (prompts, flags) is never looked at.
          const argv = raw.slice(0, 4096).split("\0").slice(0, 8);
          m.pi = isPiArgv(argv);
        } catch (e) { m.pi = false; m.piUnknown = errKind(e); }
      } else m.pi = false;
    }
    return m.pi;
  }

  // Whitelisted HYPRPI_* fields of a process's environment, or null when unreadable.
  _envFor(rec) {
    const m = this._metaFor(rec);
    if (m.env === undefined) {
      if (rec.pid <= 2 || rec.ppid === 2) { m.env = {}; return m.env; } // init / kernel threads
      try {
        const raw = fs.readFileSync(this._p(rec.pid, "environ"), "utf8");
        const env = {};
        for (const k of ENV_KEYS) {
          const at = raw.startsWith(k + "=") ? 0 : raw.indexOf("\0" + k + "=");
          if (at < 0) continue;
          const s = at === 0 ? k.length + 1 : at + k.length + 2;
          const e = raw.indexOf("\0", s);
          env[k] = raw.slice(s, e < 0 ? raw.length : e).slice(0, 200);
        }
        m.env = env;
      } catch (e) { m.env = null; m.envError = errKind(e); }
    }
    return m.env;
  }

  async sample(owners = []) {
    const mono = this.now();
    const timestampMs = Date.now();
    const limitations = [];
    const { sys, cpu: sysCpu } = this._system();
    const prev = this.prev;
    const elapsed = prev ? (mono - prev.mono) / 1000 : null;
    const intervalSeconds = elapsed != null && elapsed > 0 ? elapsed : null;
    if (prev && sysCpu && prev.cpu) {
      const dt = sysCpu.total - prev.cpu.total, db = sysCpu.busy - prev.cpu.busy;
      if (dt > 0 && db >= 0) sys.cpuPercent = round2(Math.min(100, (db / dt) * 100));
    }

    // ---- owners
    const ownerList = [];
    const ownerById = new Map();
    for (const o of Array.isArray(owners) ? owners : []) {
      if (!o || o.id == null || ownerById.has(String(o.id))) continue;
      const ow = { id: String(o.id), name: o.name ?? null, world: o.world ?? null, roots: [], envIds: (o.envIds || []).map(String), envWorld: o.envWorld ?? null, remote: !!o.remote };
      for (const p of o.pids || []) { const n = Number(p); if (Number.isInteger(n) && n > 0) ow.roots.push(n); }
      ownerList.push(ow); ownerById.set(ow.id, ow);
    }
    // ---- scan. A full scan reads every /proc/<pid>/stat. In between, a process that was unrelated last
    // time (not under any owner, not a Pi bucket), is older than youngSeconds and still listed keeps its
    // cached record: an unrelated process can't become an agent's descendant without a pid change or an
    // owners change (both trigger a read). New, young, related and root pids are always read fresh.
    const sig = JSON.stringify(ownerList.map((o) => [o.id, o.name, o.roots, o.envIds, o.envWorld]));
    this.sampleNo = (this.sampleNo || 0) + 1;
    const full = !prev || sig !== this.ownerSig || this.fullScanEvery <= 1 || this.sampleNo % this.fullScanEvery === 0;
    this.ownerSig = sig;
    const known = prev ? prev.records : new Map();
    const related = prev ? prev.related : new Set();
    const rootPids = new Set(ownerList.flatMap((o) => o.roots));
    rootPids.add(this.selfPid); // always read fresh: frame.monitor
    const fresh = new Set(); // pids whose stat was read in this sample
    const procs = new Map();
    let names = [];
    try { names = fs.readdirSync(this.procRoot); } catch (e) { limitations.push(`cannot list ${this.procRoot}: ${e.code || e.message}`); }
    let denied = 0, gone = 0, reused = 0;
    const youngTicks = sys.uptimeSeconds == null ? Infinity : (sys.uptimeSeconds - this.youngSeconds) * this.clockTicks;
    for (const n of names) {
      const c = n.charCodeAt(0);
      if (c < 48 || c > 57) continue;
      const pid = Number(n);
      if (!Number.isInteger(pid)) continue;
      const old = known.get(pid);
      if (!full && old && !related.has(pid) && !rootPids.has(pid) && old.startTicks < youngTicks) { procs.set(pid, old); reused++; continue; }
      let rec = null;
      try { rec = parseStat(this._readStat(n)); } catch (e) { if (errKind(e) === "denied") denied++; else gone++; continue; }
      if (!rec || rec.pid !== pid) { gone++; continue; }
      procs.set(pid, rec); fresh.add(pid);
    }
    // forget identity metadata of vanished or reused pids
    for (const [pid, m] of this.meta) { const r = procs.get(pid); if (!r || r.startTicks !== m.startTicks) this.meta.delete(pid); }
    if (denied) limitations.push(`${denied} process(es) unreadable (permission): not counted`);

    const rootOwner = new Map();
    for (const ow of ownerList) for (const p of ow.roots) {
      if (!procs.has(p)) continue;
      if (rootOwner.has(p) && rootOwner.get(p) !== ow.id) { limitations.push(`pid ${p} given as a root of both ${rootOwner.get(p)} and ${ow.id}: counted for ${rootOwner.get(p)}`); continue; }
      rootOwner.set(p, ow.id);
    }
    const missingRoots = ownerList.filter((ow) => ow.roots.length && !ow.roots.some((p) => procs.has(p)));
    if (missingRoots.length) limitations.push(`no live local process for the root pid(s) of ${missingRoots.map((o) => o.id).join(", ")}`);
    const byEnvId = new Map();
    for (const ow of ownerList) for (const e of ow.envIds) if (!byEnvId.has(e)) byEnvId.set(e, ow.id);
    const nameCount = new Map();
    for (const ow of ownerList) if (ow.name) nameCount.set(ow.name, (nameCount.get(ow.name) || 0) + 1);
    const byName = new Map();
    for (const ow of ownerList) if (ow.name && nameCount.get(ow.name) === 1) byName.set(ow.name, ow.id);
    const worldCount = new Map();
    for (const ow of ownerList) if (ow.envWorld) worldCount.set(ow.envWorld, (worldCount.get(ow.envWorld) || 0) + 1);
    const byWorld = new Map();
    for (const ow of ownerList) if (ow.envWorld && worldCount.get(ow.envWorld) === 1) byWorld.set(ow.envWorld, ow.id);
    for (const [w, n] of worldCount) if (n > 1) limitations.push(`${n} owners declare envWorld ${w}: HYPRPI_REMOTE_WORLD=${w} processes left unattributed`);

    // ---- attribution: 1) tree to nearest registered root
    const NONE = null;
    const treeOf = new Map(); // pid -> ownerId | null
    const walk = (pid, resolveSelf) => {
      // iterative nearest-ancestor resolution with memo
      const chain = [];
      let cur = pid, res = NONE, guard = 0;
      while (cur != null && guard++ < 4096) {
        if (treeOf.has(cur)) { res = treeOf.get(cur); break; }
        const r = resolveSelf(cur);
        if (r !== undefined) { res = r; chain.push(cur); break; }
        chain.push(cur);
        const rec = procs.get(cur);
        const pp = rec ? rec.ppid : null;
        cur = pp && pp !== cur && procs.has(pp) ? pp : null;
      }
      for (const p of chain) treeOf.set(p, res);
      return res;
    };
    // resolveSelf returns ownerId when the process itself is a root, undefined to keep climbing
    for (const pid of procs.keys()) walk(pid, (p) => (rootOwner.has(p) ? rootOwner.get(p) : undefined));
    const owner = new Map(); // pid -> { kind, id }
    for (const [pid, id] of treeOf) if (id != null) owner.set(pid, { kind: "owner", id });

    // 2) detached: whitelisted env fields
    let envDenied = 0;
    const envOf = new Map(); // pid -> ownerId | null (memo for unowned chains)
    const envSelf = (rec) => {
      const env = this._envFor(rec);
      if (env === null) { envDenied++; return undefined; }
      const aid = env.HYPRPI_AGENT_ID;
      if (aid) {
        if (byEnvId.has(aid)) return byEnvId.get(aid);
        // A name can be reused after an agent exits; it must not override an explicit unknown identity.
        // The remote-world marker identifies a transport bucket, not another agent with that name.
        if (env.HYPRPI_REMOTE_WORLD && byWorld.has(env.HYPRPI_REMOTE_WORLD)) return byWorld.get(env.HYPRPI_REMOTE_WORLD);
        return null;
      }
      if (env.HYPRPI_NAME && byName.has(env.HYPRPI_NAME)) return byName.get(env.HYPRPI_NAME);
      if (env.HYPRPI_REMOTE_WORLD && byWorld.has(env.HYPRPI_REMOTE_WORLD)) return byWorld.get(env.HYPRPI_REMOTE_WORLD);
      return undefined;
    };
    if (byEnvId.size || byName.size || byWorld.size) {
      for (const [pid, rec] of procs) {
        if (owner.has(pid)) continue;
        const chain = [];
        let cur = pid, res = null, guard = 0;
        while (cur != null && guard++ < 4096) {
          if (envOf.has(cur)) { res = envOf.get(cur); break; }
          if (owner.has(cur)) { res = null; break; } // cannot happen (children of owned are owned)
          const r = envSelf(procs.get(cur));
          chain.push(cur);
          if (r !== undefined) { res = r; break; }
          const pp = procs.get(cur).ppid;
          cur = pp && pp !== cur && procs.has(pp) ? pp : null;
        }
        for (const p of chain) envOf.set(p, res);
        if (res != null) owner.set(pid, { kind: "owner", id: res });
      }
      if (envDenied) limitations.push(`environment unreadable for ${envDenied} unowned process(es) (usually other users' or system processes): detached attribution cannot see them`);
    }

    // 3) unattributed Pi buckets
    const bucketOf = new Map();
    for (const pid of procs.keys()) {
      if (owner.has(pid)) continue;
      const chain = [];
      let cur = pid, res = null, guard = 0;
      while (cur != null && guard++ < 4096) {
        if (bucketOf.has(cur)) { res = bucketOf.get(cur); break; }
        if (owner.has(cur)) break;
        chain.push(cur);
        if (this._isPi(procs.get(cur))) { res = cur; break; }
        const pp = procs.get(cur).ppid;
        cur = pp && pp !== cur && procs.has(pp) ? pp : null;
      }
      for (const p of chain) bucketOf.set(p, res);
      if (res != null) owner.set(pid, { kind: "bucket", root: res });
    }

    // ---- per-process numbers
    const clk = this.clockTicks, up = sys.uptimeSeconds;
    const nextPrev = new Map();
    for (const pid of fresh) { const rec = procs.get(pid); nextPrev.set(pid, { startTicks: rec.startTicks, ticks: rec.ticks }); }
    let cpuUnknown = 0;
    const cpuOf = (rec) => {
      if (!intervalSeconds) return null;
      const p = prev.procs.get(rec.pid);
      let d = null;
      if (p && p.startTicks === rec.startTicks) d = rec.ticks - p.ticks;
      else if (prev.uptime != null && rec.startTicks / clk >= prev.uptime) d = rec.ticks; // born during the interval
      if (d == null || d < 0) { cpuUnknown++; return null; }
      return round2((d / (intervalSeconds * clk)) * 100);
    };
    const uptimeOf = (rec) => (up == null ? null : round2(Math.max(0, up - rec.startTicks / clk)));
    const bucketId = (root) => `unattributed:${root}:${procs.get(root).startTicks}`;

    const processes = [];
    const members = new Map(); // groupId -> [process rows]
    for (const [pid, a] of owner) {
      const rec = procs.get(pid);
      const gid = a.kind === "owner" ? a.id : bucketId(a.root);
      const row = { pid, ppid: rec.ppid, startTicks: rec.startTicks, comm: rec.comm, cpuPercent: cpuOf(rec), rssBytes: rec.rssPages == null ? null : rec.rssPages * this.pageSize, uptimeSeconds: uptimeOf(rec), ownerId: gid, agentLike: this._isPi(rec) };
      processes.push(row);
      if (!members.has(gid)) members.set(gid, []);
      members.get(gid).push(row);
    }
    processes.sort((a, b) => a.pid - b.pid);
    if (cpuUnknown) limitations.push(`CPU unknown for ${cpuUnknown} process(es) not seen in the previous sample: left out of sums`);

    const sumOrNull = (rows, k) => { let s = 0, n = 0; for (const r of rows) if (r[k] != null) { s += r[k]; n++; } return n ? s : null; };
    const aggregate = (rows, primaryPids) => {
      if (!rows.length) return { cpuPercent: null, rssBytes: null, uptimeSeconds: null, processCount: 0, piCount: 0, rootPiCount: 0, pids: [] };
      let primary = null;
      for (const p of primaryPids) { primary = rows.find((r) => r.pid === p); if (primary) break; }
      if (!primary) primary = rows.reduce((o, r) => (r.startTicks < o.startTicks ? r : o));
      // Pi processes among the group's live root pids (or the oldest member when no root is live), so a
      // helper count can subtract the agents' own Pi rather than a blind 1 (a proxy root may be Python).
      const rootSet = new Set(primaryPids);
      const liveRoots = rows.filter((r) => rootSet.has(r.pid));
      const rootPiCount = (liveRoots.length ? liveRoots : [primary]).filter((r) => r.agentLike).length;
      return {
        cpuPercent: round2(sumOrNull(rows, "cpuPercent")),
        rssBytes: sumOrNull(rows, "rssBytes"),
        uptimeSeconds: primary.uptimeSeconds,
        processCount: rows.length,
        piCount: rows.filter((r) => r.agentLike).length,
        rootPiCount,
        pids: rows.map((r) => r.pid).sort((a, b) => a - b),
      };
    };
    const groups = ownerList.map((ow) => ({ id: ow.id, ...aggregate(members.get(ow.id) || [], ow.roots) }));
    const unattributed = [];
    for (const [gid, rows] of members) {
      if (!gid.startsWith("unattributed:")) continue;
      const root = Number(gid.split(":")[1]);
      const env = this._envFor(procs.get(root)) || {};
      const label = env.HYPRPI_NAME || env.HYPRPI_AGENT_ID || null;
      unattributed.push({ id: gid, name: label ? `${label} (pid ${root}, not registered)` : `pi (pid ${root})`, ...aggregate(rows, [root]) });
    }
    unattributed.sort((a, b) => (b.rssBytes || 0) - (a.rssBytes || 0));
    const all = [...groups, ...unattributed];
    const totals = {
      cpuPercent: round2(sumOrNull(all, "cpuPercent")),
      rssBytes: sumOrNull(all, "rssBytes"),
      processCount: processes.length,
    };
    if (ownerList.some((o) => o.remote)) limitations.push("remote owners: only their local processes (ssh/proxy roots, HYPRPI_REMOTE_WORLD) are counted, not the remote machine");
    if (!prev) limitations.push("first sample: CPU unknown until the next sample");

    this.prev = { mono, uptime: up, procs: nextPrev, cpu: sysCpu, records: procs, related: new Set(owner.keys()) };
    // the monitor's own process (read fresh every sample), apart from the agent totals
    const selfRec = procs.get(this.selfPid);
    let monitorCpu = null;
    if (selfRec && intervalSeconds && fresh.has(this.selfPid)) {
      const p = prev.procs.get(this.selfPid);
      if (p && p.startTicks === selfRec.startTicks && selfRec.ticks >= p.ticks) monitorCpu = round2(((selfRec.ticks - p.ticks) / (intervalSeconds * clk)) * 100);
    }
    const monitor = { pid: this.selfPid, cpuPercent: monitorCpu, rssBytes: selfRec && selfRec.rssPages != null ? selfRec.rssPages * this.pageSize : null };
    return { timestampMs, intervalSeconds: round2(intervalSeconds), system: sys, totals, groups, unattributed, processes, monitor, limitations, scan: { full, processesSeen: procs.size, statsRead: fresh.size, cachedUnrelated: reused, unreadable: denied, vanished: gone } };
  }
}

export default ProcSampler;
