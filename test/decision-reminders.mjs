#!/usr/bin/env node
// J650 proof (Angus: "for important decisions … if i miss it, i want you to remind me every ... 10 minutes"; his answers
// 43a two levels, 44b agent + project default + Angus on the card, 45 stop by answering or on his word through the agent
// or Thoughts, 46a no quiet hours, 47a 12 rounds then "still waiting, no more reminders", 48b phone + desktop toast):
//   node test/run.mjs test/decision-reminders.mjs   (exit 0 = pass)
// A) lib/decision-reminders.mjs on a fake clock: levels and project defaults, one round per interval listing every open
//    important decision (never one push per item), toast with each round, stop / snooze / resume, the 12-round cap with
//    its last push, a sleeping laptop (one round after waking, not the missed ones), answered items dropped, skipped rooms
// B) an isolated daemon (temp socket + state + config, no Hyprland, Thoughts' pi = /bin/cat, phone pushes to a log file,
//    desktop toasts to the notify log, a 0.02-minute interval): an agent files an important decision → rounds arrive;
//    a project default makes a plain decision important; Thoughts' decision_reminders (thoughts.remind) stops it on Angus's
//    word; board_update edit snooze / resume; answering ends it; the panel's level change (board.item edit as Angus)
// Builder checklist (isolated-app-tests): it ends only the daemon it spawned (by its pid); no fake /proc needed; the fake
// agent is a socket client of that temp daemon; no real phone push (HYPRPI_PHONE_PUSH_LOG) or desktop notification
// (HYPRPI_NOTIFY_LOG); nothing reads the live socket, Hyprland (bogus signature) or the live state dir.
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createReminders, levelOf } from "../lib/decision-reminders.mjs";
import { phoneMessage } from "../lib/ntfy.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M = 60e3;

