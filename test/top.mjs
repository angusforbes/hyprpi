// J557: hermetic formatting/CLI tests; no daemon, inference, desktop or live-process signals.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { parseTopArgs, plain, jsonLine, amount, age, contextCell, sortedAgents, assembleSnapshot, renderTop, runTop } from "../lib/top.mjs";
let checks = 0;
const test = (name, fn) => { fn(); checks++; console.log(`ok ${name}`); };
const agent = { id: "agent-a", name: "Example", world: "A", status: "working", model: "provider/model-one", topic: "Example task", job: "J1",
  pids: [101], helpers: 1, contextTokens: 50000, contextWindow: 200000, contextPercent: 25, compactions: 2,
  sessionAgeSeconds: 86400, restarts: 1, refreshes: 0, refreshDue: false, budgetUsed: 2000, budgetLimit: 10000, priority: 65 };
const metadata = { agents: [agent, { ...agent, id: "remote-h", name: "Remote clients", world: "H", remote: true, pids: [], model: "" }], warnings: [], priorityFormula: "fixture formula" };
const frame = { timestampMs: 1800000000000, intervalSeconds: 2, system: { cpuPercent: 40, cpuCores: 8, loadAverage: [2, 1, 0.5], uptimeSeconds: 80000,
  memoryTotalBytes: 16 * 1024 ** 3, memoryAvailableBytes: 8 * 1024 ** 3, swapTotalBytes: 4 * 1024 ** 3, swapUsedBytes: 1024 ** 3 },
  totals: { cpuPercent: 150, rssBytes: 300 * 1024 ** 2, processCount: 3 },
  groups: [{ id: "agent-a", cpuPercent: 150, rssBytes: 300 * 1024 ** 2, uptimeSeconds: 3600, processCount: 3, piCount: 3, pids: [101, 102, 103] }],
  unattributed: [{ id: "unattributed:201", name: "pi 201", cpuPercent: 0, rssBytes: 1024, uptimeSeconds: 5, processCount: 1, piCount: 1, pids: [201] }],
  processes: [{ pid: process.pid, cpuPercent: 0.1, rssBytes: 40 * 1024 ** 2 }] };
