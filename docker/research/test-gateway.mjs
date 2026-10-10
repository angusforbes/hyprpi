// node docker/research/test-gateway.mjs  (J372). Everything runs against temp folders, local stub servers and a stub `sbx`; no real key, no real network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j372-"));
const CFG = path.join(T, "cfg"), STATE = path.join(T, "state"), WORLDS = path.join(CFG, "hyprpi", "worlds");
fs.mkdirSync(WORLDS, { recursive: true });
process.env.XDG_CONFIG_HOME = CFG; process.env.XDG_STATE_HOME = STATE; process.env.HYPRPI_RESEARCH_STATE = path.join(T, "rstate");
const wfile = path.join(WORLDS, "world-t.json"), PENDING = path.join(T, "pending");
const writeW = (o) => fs.writeFileSync(wfile, JSON.stringify(o, null, 2));
const readW = () => JSON.parse(fs.readFileSync(wfile, "utf8"));
fs.writeFileSync(path.join(CFG, "hyprpi", "sbx-relay.json"), JSON.stringify({ sandboxes: [{ name: "world-t", workspace: path.join(T, "ws"), review_in: "door-t", review_room: "G" }, { name: "door-t", doorman_for: "world-t", model: "nv-claude/azure/anthropic/claude-opus-5-5", visibility: "developer" }] }));
fs.writeFileSync(path.join(CFG, "hyprpi", "research.json"), JSON.stringify({ sandboxes: { "world-t": { key_file: path.join(T, "ikey"), shape_model: "legacy/report-model" } } }));
fs.writeFileSync(path.join(T, "ikey"), "inference-key\n"); fs.writeFileSync(path.join(T, "bkey"), "brave-key\n");
const sbxLog = path.join(T, "sbx.log"), fakeSbx = path.join(T, "fakesbx");
fs.writeFileSync(fakeSbx, `#!/bin/sh\necho "$@" >> ${sbxLog}\ncat > ${sbxLog}.stdin.$$\necho '{"ok":true,"refuse":false,"searches":["a"],"deliverable":"x","sources":[]}'\n`, { mode: 0o755 });
process.env.HYPRPI_SBX = fakeSbx; // research.mjs reads it at import
const G = await import("./gateway.mjs"), A = await import("./gateway-admin.mjs"), M = await import("./mode.mjs");
const R = await import("./research.mjs");
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok  " + name); };

await t("defaults and precedence: gateway block > older keys > defaults", () => {
  const relay = JSON.parse(fs.readFileSync(path.join(CFG, "hyprpi", "sbx-relay.json"), "utf8")).sandboxes;
  let e = G.resolveGateway({ w: { sandbox: "world-t", doorman: { mode: "doorman-strict" }, access: "strict" }, research: { shape_model: "legacy/report-model" }, relay, sandbox: "world-t" });
  assert.equal(e.search.provider, "sonar"); assert.equal(e.search.quick_model, "perplexity/perplexity/sonar"); assert.equal(e.report_model, "legacy/report-model"); assert.equal(e.mode, "doorman-strict"); assert.equal(e.level, "strict"); assert.equal(e.doorman_chat_model, "azure/anthropic/claude-opus-5-5");
  e = G.resolveGateway({ w: { doorman: { mode: "doorman-strict" }, access: "strict", gateway: { mode: "doorman-open", level: "open", report_model: "new/report", doorman_model: "azure/x/y", search: { provider: "brave", key_file: "~/k" } } }, research: { shape_model: "legacy/report-model" }, relay, sandbox: "world-t" });
  assert.equal(e.mode, "doorman-open"); assert.equal(e.level, "open"); assert.equal(e.report_model, "new/report"); assert.equal(e.doorman_model, "azure/x/y"); assert.equal(e.search.provider, "brave"); assert.deepEqual(e.search.hosts, ["api.search.brave.com"]);
  assert.equal(M.modeOf({ doorman: { mode: "doorman-strict" }, gateway: { mode: "doorman-open" } }).mode, "doorman-open", "mode.mjs reads gateway.mode first");
  e = G.resolveGateway({ w: { gateway: { mode: "bogus", report_model: "bad model!", search: { provider: "nope" } } }, relay, sandbox: "world-t" });
  assert.equal(e.mode, "doorman-safe"); assert.equal(e.report_model, "azure/openai/gpt-6-sol"); assert.equal(e.search.provider, "sonar"); assert.ok(e.notes.length >= 3, "invalid values are ignored and listed");
  assert.match(G.summaryLine(e), /search sonar.*report gpt-6-sol.*Doorman claude-opus-5-5.*mode safe/);
});

