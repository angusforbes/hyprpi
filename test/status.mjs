// J337 /status: lib/status.mjs (the facts and the prompt). node test/status.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { statusText, statusPrompt, reportGist, unpushedRepos } from "../lib/status.mjs";

let n = 0;
const t = (name, f) => { f(); n++; console.log("ok", name); };
const now = Date.parse("2026-10-09T16:00:00Z"), H = 3600e3;
const base = { room: "B", now, recentH: 6, focus: { kind: "all" }, self: "", agents: [{ name: "Alpha", ws: "B3", status: "working", topic: "maps", projects: ["maps"] }],
  jobs: [
    { id: "J1", version: 2, state: "running", agent: "Alpha", project: "maps", goal: "Draw the map", created: now - 2 * H, updated: now - H, report: "" },
    { id: "J2", version: 1, state: "done", agent: "Beta", project: "maps", goal: "Fix the legend", created: now - 5 * H, updated: now - 2 * H, report: "changed: legend.mjs a1b2c3\nproof: W1 → ok\nopen: Angus picks a colour" },
    { id: "J3", version: 1, state: "verified", agent: "Beta", project: "", goal: "Old thing", created: now - 30 * H, updated: now - 20 * H, report: "x" },
  ],
  projects: [{ name: "maps", title: "Maps", status: "active", where: "Legend fixed", next_step: "Colours", done: ["⟦J2⟧ legend"] }],
  decisions: [{ project: "maps", h: "D1", text: "Which colour?", options: [{ key: "a", text: "Blue" }, { key: "b", text: "Red" }], recommend: "a", by: "Beta", ts: now - H }],
  held: [{ sandbox: "world-g", to: ["Alpha"], text: "hello" }], restart: null, agentRestarts: [], unpushed: [{ repo: "hyprpi", count: 3, latest: "J2: legend" }], children: [] };

t("everything: running, recently done, waiting on Angus, housekeeping", () => {
  const s = statusText(base);
  assert.match(s, /Scope: everything/);
  assert.match(s, /Jobs running:\n- J1 v2 \(Alpha, @maps, running, given 2 h ago\): Draw the map/);
  assert.match(s, /- J2 \(Beta, @maps, reported, not yet verified, 2 h ago\): Fix the legend\n    result: legend.mjs a1b2c3\n    open: Angus picks a colour/);
  assert.doesNotMatch(s, /J3/, "older than the recent window");
  assert.match(s, /decision @maps D1 .*Which colour\? — a\) Blue \(recommended\) · b\) Red/);
  assert.match(s, /held message from sandbox world-g to Alpha: hello/);
  assert.match(s, /1 job reported but not yet verified .*: J2/);
  assert.match(s, /no daemon restart queued/);
  assert.match(s, /unpushed commits: hyprpi 3 \(newest: J2: legend\)/);
});
t("nothing waiting says so", () => assert.match(statusText({ ...base, decisions: [], held: [], jobs: [] }), /Waiting on Angus:\n- nothing/));
t("an unknown focus says it shows everything", () => assert.match(statusText({ ...base, focus: { kind: "unknown", raw: "zzz" } }), /"zzz" is no project or live agent in world B, so this is everything/));
t("an agent's own scope", () => assert.match(statusText({ ...base, self: "Alpha", focus: { kind: "agent", name: "Alpha" }, children: [{ name: "Helper", status: "running", report: "half done" }] }), /Scope: Alpha's own work[\s\S]*Its helper agents:\n- Helper: running · last report: half done/));
t("a queued restart is listed", () => assert.match(statusText({ ...base, restart: { since: now - 600e3, reasons: [{ by: "Lightbox", reason: "J333" }], waiting_on: ["Doorview"] } }), /daemon restart queued 10 min ago \(Lightbox: J333\); waiting on Doorview/));
t("reportGist: the changed field, else the first line", () => { assert.equal(reportGist("changed: a\nb\nproof: x"), "a b"); assert.equal(reportGist("first\nsecond"), "first"); assert.equal(reportGist(""), ""); });
t("prompt: the answer's shape and the facts, for Thoughts and for an agent", () => {
  const th = statusPrompt({ who: "thoughts", facts: "FACTS" }), ag = statusPrompt({ who: "agent", focus: "maps", facts: "FACTS" });
  for (const p of [th, ag]) { assert.match(p, /Running:[\s\S]*Recently done \(last few hours\):[\s\S]*Waiting on you: numbered[\s\S]*Next:/); assert.match(p, /FACTS$/); }
  assert.match(th, /projects and activities/); assert.match(ag, /YOUR OWN current job/); assert.match(ag, /about "maps"/);
});
t("unpushedRepos: only repos ahead of their upstream", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "j337-")), g = (c, ...a) => spawnSync("git", ["-C", c, ...a], { encoding: "utf8" });
  g(d, "init", "-q", "--bare", "up.git"); g(d, "clone", "-q", path.join(d, "up.git"), "ahead");
  const A = path.join(d, "ahead"); for (const m of ["one", "two"]) g(A, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", m);
  g(A, "push", "-q", "origin", "HEAD"); g(A, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "three");
  g(d, "init", "-q", "noupstream"); fs.mkdirSync(path.join(d, "plain"));
  assert.deepEqual(unpushedRepos(d), [{ repo: "ahead", count: 1, latest: "three" }]);
  fs.rmSync(d, { recursive: true, force: true });
});
console.log(`all ${n} passed`);