test("argument defaults", () => assert.deepEqual(parseTopArgs([]), { once: false, json: false, interval: 2, sort: "cpu", samples: null }));
test("once/json and explicit sort", () => assert.equal(parseTopArgs(["--once", "--json", "--sort", "priority"]).sort, "priority"));
test("bounded refresh options", () => assert.equal(parseTopArgs(["--samples", "3", "--interval", "0.5"]).samples, 3));
test("reject controls/invalid flags rather than acting", () => { for (const args of [["--kill"], ["--sort", "bad"], ["--sort"], ["--interval", "NaN"], ["--interval", "0"], ["--samples", "-1"], ["--samples", "2.2"], ["--once", "--samples", "2"]]) assert.throws(() => parseTopArgs(args)); });
test("terminal text cannot inject OSC/CSI/control commands", () => { const t = plain("A\x1b]52;c;SECRET\x07B\x1b[31mC\x1b[2J\nD\x9d52;c;SECRET\x9c"); assert.equal(t, "ABC D"); });
test("JSON preserves Unicode while escaping terminal C1 controls", () => { const text = jsonLine({ name: "Écho", control: "\x9d52;c;x\x9c" }); assert.ok(!/[\x7f-\x9f]/.test(text)); assert.equal(JSON.parse(text).name, "Écho"); assert.equal(JSON.parse(text).control, "\x9d52;c;x\x9c"); });
test("unknown isn't zero", () => { assert.equal(amount(null), "?"); assert.equal(age(null), "?"); assert.match(contextCell({ contextTokens: null, contextWindow: 200000 }), /^\?\/200k \?% \[\?{5}\]$/); });
test("context tokens/window percentage and bar", () => assert.equal(contextCell(agent), "50k/200k 25% [#----]"));
test("bar clamps but true over-window percent remains", () => assert.equal(contextCell({ contextTokens: 300000, contextWindow: 200000 }), "300k/200k 150% [#####]"));
test("zero context is valid", () => assert.equal(contextCell({ contextTokens: 0, contextWindow: 200000 }), "0/200k 0% [-----]"));
test("every sort is within worlds and unknown comes last", () => {
  for (const [sort, key] of [["cpu", "cpuPercent"], ["mem", "rssBytes"], ["uptime", "uptimeSeconds"], ["priority", "priority"]]) {
    const rows = [{ id: "other", world: "B", [key]: 999 }, { id: "unknown", world: "A", [key]: null }, { id: "small", world: "A", [key]: 1 }, { id: "big", world: "A", [key]: 8 }];
    assert.deepEqual(sortedAgents(rows, sort).map((a) => a.id), ["big", "small", "unknown", "other"]);
  }
});
const snapshot = assembleSnapshot(metadata, frame, 3);
test("assembling retains all agents and adds unattributed", () => { assert.equal(snapshot.agents.length, 3); assert.equal(snapshot.agents[1].rssBytes, null); assert.equal(snapshot.agents[2].world, "Unattributed"); });
test("process tree helper count and monitor metrics", () => { assert.equal(snapshot.agents[0].helpers, 2); assert.deepEqual(snapshot.agents[0].pids, [101, 102, 103]); assert.equal(snapshot.monitor.cpuPercent, 0.1); });
test("registered helpers and headless workers are combined without counting roots", () => {
  const data = { ...metadata, agents: [{ ...agent, helpers: 3, registeredHelpers: ["child-a", "child-b"], inProcessHelpers: 1 }] };
  const result = assembleSnapshot(data, { ...frame, groups: [{ ...frame.groups[0], piCount: 4, rootPiCount: 1 }] });
  assert.equal(result.agents[0].helpers, 5);
});
test("unknown mirror helper count stays unknown rather than zero", () => {
  const result = assembleSnapshot({ ...metadata, agents: [{ ...metadata.agents[1], helpers: null, inProcessHelpers: null, registeredHelpers: [] }] }, frame);
  assert.equal(result.agents[0].helpers, null);
});
test("monitor can be outside all agent trees", () => { const result = assembleSnapshot(metadata, { ...frame, processes: [], monitor: { pid: process.pid, cpuPercent: 0.25, rssBytes: 5000 } }); assert.equal(result.monitor.cpuPercent, 0.25); });
test("sampler limitations survive assembly", () => assert.ok(assembleSnapshot(metadata, { ...frame, limitations: ["permission denied"] }).warnings.includes("permission denied")));
test("unknown CPU is not rendered as zero machine CPU", () => assert.match(renderTop({ ...snapshot, totals: { ...snapshot.totals, cpuPercent: null } }).join("\n"), /\?% CPU \(\?% machine\)/));
test("one-shot includes world groups, load and all requested columns", () => {
  const text = renderTop(snapshot, { sort: "priority" }).join("\n");
  for (const s of ["[A]", "[H]", "[Other agents (not hyprpi", "load 2.0 / 1.0 / 0.5", "host CPU 40.0%", "RAM", "swap", "STATE", "UPTIME", "CPU%", "RSS", "MODEL", "PRI", "CTX", "CMP", "SESSION", "RST/RF", "DUE", "BUDGET", "150.0", "model-one", "50k/200k 25% [#----]", "remote: laptop clients/transport only"]) assert.ok(text.includes(s), s);
});
test("render strips controls from daemon text and warnings", () => {
  const text = renderTop({ ...snapshot, warnings: ["unsafe\x1b]52;c;SECRET\x07"], agents: [{ ...snapshot.agents[0], name: "Example\x1b[2J" }] }).join("\n");
  assert.ok(!text.includes("\x1b")); assert.ok(!text.includes("SECRET"));
});
{
  const output = new PassThrough(), input = new PassThrough(); let text = "", reads = 0, samples = 0, closed = false;
  output.on("data", (d) => { text += d; });
  await runTop(["--once", "--json"], { stdout: output, stdin: input, sleep: async () => {},
    telemetry: { read: async () => { reads++; return metadata; }, close: () => { closed = true; } },
    sampler: { sample: async (owners) => { assert.equal(owners.length, 2); samples++; return frame; } } });
  test("one-shot JSON is exactly one valid snapshot", () => { assert.equal(text.trim().split("\n").length, 1); assert.equal(JSON.parse(text).agents.length, 3); });
  test("one-shot primes CPU and closes the reader", () => { assert.equal(samples, 2); assert.equal(reads, 2); assert.ok(closed); });
  test("non-TTY mode never emits terminal controls", () => assert.ok(!text.includes("\x1b")));
}
{
  const output = new PassThrough(), input = new PassThrough(); let text = "", sent = false; const raw = [];
  output.isTTY = true; output.columns = 100; output.rows = 24; input.isTTY = true;
  input.setRawMode = (on) => { input.isRaw = on; raw.push(on); };
  output.on("data", (d) => { text += d; if (!sent && String(d).includes("\x1b[H\x1b[2J")) { sent = true; input.emit("keypress", "p", { name: "p" }); input.emit("keypress", "q", { name: "q" }); } });
  const sigint = process.listenerCount("SIGINT"), sigterm = process.listenerCount("SIGTERM");
  await runTop([], { stdout: output, stdin: input, sleep: async () => {}, telemetry: { read: async () => metadata }, sampler: { sample: async () => frame } });
  test("interactive sort/q restores raw mode and alternate screen", () => { assert.deepEqual(raw, [true, false]); assert.ok(text.includes("\x1b[?1049h")); assert.ok(text.endsWith("\x1b[?25h\x1b[?1049l")); assert.ok(text.includes("sort:priority")); });
  test("interactive quit removes process signal listeners", () => { assert.equal(process.listenerCount("SIGINT"), sigint); assert.equal(process.listenerCount("SIGTERM"), sigterm); });
}
{
  const output = new PassThrough(), input = new PassThrough(); let text = "";
  output.isTTY = true; input.isTTY = true; input.setRawMode = (on) => { input.isRaw = on; };
  output.on("data", (d) => { text += d; });
  await assert.rejects(runTop([], { stdout: output, stdin: input, telemetry: { read: async () => { throw new Error("fixture daemon unavailable"); } }, sampler: {} }), /fixture daemon unavailable/);
  test("reader failure also restores the terminal", () => { assert.equal(input.isRaw, false); assert.ok(text.endsWith("\x1b[?25h\x1b[?1049l")); });
}
console.log(`all ${checks} top CLI/render checks passed`);
