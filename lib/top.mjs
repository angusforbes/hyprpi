// J557: agent/process snapshot (no ensureDaemon, no model calls). J564: in the live view, Enter focuses the highlighted row's window
// and x closes it after a y/N confirm (lib/top-actions.mjs); --once / --json only report.
import readline from "node:readline";
import { performance } from "node:perf_hooks";
import { request } from "./client.mjs";
import { stateDir } from "./paths.mjs";

export const SORTS = ["cpu", "mem", "uptime", "priority"];
export function parseTopArgs(args) {
  const opts = { once: false, json: false, interval: 2, sort: "cpu", samples: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--once") opts.once = true;
    else if (a === "--json") opts.json = true;
    else if (["--sort", "--interval", "--samples"].includes(a)) {
      const value = args[++i];
      if (value == null || value.startsWith("--")) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = a === "--sort" ? value : Number(value);
    } else throw new Error(`unknown top option: ${a}`);
  }
  if (!SORTS.includes(opts.sort)) throw new Error("--sort must be cpu, mem, uptime or priority");
  if (!Number.isFinite(opts.interval) || opts.interval < 0.5 || opts.interval > 60) throw new Error("--interval must be 0.5..60 seconds");
  if (opts.samples !== null && (!Number.isSafeInteger(opts.samples) || opts.samples < 1 || opts.samples > 10000)) throw new Error("--samples must be 1..10000");
  if (opts.once && opts.samples !== null && opts.samples !== 1) throw new Error("--once conflicts with --samples greater than 1");
  return opts;
}