// ---- A) the engine on a fake clock
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "j650a-"));
  let t = 1_000_000_000_000;
  const pushes = [], toasts = [];
  const dec = (h, extra = {}) => ({ h, sec: "decide", text: `question ${h}`, options: [{ key: "a", text: "yes" }, { key: "b", text: "no" }], recommend: "a", ts: t, ...extra });
  const mb = { id: "p-mb", name: "mathbac", status: "active", items: [] }, hp = { id: "p-hp", name: "hyprpi", status: "active", items: [] };
  const boards = [{ room: "C", projects: [mb, hp], unfiled: [] }, { room: "G", projects: [{ id: "p-g", name: "gproj", status: "active", items: [dec("D1", { importance: "important" })] }] }];
  let conf = { remindEveryMin: 10, remindRounds: 12, toast: true, projects: { mathbac: "important" } };
  const R = createReminders({ stateFile: path.join(T, "r.json"), boards: () => boards, policy: () => conf, push: (k, i) => { pushes.push({ k, ...i }); return { sent: true }; }, toast: (x) => toasts.push(x), now: () => t, skipRoom: (r) => r === "G" });
  ok("A levelOf: own level wins, else project default, else normal", levelOf({ importance: "normal" }, mb, conf) === "normal" && levelOf({}, mb, conf) === "important" && levelOf({}, hp, conf) === "normal" && levelOf({ importance: "important" }, hp, conf) === "important");
  hp.items.push(dec("D1")); // normal: never reminded
  mb.items.push(dec("D6")); // important by project default
  hp.items.push(dec("D2", { importance: "important" }));
  t += 9 * M; ok("A nothing before the first interval", R.tick() === null && pushes.length === 0);
  t += 1 * M; let r = R.tick();
  ok("A one round at 10 min, listing both important decisions (one push, not one per item)", pushes.length === 1 && r?.sent.length === 2 && /@mathbac D6/.test(pushes[0].text) && /@hyprpi D2/.test(pushes[0].text) && !/@hyprpi D1/.test(pushes[0].text), JSON.stringify(r));
  ok("A the round carries the options and the recommendation", /a\. yes \(recommended\)/.test(pushes[0].text) && /b\. no/.test(pushes[0].text));
  ok("A its title says what it is", /Reminder: 2 important decisions waiting/.test(pushes[0].title), pushes[0].title);
  ok("A a desktop toast with the round", toasts.length === 1 && toasts[0].title === pushes[0].title);
  ok("A a skipped room (sandboxed world's host board) isn't reminded", !/gproj/.test(pushes[0].text));
  const m = phoneMessage("decision", pushes[0]);
  ok("A the phone message keeps the round's title and lines", m.title === pushes[0].title && m.message.includes("@mathbac D6") && m.message.split("\n").length > 3, m.message.slice(0, 120));
  t += 5 * M; ok("A nothing between rounds", R.tick() === null && pushes.length === 1);
  t += 5 * M; R.tick(); ok("A the next round 10 min later", pushes.length === 2);
  // a new important item joins the round once its own first push is an interval old
  t += 7 * M; mb.items.push(dec("D7")); // filed 7 min after a round (its own first push: now)
  t -= 7 * M;
  t += 10 * M; R.tick(); ok("A a brand-new item waits for its own interval (no double push)", pushes.length === 3 && !/D7/.test(pushes[2].text));
  t += 10 * M; R.tick(); ok("A then it joins the same round", pushes.length === 4 && /D7/.test(pushes[3].text) && /D6/.test(pushes[3].text));
  // stop (on Angus's word) and snooze
  hp.items.find((x) => x.h === "D2").remindOff = { by: "Thoughts-C", ts: t };
  mb.items.find((x) => x.h === "D7").snoozeUntil = t + 30 * M;
  t += 10 * M; R.tick(); ok("A a stopped item and a snoozed one are left out", pushes.length === 5 && !/D2/.test(pushes[4].text) && !/D7/.test(pushes[4].text) && /D6/.test(pushes[4].text), pushes[4].text);
  t += 30 * M; R.tick(); ok("A after its snooze it comes back (one round, not one per missed interval)", pushes.length === 6 && /D7/.test(pushes[5].text));
  // answered: it leaves the Decide section, and its state goes
  mb.items.find((x) => x.h === "D7").sec = "next";
  t += 10 * M; R.tick(); ok("A an answered decision isn't reminded, and its state is dropped", !/D7/.test(pushes[6].text) && !Object.keys(R.state().items).some((k) => k.endsWith(":D7")));
  // the cap: D6 has had 6 rounds (10,20,30?,...): run on until it caps
  const before = pushes.length;
  for (let i = 0; i < 20; i++) { t += 10 * M; R.tick(); }
  const d6 = pushes.slice(before).filter((p) => /D6/.test(p.text));
  ok("A the cap: 12 rounds in all for D6, the last one says no more reminders", R.state().items["C:p-mb:D6"]?.rounds === 12 && R.state().items["C:p-mb:D6"]?.capped && /no more reminders/i.test(pushes.filter((p) => /D6/.test(p.text)).pop().title + pushes.filter((p) => /D6/.test(p.text)).pop().text), JSON.stringify(R.state().items["C:p-mb:D6"]));
  ok("A after the cap, nothing more about it", d6.length > 0 && !pushes.slice(pushes.indexOf(d6[d6.length - 1]) + 1).some((p) => /D6/.test(p.text)));
  ok("A the last push alone is titled 'Still waiting, no more reminders'", pushes.some((p) => /^🔔 Still waiting, no more reminders: 1 decision$/.test(p.title)), pushes.map((p) => p.title).slice(-3).join(" | "));
  // a sleeping laptop: a long gap gives ONE round
  mb.items.push(dec("D8", { importance: "important" }));
  t += 10 * M; R.tick(); const n0 = pushes.length;
  t += 180 * M; R.tick(); ok("A after 3 h asleep: one round, not 18", pushes.length === n0 + 1);
  ok("A …and it counts as one round", R.state().items["C:p-mb:D8"]?.rounds === 2, JSON.stringify(R.state().items["C:p-mb:D8"]));
  // resume resets the count
  R.reset("C:p-mb:D6"); t += 10 * M; R.tick();
  ok("A reset (resume / new level) starts the count again", /D6/.test(pushes[pushes.length - 1].text) && R.state().items["C:p-mb:D6"]?.rounds === 1);
  // the toast can be turned off; unfiled decisions with their own level count too
  conf = { ...conf, toast: false }; boards[0].unfiled.push(dec("U1", { importance: "important", ts: t - 20 * M }));
  const tn = toasts.length; t += 10 * M; R.tick();
  ok("A toast: false → phone only; an unfiled important decision is in the round", toasts.length === tn && /@unfiled U1/.test(pushes[pushes.length - 1].text));
  // J650check: items filed a minute apart fall into step (no rounds at +10 AND +11)
  {
    let t2 = 2_000_000_000_000; const P2 = [];
    const p2 = { id: "p-x", name: "x", status: "active", items: [] };
    const R3 = createReminders({ stateFile: path.join(T, "r3.json"), boards: () => [{ room: "C", projects: [p2] }], policy: () => ({ remindEveryMin: 10, remindRounds: 12, toast: false }), push: (k, i) => { P2.push(i); return { sent: true }; }, now: () => t2 });
    p2.items.push({ h: "D1", sec: "decide", text: "x", ts: t2, importance: "important" });
    t2 += 1 * M; p2.items.push({ h: "D2", sec: "decide", text: "y", ts: t2, importance: "important" });
    for (let i = 0; i < 30; i++) { t2 += 1 * M; R3.tick(); } // 30 minutes, ticking every minute
    ok("A staggered items share rounds: 3 rounds in 30 min, each with both, none a minute after another", P2.length === 3 && P2.every((x) => /D1/.test(x.text) && /D2/.test(x.text)), String(P2.length));
    // the phone's hourly cap drops a round: nothing counted, retried next minute, the last push isn't lost
    let limited = true; const P3 = [];
    const R4 = createReminders({ stateFile: path.join(T, "r4.json"), boards: () => [{ room: "C", projects: [p2] }], policy: () => ({ remindEveryMin: 10, remindRounds: 2, toast: true }), push: (k, i) => limited ? { sent: false, why: "over maxPerHour (12)" } : (P3.push(i), { sent: true }), toast: () => P3.push({ toast: true }), now: () => t2 });
    for (let i = 0; i < 30; i++) { t2 += 1 * M; R4.tick(); }
    ok("A a round the hourly cap drops isn't counted (no toast either)", P3.length === 0 && !Object.keys(R4.state().items).length, JSON.stringify(R4.state()));
    limited = false; t2 += 1 * M; R4.tick();
    ok("A …and goes out at the next tick once the cap allows", P3.filter((x) => !x.toast).length === 1 && R4.state().items["C:p-x:D1"]?.rounds === 1);
    for (let i = 0; i < 30; i++) { t2 += 1 * M; R4.tick(); }
    ok("A the last 'no more reminders' push still arrives", P3.some((x) => /no more reminders/i.test(x.title || "")) && R4.state().items["C:p-x:D1"]?.capped);
  }
  // state survives a restart of the engine
  const R2 = createReminders({ stateFile: path.join(T, "r.json"), boards: () => boards, policy: () => conf, push: (k, i) => { pushes.push({ k, ...i }); return { sent: true }; }, now: () => t });
  ok("A its counts survive a daemon restart", R2.state().items["C:p-mb:D8"]?.rounds >= 2);
  fs.rmSync(T, { recursive: true, force: true });
}

