#!/usr/bin/env node
// J528 proof (Angus: "maybe bonks and decisions should be sent" … "make the name of the ntfy topic be configurable"):
//   node test/phone-push.mjs   (exit 0 = pass; nothing leaves the machine: HYPRPI_PHONE_PUSH_LOG catches the pushes)
// An isolated daemon (temp socket + state + config, no Hyprland, Thoughts' pi = /bin/cat) with a fixture board and a fake agent:
//   A) lib/ntfy.mjs phoneMessage: world · agent · @project, the question, numbered options with (recommended)
//   B) a bonk (status blocked + note) → one "bonk" push; staying blocked → none; a new block later → one more
//   C) a Decide item from the agent (board.item add) → one "decision" push with options; an edit → none
//   D) `ding "…"` (status blocked + decision) → its auto-filed Decide item is pushed once, and no bonk push for it
//   E) a job report, a next/done item, a room post, a heard item → no push; Angus's own Decide item → none
//   F) maxPerHour caps a burst; enabled false sends nothing; `hyprpi ntfy config --json` reads the same settings
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { phoneMessage } from "../lib/ntfy.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();

// ---- A) pure
const m = phoneMessage("decision", { world: "A", agent: "Atlas", project: "boards", text: "N3: Ship it?", options: [{ key: "a", text: "now" }, { key: "b", text: "later" }], recommend: "a" });
ok("A title names the decision and world", m.title.startsWith("🔔 Decision (world A): N3: Ship it?"), m.title);
ok("A body: World A · Atlas · @boards, question, options", m.message === "World A · Atlas · @boards\nN3: Ship it?\na. now (recommended)\nb. later", JSON.stringify(m.message));
const m9 = phoneMessage("decision", { text: "pick", options: Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1), text: `option ${i + 1}` })), recommend: "9" });
ok("A all 9 options shown, the recommended last one too", /\n9\. option 9 \(recommended\)$/.test(m9.message), JSON.stringify(m9.message));
ok("A bonk title names the agent", phoneMessage("bonk", { world: "B", agent: "Bolt", text: "look" }).title === "❗ Bolt needs you (world B)");

// ---- R) omnistation/remote.sh install's edit of a remote world's hyprpi.jsonc (its node snippet, run as remote.sh runs it)
{
  const { parseJsonc } = await import("../lib/policy.mjs");
  const src = fs.readFileSync(path.join(ROOT, "omnistation/remote.sh"), "utf8");
  const a = src.indexOf("node -e '\n        const fs = require(\"fs\"), [p, raw]"), b = src.indexOf("' \"$p\" \"$HYPRPI_REMOTE_NTFY\"", a);
  const code = src.slice(a + "node -e '".length, b), R = fs.mkdtempSync(path.join(os.tmpdir(), "j528r-")), nt = JSON.stringify({ enabled: true, topic: "angus-brev" });
  { const f = path.join(R, "zero.jsonc"); spawnSync(process.execPath, ["-e", code, f, JSON.stringify({ enabled: true, topic: "t-zero-1", maxPerHour: 0 })]); ok("R maxPerHour 0 (no cap) is copied as 0", parseJsonc(fs.readFileSync(f, "utf8")).phone.ntfy.maxPerHour === 0); }
  const edit = (name, text) => { const f = path.join(R, name); if (text !== null) fs.writeFileSync(f, text); spawnSync(process.execPath, ["-e", code, f, nt]); return fs.readFileSync(f, "utf8"); };
  const cases = {
    "no file": [null], "plain JSON": ['{ "user": { "name": "A" } }'],
    "jsonc, a phone entry with comments, braces in strings, extra keys": ['// c\n{\n  "user": { "name": "A" }, // x\n  "phone": { // p\n    "ntfy": { "topic": "old}", "x": { "a": 1 } /* } */ }\n  },\n  "z": "\\"phone\\""\n}\n'],
    "jsonc without a phone entry, ending in a // comment": ['// c\n{\n  "user": { "name": "A" } // x\n}\n'],
    "a nested \"phone\" only": ['{\n  "x": { "phone": 1 } // y\n}\n'],
    "a top-level string VALUE \"phone\" (not a key)": ['{\n// c\n"label": "phone", "nested": {"ok": true}\n}\n'],
    "a scalar phone entry before another entry": ['{\n// c\n"phone": null, "nested": {"ok": true}\n}\n'],
  };
  for (const [n, [t]] of Object.entries(cases)) {
    const out = edit(n.replace(/\W+/g, "-"), t); let j = null; try { j = parseJsonc(out); } catch { /* bad */ }
    ok(`R remote.sh hyprpi.jsonc edit, ${n}: parses, one phone entry with the new topic, the rest kept`, j?.phone?.ntfy?.topic === "angus-brev" && j.phone.ntfy.enabled === true && (out.match(/"phone"\s*:/g) || []).length === 1 + (n.includes("nested") ? 1 : 0) && (!t || !/"user"/.test(t) || j.user?.name === "A") && (!/"z"/.test(t || "") || j.z === '"phone"') && (!/"label"/.test(t || "") || j.label === "phone") && (!/"nested"/.test(t || "") || j.nested?.ok === true), out);
  }
  fs.rmSync(R, { recursive: true, force: true });
}

