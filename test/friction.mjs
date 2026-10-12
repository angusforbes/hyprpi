#!/usr/bin/env node
// J488 proof (Angus: "make it so!"): his complaints become cues.
//   node test/friction.mjs          the log, the daemon methods and the CLI (no model)
//   J488_REAL=1 node test/friction.mjs   also a real Thoughts (sonnet) gets two complaints of one kind: it logs
//                                        both, says nothing about the first, and proposes a skill on the second
// A) lib/friction.mjs: kinds, counts, advice (first / again / after a skill), recurrence after a skill (W4).
// B) an isolated daemon (config.json frictionLog → a temp file): friction.add / list / skill, and
//    `hyprpi friction add` from an "agent" (HYPRPI_AGENT_ID): its world and name are filled in.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import * as F from "../lib/friction.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j488-"));

// ---- A) the log (W4 on a fixture)
{
  const f = path.join(S, "unit.md"), d = (day, h) => new Date(2026, 9, day, h, 0);
  const r1 = F.add(f, { kind: "Desktop input testing", world: "D", agent: "Knock", what: "fake keys · held Super\nwhile he typed", fix: "toast first" }, d(11, 13));
  ok("A kind normalised, first time: just fix it", r1.kind === "desktop-input-testing" && r1.count === 1 && /First time/.test(r1.advice));
  const r2 = F.add(f, { kind: "desktop-input-testing", world: "D", agent: "Knock", what: "toasts left up" }, d(11, 21));
  ok("A second time: propose ONE skill in one line", r2.count === 2 && /second time/.test(r2.advice) && /skill/.test(r2.advice));
  F.linkSkill(f, { kind: "desktop-input-testing", skill: "desktop-input-testing (~/.pi/agent/skills/desktop-input-testing/SKILL.md)" }, d(12, 9));
  let k = F.summary(f).find((x) => x.kind === "desktop-input-testing");
  ok("A W4: after the skill, no repeats yet", k.skill && k.after === 0 && k.count === 2);
  const r3 = F.add(f, { kind: "desktop-input-testing", world: "C", agent: "Remote", what: "Go… menu left open" }, d(12, 15));
  k = F.summary(f).find((x) => x.kind === "desktop-input-testing");
  ok("A W4: a repeat after the skill counts against it, and says so", k.after === 1 && /isn't working/.test(r3.advice), r3.advice);
  const text = fs.readFileSync(f, "utf8");
  ok("A one line per entry, Markdown Angus can read, · and newlines in the text made safe", /^- 2026-10-11 13:00:00 · D · desktop-input-testing · Knock · fake keys - held Super while he typed · fix: toast first$/m.test(text) && /## Skills\n- desktop-input-testing → /.test(text));
  // FrictionCheck: a repeat in the same minute as the skill still counts; a CRLF file keeps its entries; old minute-only stamps parse
  const g = path.join(S, "minute.md"), t0 = new Date(2026, 9, 12, 10, 25, 10), t1 = new Date(2026, 9, 12, 10, 25, 59);
  F.add(g, { kind: "k", what: "one" }, new Date(2026, 9, 12, 9, 0)); F.add(g, { kind: "k", what: "two" }, new Date(2026, 9, 12, 9, 5));
  F.linkSkill(g, { kind: "k", skill: "s" }, t0); const r4 = F.add(g, { kind: "k", what: "three" }, t1);
  ok("A a repeat 49 s after the skill (same minute) counts against it", r4.after === 1 && /isn't working/.test(r4.advice), r4.advice);
  const h = path.join(S, "second.md"), ts = new Date(2026, 9, 12, 11, 0, 7);
  F.add(h, { kind: "k", what: "one" }, new Date(2026, 9, 12, 10, 0)); F.linkSkill(h, { kind: "k", skill: "s" }, ts);
  ok("A a repeat in the same second as the link counts too", F.add(h, { kind: "k", what: "two" }, ts).after === 1);
  const c = path.join(S, "crlf.md"); fs.writeFileSync(c, "# Friction log\r\n\r\n## Skills\r\n- k → s, since 2026-10-11 09:00\r\n\r\n## Entries\r\n- 2026-10-11 08:00 · D · k · Knock · old one\r\n");
  const r5 = F.add(c, { kind: "k", what: "new one" }, new Date(2026, 9, 11, 10, 0));
  ok("A a CRLF, hand-edited file keeps its entries and skill (old minute-only stamps parse)", r5.count === 2 && r5.skill === "s" && r5.after === 1 && !fs.readFileSync(c, "utf8").includes("\r"), JSON.stringify(r5).slice(0, 160));
  ok("A an unknown kind tag is refused cleanly", (() => { try { F.add(f, { kind: "  ", what: "x" }); return false; } catch (e) { return /kind/.test(e.message); } })());
}

// ---- B) daemon + CLI
const cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), log = path.join(S, "Friction log.md");
fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
const real = !!process.env.J488_REAL;
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: real ? (process.env.PI_BIN || "pi") : "/bin/cat", thoughtsModel: process.env.THOUGHTS_MODEL || "anthropic/claude-sonnet-4-5", worldSize: 10, frictionLog: log }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j488-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), fs.openSync(path.join(S, "d.err"), "w")] });
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const api = await connect({ path: sock, onEvent: () => {} });
  const agent = await connect({ path: sock, onEvent: () => {} });
  await agent.call("agent.hello", { agent_id: "hp-knock", pid: process.pid, name: "Knock", want_workspace: 32, cwd: S });
  const r = await api.call("friction.add", { room: "D", kind: "desktop-input-testing", what: "toasts left up", agent: "Knock", fix: "cleared" });
  ok("B friction.add (Thoughts' path): world D, file in config", r.count === 1 && r.file === log && /· D · desktop-input-testing · Knock · toasts left up · fix: cleared$/m.test(fs.readFileSync(log, "utf8")));
  const out = execFileSync(process.execPath, [path.join(ROOT, "bin/hyprpi"), "friction", "add", "desktop-input-testing", "the Go… menu left open", "--fix", "closed it"], { env: { ...env, HYPRPI_AGENT_ID: "hp-knock" }, encoding: "utf8" });
  ok("B `hyprpi friction add` from an agent: its world and name filled in; the second time asks for a skill", /2× now/.test(out) && /second time/.test(out) && /· D · desktop-input-testing · Knock · the Go/.test(fs.readFileSync(log, "utf8")), out.trim());
  const l = await api.call("friction.list", {});
  ok("B friction.list counts by kind", l.kinds[0].kind === "desktop-input-testing" && l.kinds[0].count === 2);
  await api.call("friction.skill", { kind: "desktop-input-testing", skill: "desktop-input-testing" });
  const l2 = execFileSync(process.execPath, [path.join(ROOT, "bin/hyprpi"), "friction", "list"], { env, encoding: "utf8" });
  ok("B `hyprpi friction list` shows the skill and repeats since it", /desktop-input-testing: 2× .* skill desktop-input-testing since .*, 0 since/.test(l2), l2.trim());

  if (real) { // C) a real Thoughts gets two complaints of one kind (W2 + W3)
    const thread = () => { try { return fs.readFileSync(path.join(S, "thoughts", "D.thread.jsonl"), "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };
    // one whole turn: until Thoughts is idle (not busy) for 4 s after replying
    const turn = async (text) => { const n0 = thread().length; await api.call("thoughts.send", { room: "D", text }); let quiet = 0; for (let i = 0; i < 240 && quiet < 4; i++) { await sleep(1000); const busy = (await api.call("thoughts.get", { room: "D", limit: 1 }).catch(() => ({ busy: true }))).busy; quiet = !busy && thread().slice(n0).some((e) => e.role === "thoughts") ? quiet + 1 : 0; } return thread().slice(n0); };
    const kinds0 = F.summary(log).length;
    const t1 = await turn("ugh, an agent left a dozen test windows open on my workspace AGAIN after its test. annoying");
    const s1 = F.summary(log);
    console.log("   reply 1:", (t1.filter((e) => e.role === "thoughts").pop()?.text || "").slice(0, 300).replace(/\n/g, " "));
    ok("C first complaint logged under a new kind", s1.length === kinds0 + 1, JSON.stringify(s1.map((k) => k.kind + " " + k.count)));
    const kind = s1.find((k) => k.kind !== "desktop-input-testing")?.kind;
    const t2 = await turn("and now Sweep's test left its windows lying around on my screen too. why does this keep happening");
    const s2 = F.summary(log), k2 = s2.find((k) => k.kind === kind);
    const reply2 = t2.filter((e) => e.role === "thoughts").pop()?.text || "";
    console.log("   reply 2:", reply2.slice(0, 400).replace(/\n/g, " "));
    ok("C second complaint logged under the SAME kind (count 2)", k2?.count === 2, JSON.stringify(s2.map((k) => k.kind + " " + k.count)));
    ok("C W3: the second reply proposes a skill or hook", /skill|hook/i.test(reply2), reply2.slice(0, 200));
    ok("C no skill was created without his OK", !fs.existsSync(path.join(os.homedir(), ".pi/agent/skills", kind || "none")) && !F.summary(log).find((k) => k.kind === kind)?.skill);
    fs.writeFileSync(path.join(S, "C-transcript.txt"), [...t1, ...t2].map((e) => `[${e.role}] ${e.text}`).join("\n\n"));
  }
  api.close?.(); agent.close?.();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { d.kill(); }
console.log(fails ? `${fails} FAILED (state ${S})` : `all passed (state ${S})`); process.exit(fails ? 1 : 0);