await t("each setting takes effect in conf(): report model, Doorman model, mode, search", () => {
  writeW({ sandbox: "world-t", task: "t", doorman: { mode: "doorman-safe" }, gateway: { report_model: "azure/other/report", doorman_model: "azure/other/doorman", mode: "doorman-strict", search: { provider: "brave", quick_model: "m/quick", key_file: path.join(T, "bkey") } } });
  const c = R.conf("world-t");
  assert.equal(c.mode, "doorman-strict"); assert.equal(c.strict, true); assert.equal(c.shape_model, "azure/other/report"); assert.equal(c.doorman_model, "azure/other/doorman"); assert.equal(c.gateway.search.provider, "brave");
  writeW({ sandbox: "world-t", task: "t" }); const d = R.conf("world-t");
  assert.equal(d.mode, "doorman-safe"); assert.equal(d.shape_model, "legacy/report-model", "research.json shape_model still works"); assert.equal(d.doorman_model, ""); assert.equal(d.gateway.search.provider, "sonar");
});

// ---- stub servers
const calls = [];
function stub(handler) { return new Promise((res) => { const s = http.createServer((rq, rs) => { let b = ""; rq.on("data", (x) => (b += x)); rq.on("end", () => handler(rq, b, rs)); }); s.listen(0, "127.0.0.1", () => res(s)); }); }
const inf = await stub((rq, b, rs) => { const j = JSON.parse(b); calls.push({ url: rq.url, auth: rq.headers.authorization, model: j.model, max: j.max_tokens, sys: j.messages[0].content.slice(0, 40), user: j.messages[1].content }); const sonar = /sonar/.test(j.model); rs.setHeader("content-type", "application/json"); rs.end(JSON.stringify({ choices: [{ message: { content: sonar ? `Answer about ${j.messages[1].content.slice(0, 30)}. See [1].` : "A neat report.\n\n```code```" } }], citations: ["https://example.org/a?x=1", "http://example.net/b", "javascript:alert(1)"] })); });
const brave = await stub((rq, b, rs) => { calls.push({ url: rq.url, token: rq.headers["x-subscription-token"] }); rs.setHeader("content-type", "application/json"); rs.end(JSON.stringify({ web: { results: [{ title: "T1", url: "https://site.example/one", description: "<b>snippet</b> one" }, { title: "T2", url: "https://site.example/two", description: "snippet two" }] } })); });
const runPy = (file, req, env = {}) => new Promise((res) => { const p = spawn("python3", [file], { env: { ...process.env, HYPRPI_READER_BASE: `http://127.0.0.1:${inf.address().port}/v1/chat/completions`, ...env } }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", () => res(JSON.parse(o.trim().split("\n").pop()))); p.stdin.end("inference-key\n" + JSON.stringify(req) + "\n"); });
const oldReader = path.join(T, "reader.old.py"); // the reader exactly as it was before J372 (a frozen copy)
fs.writeFileSync(oldReader, fs.readFileSync(path.join(HERE, "fixtures", "reader-pre-j372.py"), "utf8"));
fs.writeFileSync(oldReader, fs.readFileSync(oldReader, "utf8").replace('BASE = "https://inference-api.nvidia.com/v1/chat/completions"', `BASE = "http://127.0.0.1:${inf.address().port}/v1/chat/completions"`));

await t("Sonar adapter unchanged: the old reader and the new one make the same calls and give the same result", async () => {
  for (const req of [{ looking_for: "how does humidity degrade perovskite films", depth: "quick", searches: ["moisture degradation of perovskite", "hydrate formation in perovskite films"], brief: "" }, { looking_for: "deep question", depth: "deep", searches: [], brief: "a brief about perovskite encapsulation" }, { looking_for: "x", depth: "quick", searches: ["one"], brief: "", shape_model: "m/shape" }]) {
    calls.length = 0; const a = await runPy(oldReader, req); const ca = calls.splice(0);
    const b = await runPy(path.join(HERE, "reader.py"), { ...req, search: { provider: "sonar", quick_model: "perplexity/perplexity/sonar", deep_model: "perplexity/perplexity/sonar-deep-research" } }); const cb = calls.splice(0);
    assert.deepEqual(b, a, "same output"); assert.deepEqual(cb, ca, "same sequence of calls (model, limits, prompts)"); assert.equal(a.ok, true);
    const c = await runPy(path.join(HERE, "reader.py"), req); assert.deepEqual(c, a, "and with no search block at all (older callers)"); calls.length = 0;
  }
});

await t("a different search model and report model are used when configured", async () => {
  calls.length = 0; const r = await runPy(path.join(HERE, "reader.py"), { looking_for: "q", depth: "quick", searches: ["s one"], brief: "", shape_model: "azure/other/report", search: { provider: "sonar", quick_model: "perplexity/other-sonar", deep_model: "x/y" } });
  assert.equal(r.ok, true); assert.deepEqual(calls.map((c) => c.model), ["perplexity/other-sonar", "azure/other/report"]); assert.deepEqual(r.models, ["perplexity/other-sonar", "azure/other/report"]);
});

await t("second adapter (Brave) against a stub: key header, query, snippets reach the report model, sources cleaned, same cleaning after", async () => {
  calls.length = 0; const env = { HYPRPI_SEARCH_BASE: `http://127.0.0.1:${brave.address().port}/res/v1/web/search` };
  const r = await runPy(path.join(HERE, "reader.py"), { looking_for: "what is X?", depth: "quick", searches: ["first query", "second query"], brief: "", shape_model: "azure/other/report", search: { provider: "brave" }, search_key: "brave-key" }, env);
  assert.equal(r.ok, true, JSON.stringify(r)); const bc = calls.filter((c) => c.token), ic = calls.filter((c) => c.model);
  assert.equal(bc.length, 2); assert.ok(bc.every((c) => c.token === "brave-key")); assert.match(bc[0].url, /q=first\+query/);
  assert.equal(ic.length, 1, "no Sonar call: one call, the report model"); assert.equal(ic[0].model, "azure/other/report"); assert.match(ic[0].user, /Search: first query\n- T1: snippet one/); assert.doesNotMatch(ic[0].user, /<b>/);
  assert.deepEqual(r.sources, ["https://site.example/one", "https://site.example/two"]); assert.ok(!/```/.test(r.deliverable) && /code omitted/.test(r.deliverable), "the same clean_md runs on the report"); assert.deepEqual(r.models, ["brave", "azure/other/report"]);
  const noKey = await runPy(path.join(HERE, "reader.py"), { looking_for: "q", depth: "quick", searches: ["s"], brief: "", search: { provider: "brave" } }, env); assert.equal(noKey.ok, false);
  const unk = await runPy(path.join(HERE, "reader.py"), { looking_for: "q", depth: "quick", searches: ["s"], brief: "", search: { provider: "zzz" } }); assert.equal(unk.ok, false); assert.match(unk.error, /unknown search provider/);
  const deep = await runPy(path.join(HERE, "reader.py"), { looking_for: "q", depth: "deep", searches: [], brief: "a long brief", search: { provider: "brave" }, search_key: "k" }, env); assert.equal(deep.ok, true);
});

await t("the host sends the provider, models and the search key (on stdin, not in arguments); the Doorman model rides in the check payload", () => {
  writeW({ sandbox: "world-t", gateway: { doorman_model: "azure/other/doorman", report_model: "azure/other/report", search: { provider: "brave", key_file: path.join(T, "bkey") } } });
  const cfg = R.conf("world-t"); R.readerRun(cfg, "q", "quick", { searches: ["s"] });
  const stdin = fs.readdirSync(T).filter((f) => f.startsWith("sbx.log.stdin")).map((f) => fs.readFileSync(path.join(T, f), "utf8")).join("\n");
  assert.match(stdin, /inference-key/); const req = JSON.parse(stdin.split("\n").find((l) => l.includes('"looking_for"')));
  assert.equal(req.search.provider, "brave"); assert.equal(req.search_key, "brave-key"); assert.equal(req.shape_model, "azure/other/report");
  assert.ok(!fs.readFileSync(sbxLog, "utf8").includes("brave-key") && !fs.readFileSync(sbxLog, "utf8").includes("inference-key"), "keys never appear in arguments");
  for (const f of fs.readdirSync(T).filter((f) => f.startsWith("sbx.log.stdin"))) fs.rmSync(path.join(T, f));
  R.doormanCheck(cfg, { mode: "plan", looking_for: "q" }); const dp = JSON.parse(fs.readdirSync(T).filter((f) => f.startsWith("sbx.log.stdin")).map((f) => fs.readFileSync(path.join(T, f), "utf8")).join("\n").trim().split("\n").pop()); assert.equal(dp.model, "azure/other/doorman");
  writeW({ sandbox: "world-t" }); for (const f of fs.readdirSync(T).filter((f) => f.startsWith("sbx.log.stdin"))) fs.rmSync(path.join(T, f)); R.doormanCheck(R.conf("world-t"), { mode: "plan", looking_for: "q" });
  const dp2 = JSON.parse(fs.readdirSync(T).filter((f) => f.startsWith("sbx.log.stdin")).map((f) => fs.readFileSync(path.join(T, f), "utf8")).join("\n").trim().split("\n").pop()); assert.equal(dp2.model, undefined, "no override unless configured");
});

await t("the Doorman's check uses gateway.doorman_model (check.py against a stub, same provider and key)", async () => {
  const home = path.join(T, "home"); fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  const base = `http://127.0.0.1:${inf.address().port}`; fs.writeFileSync(path.join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { p: { baseUrl: base, models: [{ id: "doorman/default" }] } } })); fs.writeFileSync(path.join(home, ".pi", "agent", "auth.json"), JSON.stringify({ p: { key: "k" } }));
  const go = (payload) => new Promise((res) => { calls.length = 0; const p = spawn("python3", [path.join(HERE, "check.py")], { env: { ...process.env, HOME: home } }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", () => res([...new Set(calls.map((c) => c.model))])); p.stdin.end(JSON.stringify(payload)); });
  assert.deepEqual(await go({ mode: "request", looking_for: "q" }), ["doorman/default"]); assert.deepEqual(await go({ mode: "request", looking_for: "q", model: "azure/other/doorman" }), ["azure/other/doorman"]); assert.deepEqual(await go({ mode: "request", looking_for: "q", model: "bad model; rm" }), ["doorman/default"], "an invalid override is ignored");
});

await t("the reader may reach a provider's host only while that provider is selected (stub sbx)", () => {
  const fake = path.join(T, "netsbx"), lg = path.join(T, "net.log"); fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${lg}\n`, { mode: 0o755 });
  let r = A.syncReaderNetwork({ reader: "reader-t", provider: "sonar", sbxBin: fake }); assert.deepEqual(r.cmds, [["policy", "rm", "network", "--sandbox", "reader-t", "--resource", "api.search.brave.com"]]);
  r = A.syncReaderNetwork({ reader: "reader-t", provider: "brave", sbxBin: fake }); assert.deepEqual(r.cmds, [["policy", "allow", "network", "--sandbox", "reader-t", "api.search.brave.com"]]);
  const lines = fs.readFileSync(lg, "utf8").trim().split("\n"); assert.equal(lines.length, 2); assert.ok(lines.every((l) => l.includes("--sandbox reader-t")), "always scoped to the reader sandbox, never global");
  assert.deepEqual(A.syncReaderNetwork({ reader: "reader-t", provider: "brave", apply: false }).results, [], "dry run runs nothing");
});

await t("the CLI `reader network` is a dry run unless --apply", () => {
  writeW({ sandbox: "world-t", gateway: { search: { provider: "brave", key_file: path.join(T, "bkey") } } });
  const r = spawnSync(process.execPath, [path.join(HERE, "research.mjs"), "reader", "network", "--sandbox", "world-t"], { encoding: "utf8" });
  assert.match(r.stdout, /sbx policy allow network --sandbox reader-t api\.search\.brave\.com/); assert.match(r.stdout, /dry run/);
  const ap = spawnSync(process.execPath, [path.join(HERE, "research.mjs"), "reader", "network", "--sandbox", "world-t", "--apply"], { encoding: "utf8", input: "" }); assert.equal(ap.status, 3, "--apply needs the owner terminal"); assert.match(ap.stdout, /only Angus/);
});

// ---- who may change settings
const KV = ["report_model=azure/new/report", "mode=doorman-strict"];
await t("the admin command refuses under an agent and without a terminal; changes nothing", () => {
  writeW({ sandbox: "world-t", task: "t", gateway: { report_model: "old/report" } }); const before = fs.readFileSync(wfile, "utf8");
  const r1 = A.adminSet(path.join(CFG, "hyprpi"), "world-t", KV, { guard: () => "called from an agent" }); assert.equal(r1.ok, false); assert.equal(r1.code, 3);
  const r2 = A.adminSet(path.join(CFG, "hyprpi"), "world-t", KV, { guard: () => "no terminal" }); assert.equal(r2.ok, false);
  assert.equal(fs.readFileSync(wfile, "utf8"), before);
  const cli = (extra = {}) => spawnSync(process.execPath, [path.join(HERE, "research.mjs"), "config-set", "--sandbox", "world-t", ...KV], { encoding: "utf8", env: { ...process.env, ...extra }, input: "" });
  const c1 = cli({ HYPRPI_AGENT_ID: "hp-test" }); assert.equal(c1.status, 3); assert.match(c1.stdout, /only Angus can change/);
  const c2 = cli({ PI_CODING_AGENT: "1" }); assert.equal(c2.status, 3);
  const c3 = cli(); assert.equal(c3.status, 3, "no terminal (stdin is a pipe): refused"); assert.equal(fs.readFileSync(wfile, "utf8"), before, "the file is untouched by every refusal");
});
await t("the admin command (guard passed) applies validated keys atomically and keeps the rest", () => {
  writeW({ sandbox: "world-t", task: "keep me", doorman: { mode: "doorman-safe" }, gateway: { report_model: "old/report", search: { provider: "sonar" } } });
  const r = A.adminSet(path.join(CFG, "hyprpi"), "world-t", ["report_model=azure/new/report", "search.provider=brave", "search.key_file=" + path.join(T, "bkey"), "level=strict"], { guard: () => "" });
  assert.equal(r.ok, true, r.text); const w = readW(); assert.equal(w.task, "keep me"); assert.equal(w.gateway.report_model, "azure/new/report"); assert.equal(w.gateway.search.provider, "brave"); assert.equal(w.gateway.level, "strict"); assert.equal(w.doorman.mode, "doorman-safe");
  for (const bad of [["mode=banana"], ["nokey=1"], ["report_model=bad model"], ["search.provider=zzz"], ["justtext"]]) { const x = A.adminSet(path.join(CFG, "hyprpi"), "world-t", bad, { guard: () => "" }); assert.equal(x.ok, false, bad.join()); }
});

await t("an invalid gateway.mode never makes the display differ from what the runner enforces", () => {
  writeW({ sandbox: "world-t", doorman: { mode: "doorman-strict" }, gateway: { mode: "bogus" } });
  assert.equal(R.conf("world-t").mode, M.modeOf(readW()).mode); assert.equal(R.conf("world-t").gateway.mode, R.conf("world-t").mode);
});
await t("LOOSENS compares against what is in effect (legacy strict mode, derived levels), not what is written", () => {
  writeW({ sandbox: "world-t", research: { strict: true } }); // legacy: strict
  const r = A.proposeChange({ cfgDir: path.join(CFG, "hyprpi"), PENDING, sandbox: "world-t", changes: { mode: "doorman-safe" } }); assert.equal(r.ok, true, r.text);
  const rec = JSON.parse(fs.readFileSync(path.join(PENDING, r.id + ".json"), "utf8")); assert.equal(rec.gatewayChange.before.mode, "doorman-strict"); assert.match(rec.text, /LOOSENS/, "strict -> safe loosens even though the file has no mode key");
  writeW({ sandbox: "world-t" }); // no access key; the Doorman is in developer visibility -> level open is in effect
  const r2 = A.proposeChange({ cfgDir: path.join(CFG, "hyprpi"), PENDING, sandbox: "world-t", changes: { level: "safe" } }); assert.equal(r2.ok, true, r2.text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(PENDING, r2.id + ".json"), "utf8")).gatewayChange.before.level, "open"); assert.doesNotMatch(r2.text, /LOOSENS/, "open -> safe tightens");
});
await t("two writers of a worlds file don't lose each other's change (shared lock)", async () => {
  writeW({ sandbox: "world-t", task: "t0", gateway: { report_model: "a/b" } });
  const Tk = await import("./task.mjs"); const w = [];
  for (let i = 0; i < 12; i++) { Tk.setTask(path.join(CFG, "hyprpi"), "world-t", `task ${i}`); A.applyChanges(path.join(CFG, "hyprpi"), "world-t", { report_model: `m/${i}` }); }
  const x = readW(); assert.equal(x.task, "task 11"); assert.equal(x.gateway.report_model, "m/11"); assert.ok(!fs.existsSync(path.join(WORLDS, ".write.lock")), "the lock is released");
});
await t("a failed reader-network change blocks the reader until a later sync succeeds (fail closed); a configured report model equal to a search model is still used", () => {
  const bad = path.join(T, "badsbx"); fs.writeFileSync(bad, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const r = A.syncReaderNetwork({ reader: "reader-t", provider: "sonar", sbxBin: bad }); assert.equal(r.failed, 1);
  const rr = R.readerRun(R.conf("world-t"), "q", "quick", { searches: ["s"] }); assert.equal(rr.ok, false); assert.match(rr.error, /aren't reconciled/);
  const ok = path.join(T, "oksbx"); fs.writeFileSync(ok, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); assert.equal(A.syncReaderNetwork({ reader: "reader-t", provider: "sonar", sbxBin: ok }).failed, 0);
  assert.doesNotMatch(String(R.readerRun(R.conf("world-t"), "q", "quick", { searches: ["s"] }).error || ""), /reconciled/, "after a successful sync the reader runs again");
  writeW({ sandbox: "world-t", gateway: { report_model: "perplexity/perplexity/sonar" } }); assert.equal(R.conf("world-t").shape_model, "perplexity/perplexity/sonar");
  writeW({ sandbox: "world-t", gateway: { search: ["x"] } }); A.applyChanges(path.join(CFG, "hyprpi"), "world-t", { "search.provider": "brave" }); assert.equal(readW().gateway.search.provider, "brave", "a malformed search value is replaced, not silently dropped");
});
await t("the owner guard fails closed when the ancestry is too deep to check", () => {
  const sh = path.join(T, "pi"); fs.symlinkSync("/bin/sh", sh); // a process whose name is pi, 45 levels above the caller
  const probe = path.join(T, "probe.mjs"); fs.writeFileSync(probe, `import(${JSON.stringify(path.join(HERE, "..", "agent-guard.mjs"))}).then((m)=>console.log("GUARD:"+m.agentAncestor()))`);
  const lvl = (k) => path.join(T, `lvl${k}.sh`); fs.writeFileSync(lvl(0), `#!/bin/sh\nnode ${probe}\n`, { mode: 0o755 });
  for (let i = 1; i <= 45; i++) fs.writeFileSync(lvl(i), `#!/bin/sh\n/bin/sh ${lvl(i - 1)}\ntrue\n`, { mode: 0o755 }); // each level forks the next (not exec), so the depth really grows
  const cmd = `/bin/sh ${lvl(45)}`;
  const env = { ...process.env }; for (const k of ["HYPRPI_AGENT_ID", "PI_CODING_AGENT", "PI_SESSION_FILE", "HYPRPI_THOUGHTS_ROOM"]) delete env[k];
  const r = spawnSync(sh, ["-c", cmd], { encoding: "utf8", env, timeout: 60000 }); const g = (/GUARD:(.*)/.exec(r.stdout) || [])[1];
  assert.ok(g && g.length, "the guard must refuse (not return empty) when it can't see the whole ancestry: got " + JSON.stringify(g) + r.stderr.slice(0, 200));
});

// ---- proposals
await t("a proposal is a held item showing current → proposed; it changes nothing; unproposable keys and no-ops are refused", () => {
  writeW({ sandbox: "world-t", gateway: { report_model: "old/report", mode: "doorman-safe" } }); const before = fs.readFileSync(wfile, "utf8");
  const r = A.proposeChange({ cfgDir: path.join(CFG, "hyprpi"), PENDING, sandbox: "world-t", changes: { report_model: "azure/new/report", mode: "doorman-open" }, by: "Opener\u001b[2J", reviewIn: "door-t" });
  assert.equal(r.ok, true, r.text); assert.equal(fs.readFileSync(wfile, "utf8"), before, "nothing changed");
  const rec = JSON.parse(fs.readFileSync(path.join(PENDING, r.id + ".json"), "utf8")); assert.equal(rec.reviewIn, "door-t"); assert.deepEqual(rec.gatewayChange.before, { report_model: "old/report", mode: "doorman-safe" });
  assert.match(rec.text, /report_model: old\/report  →  azure\/new\/report/); assert.match(rec.text, /mode: doorman-safe  →  doorman-open/); assert.match(rec.text, /LOOSENS/); assert.ok(!/\u001b/.test(rec.text));
  assert.equal(A.proposeChange({ cfgDir: path.join(CFG, "hyprpi"), PENDING, sandbox: "world-t", changes: { "search.key_file": "/home/x/.ssh/id_rsa" } }).ok, false, "key_file can't be proposed");
  assert.equal(A.proposeChange({ cfgDir: path.join(CFG, "hyprpi"), PENDING, sandbox: "world-t", changes: { report_model: "old/report" } }).ok, false, "a no-op is refused");
  assert.equal(A.proposeChange({ cfgDir: path.join(CFG, "hyprpi"), PENDING, sandbox: "world-t", changes: { mode: "x" } }).ok, false);
});
await t("an approved proposal applies exactly what was shown (digest), only if nothing changed meanwhile", () => {
  writeW({ sandbox: "world-t", gateway: { report_model: "old/report" } });
  const r = A.proposeChange({ cfgDir: path.join(CFG, "hyprpi"), PENDING, sandbox: "world-t", changes: { report_model: "azure/new/report", "search.quick_model": "perplexity/other" } });
  const gc = JSON.parse(fs.readFileSync(path.join(PENDING, r.id + ".json"), "utf8")).gatewayChange; assert.equal(gc.digest, A.digestOf("world-t", gc.changes));
  assert.notEqual(A.digestOf("world-t", { ...gc.changes, mode: "doorman-open" }), gc.digest, "adding a key changes the digest (tampering is detected by the relay)");
  const ap = A.applyChanges(path.join(CFG, "hyprpi"), "world-t", gc.changes, { expectBefore: gc.before }); assert.deepEqual(ap.after, gc.changes);
  const w = readW(); assert.equal(w.gateway.report_model, "azure/new/report"); assert.equal(w.gateway.search.quick_model, "perplexity/other"); assert.deepEqual(Object.keys(w), ["sandbox", "gateway"], "no other key was touched");
  assert.throws(() => A.applyChanges(path.join(CFG, "hyprpi"), "world-t", gc.changes, { expectBefore: gc.before }), /not applied: .* is now/, "changed since proposed: refused");
});
await t("the relay CLI propose-gateway creates the held item (no terminal needed) and the relay's decide applies it only for the digest shown", () => {
  writeW({ sandbox: "world-t", gateway: { report_model: "old/report" } });
  const run = spawnSync(process.execPath, [path.join(HERE, "..", "sbx-relay.mjs"), "propose-gateway", "world-t", "--by", "Opener", "--changes", JSON.stringify({ report_model: "azure/new/report" })], { encoding: "utf8", env: { ...process.env } });
  assert.equal(run.status, 0, run.stdout + run.stderr); const o = JSON.parse(run.stdout.trim().split("\n").pop()); assert.equal(o.ok, true);
  const rec = JSON.parse(fs.readFileSync(path.join(STATE, "hyprpi", "sbx-relay", "pending", o.id + ".json"), "utf8")); assert.equal(rec.reviewIn, "door-t"); assert.equal(rec.sandbox, "world-t");
  const bad = spawnSync(process.execPath, [path.join(HERE, "..", "sbx-relay.mjs"), "propose-gateway", "world-t", "--changes", JSON.stringify({ "search.key_file": "/etc/passwd" })], { encoding: "utf8" }); assert.notEqual(bad.status, 0);
  const relay = fs.readFileSync(path.join(HERE, "..", "sbx-relay.mjs"), "utf8");
  assert.ok(/digestOf\(gc\.sandbox, v\.changes\) !== gc\.digest/.test(relay) && /expectBefore: gc\.before/.test(relay) && /validateChanges\(gc\.changes, \{ admin: false \}\)/.test(relay), "decide(): re-validates (as a proposal, so key_file is refused), checks the digest and the before values");
  const gk = fs.readFileSync(path.join(HERE, "..", "..", "lib", "held.mjs"), "utf8"); assert.ok(/gatewayChange \? "gateway settings"/.test(gk) && /!m\.gatewayChange\) \|\| kind === "research plan"/.test(gk), "shown as 'gateway settings', not editable");
});
await t("the window shows what is in effect (provider, models, mode, level)", async () => {
  writeW({ sandbox: "world-t", gateway: { report_model: "azure/new/report", search: { provider: "brave", key_file: path.join(T, "bkey") }, mode: "doorman-strict", level: "safe" } });
  const e = R.conf("world-t").gateway; const line = G.summaryLine(e); assert.match(line, /search brave · report report · Doorman claude-opus-5-5 · mode strict · level safe/);
  const prov = await import("../doorman/review-provider.mjs"); assert.equal(typeof prov.default("door-t").info, "function"); assert.match(prov.default("door-t").info(), /world-t: search brave/);
});
inf.close(); brave.close();
console.log(`gateway: all ${n} pass`);
