#!/usr/bin/env node
// J466 proof (J201 amended 2026-10-11, Angus: "1 y to all"): one level of splitting. With the default policy
// (orchestration.maxDepth 1) a top-level agent may spawn a helper, but that helper may not spawn its own; a
// Thoughts-spawned child may not spawn either. Angus's override: orchestration.maxDepth 2 in hyprpi.jsonc lets
// the helper spawn once more. Also: the brief's split line (J466) renders as "Split: …".
//   node test/orch-depth.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j466-"));
process.env.XDG_CONFIG_HOME = path.join(T, "cfg"); fs.mkdirSync(path.join(T, "cfg", "hyprpi"), { recursive: true });
const { createOrch } = await import("../lib/orch.mjs");

const live = new Map([["hp-top", { id: "hp-top", name: "Top", room: "Z", model: "m" }]]);
const mk = () => createOrch({ stateDir: fs.mkdtempSync(path.join(T, "st-")), deps: {
  liveAgent: (id) => live.get(id) || null, agentName: (id) => live.get(id)?.name || id, send: () => true, note: () => {}, thoughtsReport: () => {},
  open: ({ id, name }) => { live.set(id, { id, name: name || id, room: "Z", model: "m" }); return { name: name || id, workspace: 1 }; },
  setModel: async () => {}, roomOf: () => "Z",
} });
const spawnOk = (o, p, parent) => { try { return { c: o.spawn(p, parent) }; } catch (e) { return { err: e.message }; } };
const idOf = (r) => r.c?.id || r.c?.child?.id || r.c?.agent?.id;

// 1) default policy (no hyprpi.jsonc: the defaults): maxDepth 1
let o = mk();
const a = spawnOk(o, { prompt: "helper job", name: "Helper" }, "hp-top");
ok("a top-level agent may spawn a helper", !a.err && idOf(a), a.err || "");
const b = spawnOk(o, { prompt: "sub-helper job", name: "Sub" }, idOf(a));
ok("the helper may NOT spawn its own helper", !!b.err && /helpers don't spawn helpers/.test(b.err), b.err || "it spawned");
const t = spawnOk(o, { prompt: "side task", name: "Side" }, "thoughts:Z");
ok("Thoughts may spawn a child", !t.err && idOf(t), t.err || "");
const t2 = spawnOk(o, { prompt: "deeper", name: "Deeper" }, idOf(t));
ok("a Thoughts-spawned child may NOT spawn", !!t2.err && /may not spawn/.test(t2.err), t2.err || "it spawned");

// 2) Angus's override: orchestration.maxDepth 2 in hyprpi.jsonc
fs.writeFileSync(path.join(T, "cfg", "hyprpi", "hyprpi.jsonc"), '{ "orchestration": { "maxChildren": 4, "maxDepth": 2 } }\n');
o = mk();
const a2 = spawnOk(o, { prompt: "helper job", name: "Helper2" }, "hp-top");
const b2 = spawnOk(o, { prompt: "sub-helper job", name: "Sub2" }, idOf(a2));
ok("override maxDepth 2: the helper may spawn once", !a2.err && !b2.err && idOf(b2), b2.err || a2.err || "");
const c2 = spawnOk(o, { prompt: "third level", name: "Third" }, idOf(b2));
ok("override maxDepth 2: its child may not", !!c2.err && /may not spawn/.test(c2.err), c2.err || "it spawned");

// 3) the brief's split line
const B = await import("../lib/briefs.mjs");
ok("split is a brief field", B.FIELDS.includes("split"));
const f = B.fieldsFrom({ angus: "x", goal: "g", split: "A and B independent; C needs A's file list", done_when: ["W"] });
const txt = B.render({ id: "J1", version: 1, from: "Thoughts-Z", state: "running", fields: f });
ok("the split line is kept and shown", f.split === "A and B independent; C needs A's file list" && /\nSplit: A and B independent; C needs A's file list\n/.test(txt), txt.slice(0, 300));
const none = B.render({ id: "J2", version: 1, from: "Thoughts-Z", state: "running", fields: B.fieldsFrom({ angus: "x", goal: "g", done_when: ["W"] }) });
ok("no split line when the work isn't split", !/Split:/.test(none));

// J753 (Angus: "no just no limit"): no cap on the number of children; even with an old maxChildren left in hyprpi.jsonc
{ fs.writeFileSync(path.join(T, "cfg", "hyprpi", "hyprpi.jsonc"), '{ "orchestration": { "maxChildren": 4, "maxDepth": 1 } }\n');
  live.set("hp-many", { id: "hp-many", name: "Many", room: "Z", model: "m" });
  const om = mk(); const r = [];
  for (let i = 1; i <= 8; i++) r.push(spawnOk(om, { prompt: `explore idea ${i}`, name: `Idea${i}` }, "hp-many"));
  ok("J753 one agent spawns 8 live children: none refused for a count", r.every((x) => !x.err && idOf(x)), r.map((x) => x.err).filter(Boolean).join(" | "));
  const deep = spawnOk(om, { prompt: "deeper", name: "Deep8" }, idOf(r[7]));
  ok("J753 … and the one-level rule still holds for those children", !!deep.err && /helpers don't spawn helpers/.test(deep.err), deep.err || "it spawned"); }
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : "all passed"); process.exit(fails ? 1 : 0);