// ---- B) an isolated daemon
const now = Date.now();
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j650-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), PUSH = path.join(S, "pushes.jsonl"), NOTE = path.join(S, "notify.jsonl");
fs.mkdirSync(path.join(S, "boards")); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
const EVERY_MIN = 0.02; // 1.2 s
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } }, phone: { ntfy: { enabled: true, topic: "j650-test", server: "https://ntfy.example", kinds: ["bonk", "decision"], maxPerHour: 0 } }, decisions: { remindEveryMin: EVERY_MIN, remindRounds: 3, toast: true, projects: { mathbac: "important" } } }));
const proj = (id, name) => ({ id, name, title: name, icon: "📋", status: "active", members: ["hp-dossier"], writer: "hp-dossier", created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [] });
fs.writeFileSync(path.join(S, "boards", "A.json"), JSON.stringify({ room: "A", projects: [proj("p-mb", "mathbac"), proj("p-hp", "hyprpi")] }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(S, "xdg"), HYPRLAND_INSTANCE_SIGNATURE: "j650-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_TEST: "1", HYPRPI_PHONE_PUSH_LOG: PUSH, HYPRPI_NOTIFY_LOG: NOTE, HYPRPI_REMIND_TICK_MS: "200" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
let d = null;
const lines = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const rounds = () => lines(PUSH).filter((p) => String(p.key).startsWith("decision:remind:"));
const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
try {
  d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "a"), fs.openSync(path.join(S, "d.err"), "a")] });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const api = await connect({ path: sock, onEvent: () => {} }); // Angus / Thoughts
  const ag = await connect({ path: sock, onEvent: () => {} });
  await ag.call("agent.hello", { agent_id: "hp-dossier", pid: process.pid, name: "Dossier", icon: "🕵", want_workspace: 2, cwd: S });
  await ag.call("agent.update", { status: "idle" });
  // an agent files an important decision on a normal project, and a plain one on a project whose default is important
  const r1 = await ag.call("board.item", { action: "add", project: "hyprpi", section: "decide", text: "Ship the box now?", options: ["yes", "no"], recommend: "a", importance: "important" });
  const r2 = await ag.call("board.item", { action: "add", project: "mathbac", section: "decide", text: "Next run?", options: ["T6", "stop"] });
  const r3 = await ag.call("board.item", { action: "add", project: "hyprpi", section: "decide", text: "A normal one", options: ["x", "y"] });
  ok("B the item keeps its level", r1.item.importance === "important" && !r2.item.importance && !r3.item.importance);
  const first = lines(PUSH).filter((p) => String(p.key).startsWith("decision:decide:")).length;
  ok("B each decision got its usual one push", first === 3, String(first));
  await sleep(EVERY_MIN * 60e3 + 900);
  let R = rounds();
  ok("B a round arrives after the interval, one push with both important decisions, not the normal one", R.length === 1 && /@hyprpi D1/.test(R[0].message) && /@mathbac D1/.test(R[0].message) && !/A normal one/.test(R[0].message), JSON.stringify(R.map((x) => x.message)));
  ok("B the round's title", /Reminder: 2 important decisions waiting/.test(R[0].title), R[0]?.title);
  ok("B a desktop toast with the round", lines(NOTE).some((n) => n.kind === "notify" && /Reminder: 2 important/.test(n.title || "")));
  // Thoughts stops one on Angus's word
  const s1 = await api.call("thoughts.remind", { room: "A", project: "mathbac", h: r2.item.h, reminders: "stop" });
  ok("B Thoughts stops a decision's reminders", /reminders stopped/.test(s1.said), JSON.stringify(s1));
  const n1 = rounds().length; await sleep(EVERY_MIN * 60e3 + 600);
  R = rounds().slice(n1);
  ok("B the next round leaves the stopped one out", R.length >= 1 && R.every((x) => !/@mathbac/.test(x.message)) && /@hyprpi D1/.test(R[0].message), JSON.stringify(R.map((x) => x.message)));
  // the agent snoozes, then resumes (board_update edit)
  const s2 = await ag.call("board.item", { action: "edit", project: "hyprpi", h: r1.item.h, reminders: "snooze", minutes: 60 });
  ok("B the asking agent can snooze it", /snoozed 60 min/.test(s2.said || "") && s2.item.snoozeUntil > Date.now(), JSON.stringify(s2.said));
  const n2 = rounds().length; await sleep(EVERY_MIN * 60e3 + 600);
  ok("B nothing while every important decision is stopped or snoozed", rounds().length === n2);
  const g = await api.call("board.get", { room: "A" });
  ok("B the card shows it to agents (board_read)", true); // (boardText below)
  const { boardText } = await import(path.join(ROOT, "lib/board.mjs"));
  const txt = boardText(g, (id) => id);
  ok("B board_read marks the level and the state", /D1 Ship the box now\?.*\[important\].*\[reminders snoozed until/.test(txt) && /Next run\?.*\[reminders stopped\]/.test(txt), txt.split("\n").filter((l) => /Ship|Next run/.test(l)).join(" | "));
  await ag.call("board.item", { action: "edit", project: "hyprpi", h: r1.item.h, reminders: "resume" });
  await sleep(EVERY_MIN * 60e3 + 600);
  ok("B resume brings it back", rounds().slice(n2).some((x) => /@hyprpi D1/.test(x.message)));
  // the cap (3 rounds here): the last one says no more reminders
  await sleep(3 * (EVERY_MIN * 60e3) + 1200);
  const last = rounds().filter((x) => /@hyprpi D1/.test(x.message)).pop();
  ok("B after the cap: the last round says so, and no more come", /no more reminders/i.test(last.title + last.message), last.title);
  const n3 = rounds().length; await sleep(EVERY_MIN * 60e3 + 600);
  ok("B …and nothing after it", rounds().length === n3);
  // Angus raises the normal one on the card (the panel's /important = board.item edit as Angus), then answers it
  const s3 = await api.call("board.item", { room: "A", action: "edit", project: "hyprpi", h: r3.item.h, importance: "important" });
  ok("B Angus can make a decision important on the card", s3.item.importance === "important");
  await sleep(EVERY_MIN * 60e3 + 600);
  const n4 = rounds().length;
  ok("B …and it's reminded", rounds().some((x) => /A normal one/.test(x.message)));
  await api.call("board.item", { room: "A", action: "decide", project: "hyprpi", h: r3.item.h, answer: "a" });
  await sleep(EVERY_MIN * 60e3 + 600);
  ok("B answering it ends its reminders", rounds().slice(n4).every((x) => !/A normal one/.test(x.message)));
  // wrong values are refused
  ok("B a bad level is refused", /important or normal/.test(await err(() => ag.call("board.item", { action: "edit", project: "hyprpi", h: r1.item.h, importance: "urgent" }))));
  ok("B reminders on a non-decision are refused", /not an open decision/.test(await err(() => ag.call("board.item", { action: "edit", project: "hyprpi", h: r3.item.h, reminders: "stop" }))));
  api.close?.(); ag.close?.();
} finally { if (d) { d.kill(); await new Promise((r) => { if (d.exitCode !== null) r(); d.once("exit", r); setTimeout(r, 5000); }); } }
console.log(fails ? `${fails} FAILED (state ${S})` : "all passed");
if (!fails) fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(fails ? 1 : 0);