// ---- B..F) daemon
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j528-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), PUSH = path.join(S, "pushes.jsonl");
fs.mkdirSync(path.join(S, "boards")); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
const POL = path.join(cfg, "hyprpi", "hyprpi.jsonc");
const setPolicy = (ntfy) => fs.writeFileSync(POL, JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } }, phone: { ntfy } }));
setPolicy({ enabled: true, topic: "j528-test", server: "https://ntfy.example", kinds: ["bonk", "decision"], maxPerHour: 12 });
fs.writeFileSync(path.join(S, "boards", "A.json"), JSON.stringify({ room: "A", projects: [{ id: "p-bd", name: "boards", title: "the boards", icon: "📋", status: "active", members: ["hp-atlas"], writer: "hp-atlas", created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [] }] }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j528-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_TEST: "1", HYPRPI_PHONE_PUSH_LOG: PUSH, XDG_STATE_HOME: path.join(S, "xdg"), HYPRPI_HELD_PUSH_MS: "500" };
// two held sandbox messages: one for world A's room panel, one reviewed in a Doorman window (reviewIn, filed under room G)
const PEND = path.join(S, "xdg", "hyprpi", "sbx-relay", "pending"); fs.mkdirSync(PEND, { recursive: true });
fs.writeFileSync(path.join(PEND, "sb1--aaaaaa.json"), JSON.stringify({ id: "sb1--aaaaaa", at: "2026-10-13T10:00:00Z", sandbox: "sb1", rooms: ["A"], shown: ["Atlas (room A)"], text: "may I read your notes?" }));
fs.writeFileSync(path.join(PEND, "sb3--cccccc.json"), JSON.stringify({ id: "sb3--cccccc", at: "2026-10-13T10:02:00Z", sandbox: "sb3", rooms: ["A"], gpu: { hours: 1 }, mode: "talk", shown: ["Atlas (room A)"], text: "a GPU for training" }));
fs.writeFileSync(path.join(PEND, "sb2--bbbbbb.json"), JSON.stringify({ id: "sb2--bbbbbb", at: "2026-10-13T10:01:00Z", sandbox: "sb2", rooms: ["G"], reviewIn: "doorman-g", shown: ["Bolt (room G)"], text: "a GPU lease for 1 h" }));
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), fs.openSync(path.join(S, "d.err"), "w")] });
const pushes = () => { try { return fs.readFileSync(PUSH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
try {
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const angus = await connect({ path: sock, onEvent: () => {} });
  const agent = await connect({ path: sock, onEvent: () => {} });
  await agent.call("agent.hello", { agent_id: "hp-atlas", pid: process.pid, name: "Atlas", icon: "🗺", want_workspace: 2, cwd: S });
  const upd = (p) => agent.call("agent.update", { agent_id: "hp-atlas", ...p });

  // H) held sandbox messages: one decision push each, the Doorman one says where to answer; never again on later scans
  await sleep(1500);
  const H = pushes().filter((x) => x.key.startsWith("decision:held:"));
  ok("H three held messages → three decision pushes", H.length === 3, JSON.stringify(H));
  ok("H a GPU lease offers only 1 / 2 (no 1+, as the room panel)", /\n1\. approve[^\n]*\n2\. deny/.test(H.find((x) => x.key.includes("sb3"))?.message || "") && !/1\+\./.test(H.find((x) => x.key.includes("sb3"))?.message || ""), JSON.stringify(H.find((x) => x.key.includes("sb3"))?.message));
  ok("H the room-panel one: world A, its text, 1/1+/2", /World A · sandbox sb1\nHeld message to Atlas: may I read your notes\?\n1\. approve/.test(H.find((x) => x.key.includes("sb1"))?.message || "") && /Answer it in world A's room panel/.test(H.find((x) => x.key.includes("sb1"))?.message || ""), JSON.stringify(H[0]?.message));
  ok("H the Doorman-reviewed one is pushed too, pointing at its window", /Doorman window \(doorman-g\)/.test(H.find((x) => x.key.includes("sb2"))?.message || ""), JSON.stringify(H[1]?.message));
  await sleep(1200);
  ok("H no repeat on later scans", pushes().filter((x) => x.key.startsWith("decision:held:")).length === 3);
  fs.writeFileSync(PUSH, ""); // the rest counts from zero
  // B) bonk
  await upd({ status: "working" }); await upd({ status: "blocked", quiet: true, note: "the build needs your password" }); await sleep(200);
  let P = pushes();
  ok("B a bonk → one push", P.length === 1 && P[0].kind === "bonk", JSON.stringify(P));
  ok("B it says world, agent, project and the note", P[0]?.title === "❗ 🗺 Atlas needs you (world A)" && P[0]?.message.startsWith("World A · 🗺 Atlas · @boards\nthe build needs your password"), JSON.stringify(P[0]));
  ok("B topic and server from hyprpi.jsonc", P[0]?.topic === "j528-test" && P[0]?.server === "https://ntfy.example");
  await upd({ status: "blocked", quiet: true, note: "the build needs your password" }); await upd({ status: "idle" }); await sleep(200);
  ok("B still blocked (and its idle) → no repeat", pushes().length === 1);
  await upd({ status: "working" }); await sleep(20); await upd({ status: "blocked", quiet: true, note: "one more thing" }); await sleep(200);
  ok("B a new block later → one more push", pushes().length === 2 && pushes()[1].message.includes("one more thing"));
  await upd({ status: "working" });

  // B2) a bonk while already blocked (here on the decision below it would be the same): a new message is pushed once
  await upd({ status: "blocked", quiet: true, note: "also: the disk is nearly full" }); await sleep(200);
  ok("B a second, different bonk during the same block → one push", pushes().length === 3 && pushes()[2].message.includes("disk is nearly full"), String(pushes().length));
  await upd({ status: "blocked", quiet: true, note: "also: the disk is nearly full" }); await upd({ status: "blocked", quiet: true }); await sleep(200);
  ok("B the same message again, or a bare blocked → no push", pushes().length === 3);
  const long = "x".repeat(400);
  await upd({ status: "blocked", quiet: true, note: long + " FIRST" }); await upd({ status: "blocked", quiet: true, note: long + " SECOND" }); await sleep(200);
  ok("B two long messages that differ only at the end → two pushes", pushes().length === 5, String(pushes().length));
  fs.writeFileSync(PUSH, fs.readFileSync(PUSH, "utf8").split("\n").slice(0, 2).join("\n") + "\n"); // the counts below go on from the first 2 bonks
  // C) a Decide item from the agent
  const r = await agent.call("board.item", { action: "add", project: "boards", section: "decide", text: "Ship the new boards today?", options: ["yes, today", "wait for review"], recommend: "b" });
  await sleep(200); P = pushes();
  ok("C a Decide item → one decision push", P.length === 3 && P[2].kind === "decision", JSON.stringify(P.at(-1)));
  ok("C with world, agent, project, question and numbered options", P[2]?.message === `World A · Atlas · @boards\n${r.item.h}: Ship the new boards today?\na. yes, today\nb. wait for review (recommended)\nAnswer on the board (Projects panel or the phone app).`, JSON.stringify(P[2]?.message));
  await agent.call("board.item", { action: "edit", project: "boards", h: r.item.h, text: "Ship the new boards today (v2)?" }); await sleep(200);
  ok("C editing it → no repeat", pushes().length === 3);

  // D) ding: a decision block files a Decide item (autoDecide): pushed once, as a decision (no bonk push too).
  //    (Another agent: autoDecide skips an agent that added a Decide item itself in the last 2 min, as Atlas just did.)
  const bolt = await connect({ path: sock, onEvent: () => {} });
  await bolt.call("agent.hello", { agent_id: "hp-bolt", pid: process.pid, name: "Bolt", want_workspace: 3, cwd: S });
  await angus.call("board.project", { action: "assign", project: "boards", members: "+hp-bolt", room: "A" }).catch((e) => console.log("assign:", e.message));
  await bolt.call("agent.update", { agent_id: "hp-bolt", status: "working" });
  await bolt.call("agent.update", { agent_id: "hp-bolt", status: "blocked", quiet: true, decision: "Which colour for the bar? 1. teal 2. amber" }); await sleep(300);
  P = pushes();
  ok("D ding → exactly one push, a decision", P.length === 4 && P[3].kind === "decision" && /Which colour for the bar/.test(P[3].message) && /World A · Bolt/.test(P[3].message), JSON.stringify(P.slice(3)));
  await bolt.call("agent.update", { agent_id: "hp-bolt", status: "working" });

  // E) none of these push
  await agent.call("board.item", { action: "add", project: "boards", section: "next", text: "tidy the card" });
  await agent.call("board.item", { action: "add", project: "boards", section: "done", text: "J1 shipped", verified: "tests" });
  await agent.call("board.item", { action: "add", project: "boards", section: "heard", text: "Angus said hi", prio: 1 });
  await agent.call("room.post", { text: "=== J1 v1 ===\nchanged: x\nproof: W1 → ok", room: "A" }).catch(() => {});
  await angus.call("board.item", { action: "add", project: "boards", section: "decide", text: "Angus's own question to himself", room: "A" });
  await upd({ status: "done" }); await sleep(300);
  ok("E job report / next / done / heard / room post / Angus's own Decide item → no push", pushes().length === 4, JSON.stringify(pushes().slice(4)));

  // F) maxPerHour, enabled false
  setPolicy({ enabled: true, topic: "j528-test", maxPerHour: 11 }); await sleep(50); // 10 sent this hour (3 held + 5 bonks + 2 decisions)
  for (let i = 0; i < 3; i++) await agent.call("board.item", { action: "add", project: "boards", section: "decide", text: `burst question ${i}`, options: ["a", "b"] });
  await sleep(300);
  ok("F maxPerHour 11: a burst of 3 more sends only 1 (11 in the last hour)", pushes().length === 5, String(pushes().length));
  ok("F what went over is logged, not queued", /phone push: over 11\/hour, dropped/.test(fs.readFileSync(path.join(S, "d.err"), "utf8") + fs.readFileSync(path.join(S, "d.log"), "utf8")));
  setPolicy({ enabled: false, topic: "j528-test", maxPerHour: 100 }); await sleep(50);
  await agent.call("board.item", { action: "add", project: "boards", section: "decide", text: "while off", options: ["a"] });
  await upd({ status: "working" }); await upd({ status: "blocked", quiet: true, note: "while off" }); await sleep(300);
  ok("F enabled false → nothing sent", pushes().length === 5);
  setPolicy({ enabled: true, topic: "angus-x", server: "https://ntfy.example/", maxPerHour: 7 });
  const c = spawnSync(process.execPath, [path.join(ROOT, "bin/hyprpi"), "ntfy", "config", "--json"], { env, encoding: "utf8" });
  const j = JSON.parse(c.stdout || "{}");
  ok("F hyprpi ntfy config --json reads hyprpi.jsonc (brev-autostop's source)", j.enabled === true && j.topic === "angus-x" && j.server === "https://ntfy.example" && j.maxPerHour === 7, c.stdout + c.stderr);
  angus.close?.(); agent.close?.();
} finally { d.kill(); }
// (J575: wait for the daemon to exit before removing its state dir: it could still be writing there, and rmSync then failed
// with ENOTEMPTY after every check had passed)
if (d.exitCode === null && d.signalCode === null) await new Promise((r) => { d.once("exit", r); setTimeout(r, 5000); });
console.log(fails ? `${fails} FAILED (state ${S})` : "all passed");
if (!fails) fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(fails ? 1 : 0);