// Daemon/user text is data, never terminal control: remove complete OSC/DCS sequences, ESC and control bytes.
export function plain(value) {
  return String(value ?? "").replace(/(?:\x1b[\]P_^X]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}
export const jsonLine = (value) => JSON.stringify(value).replace(/[\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const known = (n) => typeof n === "number" && Number.isFinite(n);
export function amount(n, bytes = false) {
  if (!known(n)) return "?";
  const base = bytes ? 1024 : 1000, units = bytes ? ["", "K", "M", "G", "T"] : ["", "k", "m", "b"];
  let i = 0; while (Math.abs(n) >= base && i < units.length - 1) { n /= base; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : Math.round(n)}${units[i]}`;
}
export function age(seconds) {
  if (!known(seconds) || seconds < 0) return "?";
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)}d`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds)}s`;
}
const pct = (n) => known(n) ? n.toFixed(1) : "?";
export function contextCell(a) {
  const p = known(a.contextTokens) && known(a.contextWindow) && a.contextWindow > 0 ? a.contextTokens / a.contextWindow * 100 : null;
  const filled = known(p) ? Math.max(0, Math.min(5, Math.round(p / 20))) : 0;
  const bar = known(p) ? "#".repeat(filled) + "-".repeat(5 - filled) : "?????";
  return `${amount(a.contextTokens)}/${amount(a.contextWindow)} ${known(p) ? Math.round(p) : "?"}% [${bar}]`;
}
const metric = { cpu: "cpuPercent", mem: "rssBytes", uptime: "uptimeSeconds", priority: "priority" };
export function sortedAgents(agents, sort = "cpu") {
  return [...agents].sort((a, b) => String(a.world || "Unattributed").localeCompare(String(b.world || "Unattributed"), undefined, { numeric: true })
    || (known(b[metric[sort]]) ? b[metric[sort]] : -1) - (known(a[metric[sort]]) ? a[metric[sort]] : -1)
    || String(a.name || a.id).localeCompare(String(b.name || b.id)));
}
// Fixed ASCII table widths; non-ASCII glyphs use a one-cell placeholder. JSON retains full Unicode identities.
const field = (v, width) => { const s = plain(v).replace(/[^\x20-\x7e]/g, "?"); return (s.length > width ? s.slice(0, width - 1) + "~" : s).padEnd(width); };
const columns = [
  ["AGENT", 21, (a) => (a.name || a.id) + (a.kind === "sandbox" ? " [proxy]" : "")], ["STATE", 8, (a) => a.status || "?"],
  ["CPU%", 7, (a) => pct(a.cpuPercent)], ["RSS", 7, (a) => amount(a.rssBytes, true)],
  ["UPTIME", 7, (a) => age(a.uptimeSeconds)], ["H/P", 6, (a) => `${a.helpers ?? "?"}/${a.processCount ?? "?"}`],
  ["PRI", 4, (a) => known(a.priority) ? Math.round(a.priority) : "?"], ["CTX TOK/WIN % BAR", 29, contextCell],
  ["CMP", 4, (a) => a.compactions ?? "?"], ["SESSION", 7, (a) => age(a.sessionAgeSeconds)],
  ["RST/RF", 7, (a) => `${a.restarts ?? "?"}/${a.refreshes ?? "?"}`], ["DUE", 4, (a) => a.refreshDue === true ? "yes" : a.refreshDue === false ? "no" : "?"],
  ["BUDGET", 13, (a) => a.budgetLimit == null ? "-" : `${amount(a.budgetUsed)}/${amount(a.budgetLimit)}`],
  ["MODEL", 24, (a) => a.model ? a.model.split("/").at(-1) : "?"], ["JOB / TOPIC", 35, (a) => [a.job, a.topic].filter(Boolean).join(" ") || (a.remote ? "remote: laptop-side cost only" : "")],
];
// J564 v2: the rows that aren't hyprpi agents are shown as "Other agents" (JSON keeps world "Unattributed" and adds tool, cwd, terminal).
const worldTitle = (w) => w === "Unattributed" ? "Other agents (not hyprpi: pi, Claude Code, Codex, Gemini CLI, aider, ...)" : w;
export function renderTop(snapshot, { sort = "cpu" } = {}) {
  const s = snapshot.system, t = snapshot.totals;
  const used = known(s.memoryTotalBytes) && known(s.memoryAvailableBytes) ? s.memoryTotalBytes - s.memoryAvailableBytes : null;
  const lines = [
    `hyprpi top | ${snapshot.sampledAt} | ${s.cpuCores ?? "?"} CPUs | load ${(s.loadAverage || []).map(pct).join(" / ")} | host CPU ${pct(s.cpuPercent)}%`,
    `RAM ${amount(used, true)}/${amount(s.memoryTotalBytes, true)} (available ${amount(s.memoryAvailableBytes, true)}) | swap ${amount(s.swapUsedBytes, true)}/${amount(s.swapTotalBytes, true)}`,
    `Observed agent trees: ${pct(t.cpuPercent)}% CPU (${s.cpuCores && known(t.cpuPercent) ? pct(t.cpuPercent / s.cpuCores) : "?"}% machine), RSS sum ${amount(t.rssBytes, true)}, ${t.processCount ?? "?"} processes | monitor ${pct(snapshot.monitor?.cpuPercent)}% CPU, sample ${snapshot.monitor?.sampleMs?.toFixed(0) ?? "?"}ms`,
    `CPU interval ${snapshot.intervalSeconds?.toFixed(2) ?? "?"}s; 100%=one CPU. RSS sums shared pages; CTX=reported measurement; ?=unavailable. Sort ${sort} within each world.`,
  ];
  for (const warning of (snapshot.warnings || []).slice(0, 3)) lines.push(`! ${plain(warning)}`);
  if (snapshot.warnings?.length > 3) lines.push(`! ${snapshot.warnings.length - 3} more source limitations; --json includes the complete warnings.`);
  let world = null;
  const rowKeys = new Map(); // line index -> agent id
  for (const a of sortedAgents(snapshot.agents, sort)) {
    const w = a.world || "Unattributed";
    if (w !== world) {
      world = w;
      const peers = snapshot.agents.filter((x) => (x.world || "Unattributed") === w);
      lines.push("", `[${plain(worldTitle(w))}] ${peers.length} row${peers.length === 1 ? "" : "s"}${peers.some((x) => x.remote) ? " | remote: laptop clients/transport only" : ""}`);
      lines.push(columns.map(([name, width]) => field(name, width)).join(" "));
    }
    rowKeys.set(lines.length, a.id); // J564: which agent each table line is (the TUI's highlight and actions)
    lines.push(columns.map(([, width, get]) => field(get(a), width)).join(" "));
  }
  if (!snapshot.agents.length) lines.push("No listed or unattributed agent processes.");
  lines.push("", "Keys: up/down or j/k move the highlight | PgUp/PgDn Home/End | Enter focus its window | x or Del close it (asks first) | c CPU m memory u uptime p priority | left/right pan | q quit");
  lines.push("PRI is an activity/coordination heuristic, not OS scheduling priority. H/P=helpers/processes; CMP=compactions; RST/RF=observed restarts/upkeep refreshes; budget=fresh tokens.");
  lines.rowKeys = rowKeys;
  return lines;
}

export function assembleSnapshot(metadata, frame, sampleMs = 0) {
  const groups = new Map(frame.groups.map((g) => [g.id, g]));
  const agents = metadata.agents.map((a) => {
    const g = groups.get(a.id);
    const inferredHelpers = g ? Math.max(0, (g.piCount || 0) - (g.rootPiCount ?? 1)) : 0;
    const helpers = a.helpers == null && a.inProcessHelpers == null && inferredHelpers === 0 ? null
      : Array.isArray(a.registeredHelpers) ? a.registeredHelpers.length + Math.max(a.inProcessHelpers || 0, inferredHelpers) : Math.max(a.helpers || 0, inferredHelpers);
    return { ...a, cpuPercent: g?.cpuPercent ?? null, rssBytes: g?.rssBytes ?? null, uptimeSeconds: g?.uptimeSeconds ?? null,
      processCount: g?.processCount ?? 0, rootPids: a.pids || [], pids: g?.pids || [], pidStarts: g?.pidStarts || {}, helpers };
  });
  for (const g of frame.unattributed || []) agents.push({ ...g, name: g.name || g.id, world: "Unattributed", status: "?", model: "", priority: null,
    helpers: Math.max(0, (g.piCount || 0) - 1), contextTokens: null, contextWindow: null, compactions: null, sessionAgeSeconds: null,
    restarts: null, refreshes: null, refreshDue: null, budgetUsed: null, budgetLimit: null, kind: "other", rootPids: g.rootPid ? [g.rootPid] : [],
    topic: [g.cwd, g.terminal ? `in ${g.terminal}` : ""].filter(Boolean).join(" ") || "no authoritative owner" }); // J564 v2: an "Other agents" row (tool, folder, terminal)
  const me = frame.monitor || frame.processes?.find((p) => p.pid === process.pid);
  return { schemaVersion: 1, authoritative: metadata.authoritative !== false, sampledAt: new Date(frame.timestampMs ?? Date.now()).toISOString(), intervalSeconds: frame.intervalSeconds,
    system: frame.system, totals: frame.totals, agents, worlds: metadata.worlds || [], sampling: frame.scan,
    warnings: [...(metadata.warnings || []), ...(frame.warnings || frame.limitations || [])],
    priorityFormula: metadata.priorityFormula, monitor: { pid: process.pid, cpuPercent: me?.cpuPercent ?? null, rssBytes: me?.rssBytes ?? null, sampleMs } };
}

export async function runTop(args, deps = {}) {
  const opts = parseTopArgs(args), stdout = deps.stdout || process.stdout, stdin = deps.stdin || process.stdin;
  const interactive = !!(stdout.isTTY && stdin.isTTY && !opts.once && !opts.json);
  const limit = opts.once ? 1 : opts.samples ?? (interactive ? Infinity : 1);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const telemetry = deps.telemetry || (await import("./top-telemetry.mjs")).createTelemetryReader({ request: (method, params) => request(method, params, { timeout: 1500, timeoutMs: 3000 }), statePath: stateDir() });
  const sampler = deps.sampler || new (await import("./top-proc.mjs")).ProcSampler();
  let quit = false, sort = opts.sort, vertical = 0, horizontal = 0, snapshot = null;
  // J564: the highlighted row (by agent id, so it stays on the same agent across refreshes and re-sorts), and the footer's
  // mode: a confirm for a close (its target fixed at the moment x was pressed), a second confirm for SIGKILL, or a message.
  const act = deps.actions || await import("./top-actions.mjs");
  const req = deps.request || ((method, params) => request(method, params, { timeout: 1500, timeoutMs: 5000 }));
  let selId = null, selLine = 0, mode = null, msg = "", msgUntil = 0;
  const names = new Map(), closedIds = new Set(); // id -> name (for "X is gone"); ids closed from here
  const say = (t, ms = 6000) => { msg = t; msgUntil = Date.now() + ms; };
  const rowOf = (id) => snapshot?.agents.find((x) => x.id === id) || null;
  const draw = () => {
    if (!snapshot) return;
    const lines = renderTop(snapshot, { sort });
    if (!interactive) return stdout.write(lines.join("\n") + "\n");
    const width = Math.max(20, stdout.columns || 100), height = Math.max(3, (stdout.rows || 24) - 1);
    for (const a of snapshot.agents) names.set(a.id, plain(a.name || a.id));
    const keys = lines.rowKeys || new Map(), rowLines = [...keys.keys()].sort((x, y) => x - y);
    let at = rowLines.find((i) => keys.get(i) === selId);
    if (at == null && rowLines.length) { // first draw, or the highlighted row went away: the nearest row
      if (selId && !closedIds.has(selId)) say(`${names.get(selId) || "that row"} is gone`); // (not after closing it here: that has its own message)
      at = rowLines.reduce((best, i) => Math.abs(i - selLine) < Math.abs(best - selLine) ? i : best, rowLines[0]); selId = keys.get(at);
    }
    selLine = at ?? 0;
    if (at != null) { if (at < vertical + 1) vertical = Math.max(0, at - 1); if (at >= vertical + height) vertical = at - height + 1; }
    vertical = Math.max(0, Math.min(vertical, Math.max(0, lines.length - height)));
    horizontal = Math.max(0, Math.min(horizontal, Math.max(0, ...lines.map((line) => line.length - width))));
    const visible = lines.slice(vertical, vertical + height).map((line, i) => {
      const t = line.slice(horizontal, horizontal + width);
      return vertical + i === at ? `\x1b[7m${t.padEnd(width)}\x1b[27m` : t;
    });
    if (msg && Date.now() > msgUntil) msg = "";
    const footer = mode?.type === "confirm" ? `Close ${mode.plan.label}?${mode.plan.warnings.length ? " ! " + mode.plan.warnings.join("; ") : ""} [y/N]`
      : mode?.type === "kill" ? `${mode.alive.length} process(es) of ${mode.plan.label} still running after SIGTERM. SIGKILL them (exact pids)? [y/N]`
      : mode?.type === "busy" ? `${mode.what}...`
      : msg || `[${vertical + 1}-${Math.min(vertical + height, lines.length)}/${lines.length}, sort:${sort}] arrows/jk move; Enter focus; x close; c/m/u/p sort; q quit`;
    stdout.write("\x1b[H\x1b[2J" + visible.join("\n") + "\n" + (mode?.type === "confirm" || mode?.type === "kill" ? "\x1b[1m" : "") + plain(footer).slice(0, width) + "\x1b[0m");
  };
  const move = (delta, abs = null) => {
    const lines = snapshot ? renderTop(snapshot, { sort }) : [], keys = lines.rowKeys || new Map(), rowLines = [...keys.keys()].sort((x, y) => x - y);
    if (!rowLines.length) return;
    let i = rowLines.findIndex((x) => keys.get(x) === selId); if (i < 0) i = 0;
    i = abs != null ? (abs < 0 ? rowLines.length - 1 : 0) : Math.max(0, Math.min(rowLines.length - 1, i + delta));
    selId = keys.get(rowLines[i]); selLine = rowLines[i];
  };
  const doClose = async () => {
    const { plan, target } = mode;
    closedIds.add(target.id);
    if (plan.kind === "agent") {
      mode = { type: "busy", what: `closing ${plan.label}` }; draw();
      const r = await act.closeAgent(target, { request: req }).catch((e) => ({ ok: false, why: e.message }));
      mode = null; say(r.ok ? `closed ${plan.label} (${r.how})` : `not closed: ${r.why}${r.how ? ` (${r.how})` : ""}`, 10000);
    } else {
      const r = act.endTree(target, "SIGTERM");
      if (!r.signalled.length) { mode = null; say(`nothing signalled: the confirmed processes are gone or their pids were reused`); return draw(); }
      mode = { type: "busy", what: `SIGTERM sent to ${r.signalled.length} pid(s) of ${plan.label}; waiting` }; draw();
      let alive = [];
      for (let t = 0; t < 10; t++) { await new Promise((ok) => setTimeout(ok, 300)); alive = act.aliveOf(target); if (!alive.length) break; }
      if (alive.length) mode = { type: "kill", plan, target, alive }; else { mode = null; say(`ended ${plan.label} (${r.signalled.length} pid(s), SIGTERM)`, 10000); }
    }
    draw();
  };
  const onKey = (_text, key = {}) => {
    if (mode?.type === "busy") { if (key.ctrl && key.name === "c") quit = true; return; }
    if (mode?.type === "confirm" || mode?.type === "kill") { // y acts; anything else cancels
      const m = mode;
      if (key.name === "y" && snapshot?.authoritative === false && m.type === "confirm") { mode = null; say("the daemon stopped answering during the confirm: nothing closed"); return draw(); }
      if (key.name === "y") {
        if (m.type === "kill") { const r = act.endTree(m.target, "SIGKILL"); mode = null; say(`SIGKILL to ${r.signalled.length} pid(s)${r.skipped.length ? `, ${r.skipped.length} already gone` : ""}`, 10000); return draw(); }
        doClose().catch((e) => { mode = null; say(`error: ${e.message}`); draw(); }); return;
      }
      mode = null; say(m.type === "kill" ? "left running (no SIGKILL)" : "cancelled: nothing closed"); return draw();
    }
    if (key.name === "q" || (key.ctrl && key.name === "c") || key.name === "escape") quit = true;
    else if ({ c: "cpu", m: "mem", u: "uptime", p: "priority" }[key.name]) sort = { c: "cpu", m: "mem", u: "uptime", p: "priority" }[key.name];
    else if (["j", "down"].includes(key.name)) move(1);
    else if (["k", "up"].includes(key.name)) move(-1);
    else if (["pagedown", "space"].includes(key.name)) move(Math.max(1, (stdout.rows || 24) - 6));
    else if (key.name === "pageup") move(-Math.max(1, (stdout.rows || 24) - 6));
    else if (key.name === "home") { move(0, 0); horizontal = 0; }
    else if (key.name === "end") move(0, -1);
    else if (key.name === "left") horizontal -= 12;
    else if (key.name === "right") horizontal += 12;
    else if ((key.name === "x" || key.name === "delete" || key.name === "return" || key.name === "enter") && snapshot && snapshot.authoritative === false) {
      // (TopCheck564b) without the daemon's list, top can't tell a hyprpi agent (or a Thoughts) from another CLI: no actions
      say("the daemon isn't answering: top can't tell hyprpi agents from other processes right now, so it won't close or focus anything", 8000);
    } else if (key.name === "x" || key.name === "delete") {
      const a = rowOf(selId), plan = act.closePlan(a);
      if (!plan.ok) say(`can't close: ${plan.why}`, 8000); else mode = { type: "confirm", plan, target: act.targetOf(a) };
    } else if (key.name === "return" || key.name === "enter") {
      const a = rowOf(selId);
      act.focusRow(a, { request: req }).then((r) => { say(r.ok ? `focused ${a?.name || ""}` : `can't focus: ${r.why}`); draw(); }).catch((e) => { say(`can't focus: ${e.message}`); draw(); });
    }
    draw();
  };
  const stop = () => { quit = true; };
  const wasRaw = stdin.isRaw;
  try {
    if (interactive) {
      readline.emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume(); stdin.on("keypress", onKey);
      stdout.on("resize", draw); stdout.write("\x1b[?1049h\x1b[?25l");
    }
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    let metadata = await telemetry.read();
    await sampler.sample(metadata.agents); // establish counters; don't display lifetime-average CPU as a fresh interval
    await sleep(500);
    for (let n = 0; !quit && n < limit; n++) {
      const started = performance.now();
      metadata = await telemetry.read();
      const frame = await sampler.sample(metadata.agents);
      snapshot = assembleSnapshot(metadata, frame, performance.now() - started);
      if (opts.json) stdout.write(jsonLine(snapshot) + "\n"); else draw();
      if (n + 1 >= limit || quit) break;
      // Short sleeps keep q/Ctrl-C responsive even at a long sampling interval; never overlap samples.
      const deadline = performance.now() + Math.max(0, opts.interval * 1000 - (performance.now() - started));
      while (!quit && performance.now() < deadline) await sleep(Math.min(100, deadline - performance.now()));
    }
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    if (interactive) {
      stdin.off("keypress", onKey); stdout.off("resize", draw); stdin.setRawMode(!!wasRaw); stdin.pause();
      stdout.write("\x1b[?25h\x1b[?1049l");
    }
    await telemetry.close?.();
  }
}
