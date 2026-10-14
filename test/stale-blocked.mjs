#!/usr/bin/env node
// J601 proof (Angus: "no, just make sure you are able to get the correct info without me being nvolved"):
//   node test/run.mjs test/stale-blocked.mjs   (exit 0 = pass)
// Dossier (world C, 2026-10-14): mid-turn it filed a Decide item (board_update decide → dingFor), which flipped its status
// from working to blocked AT ONCE. Its turn's end (21:37Z) then read as "blocked → blocked": no ✓, no wake, no resend, and
// "blocked" outlived the turn, so Thoughts' digests said "Dossier: blocked", give_work refused it ("Dossier is blocked right
// now") and upkeep's auto-reload skipped it, while Angus saw it idle at its prompt.
// An isolated daemon (temp socket + state + config, no Hyprland, Thoughts' pi = /bin/cat so no model runs) and fake agents:
//   A) the repro: a Decide item filed mid-turn keeps the agent "working" (its run is still going); the turn's end is seen
//      (a wake on it fires) and only then the × shows, with what it waits on (list: run done, blocked_on, takes_work);
//      Thoughts' world tool says so, and give_work / ask_agent reach it without urgent; its next turn clears the ×
//   B) a bonk at the prompt still holds it: give_work / ask_agent refuse, naming the bonk; working again clears it
//   C) a bonk mid-turn: still "working" until the turn ends, then ×; one push for it, none again at the turn's end
//   D) Angus answering the Decide item on the board clears the × (as before)
//   E) the self-check: a decision that goes away by a path that doesn't clear the agent (its card archived) → the × is
//      corrected back to the agent's run state, with a log line
//   F) a daemon restart keeps what a × waits on: answering the decision afterwards still clears it (openDings was lost)
//   G) `ding "question"` mid-turn: still working; at the turn's end × on the Decide item it filed; answering it clears it
// Builder checklist (isolated-app-tests): it ends only the daemon it spawned (by the pid spawn gave it); no fake /proc is
// needed (nothing reads processes); the fake agents are socket clients of that temp daemon; nothing reads the live socket,
// Hyprland (bogus signature) or the live state dir.
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();

const S = fs.mkdtempSync(path.join(os.tmpdir(), "j601-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock"), PUSH = path.join(S, "pushes.jsonl");
fs.mkdirSync(path.join(S, "boards")); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } }, phone: { ntfy: { enabled: true, topic: "j601-test", server: "https://ntfy.example", kinds: ["bonk", "decision"], maxPerHour: 100 } } }));
const proj = (id, name) => ({ id, name, title: name, icon: "📋", status: "active", members: ["hp-dossier"], writer: "hp-dossier", created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [] });
fs.writeFileSync(path.join(S, "boards", "A.json"), JSON.stringify({ room: "A", projects: [proj("p-mb", "mathbac"), proj("p-old", "oldcard")] }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: path.join(S, "xdg"), HYPRLAND_INSTANCE_SIGNATURE: "j601-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_TEST: "1", HYPRPI_PHONE_PUSH_LOG: PUSH, HYPRPI_BLOCKCHECK_MS: "300" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
let d = null;
const startDaemon = async () => {
  try { fs.rmSync(sock); } catch { /* none */ }
  d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "a"), fs.openSync(path.join(S, "d.err"), "a")] });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
};
const stopDaemon = async () => { if (!d) return; const x = d; d = null; x.kill(); if (x.exitCode === null && x.signalCode === null) await new Promise((r) => { x.once("exit", r); setTimeout(r, 5000); }); };
const logs = () => ["d.log", "d.err"].map((f) => { try { return fs.readFileSync(path.join(S, f), "utf8"); } catch { return ""; } }).join("\n");
const pushes = () => { try { return fs.readFileSync(PUSH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };

try {
  await startDaemon();
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const api = await connect({ path: sock, onEvent: () => {} }); // Angus / Thoughts (a non-agent connection)
  const got = [];
  let dossier = await connect({ path: sock, onEvent: (ev, data) => got.push({ ev, data }) });
  await dossier.call("agent.hello", { agent_id: "hp-dossier", pid: process.pid, name: "Dossier", icon: "🕵", want_workspace: 2, cwd: S });
  const watcher = await connect({ path: sock, onEvent: () => {} });
  await watcher.call("agent.hello", { agent_id: "hp-watcher", pid: process.pid + 1, name: "Watcher", icon: "👀", want_workspace: 3, cwd: S });
  const upd = (p) => dossier.call("agent.update", { agent_id: "hp-dossier", ...p });
  const me = async () => (await api.call("list")).agents.find((x) => x.id === "hp-dossier");
  const world = async () => (await api.call("thoughts.world", { room: "A" })).text.split("\n").find((l) => l.startsWith("- Dossier")) || "";
  const giveWork = (goal, extra = {}) => api.call("thoughts.work", { room: "A", agent: "Dossier", goal, angus: "28a for now", done_when: ["W1 the write-up exists"], ...extra });
  ok("setup: Dossier is in room A", (await me())?.room === "A", JSON.stringify(await me()));

  // ---- A) the repro
  await upd({ status: "working" });
  await watcher.call("wake.when", { event: "agent", agent: "Dossier", note: "brief it" });
  const r = await dossier.call("board.item", { action: "add", project: "mathbac", section: "decide", text: "28. how to go on?", options: ["write it up", "train longer"], recommend: "a" });
  const D = r.item.h;
  let a = await me();
  ok("A a Decide item filed mid-turn leaves it working (its run is still going)", a.status === "working" && a.run === "working", `${a.status}/${a.run}`);
  await upd({ status: "done" }); await sleep(400);
  a = await me();
  ok("A at its turn's end the × shows, on top of its run state (done)", a.status === "blocked" && a.run === "done", `${a.status}/${a.run}`);
  ok("A list says what the × waits on and that it takes work", JSON.stringify(a.blocked_on) === JSON.stringify([`decision @mathbac ${D}`]) && a.takes_work === true, JSON.stringify(a));
  const wk = JSON.parse(fs.readFileSync(path.join(S, "wakes.json"), "utf8"));
  const wl = (Array.isArray(wk) ? wk : wk.wakes || []).find((w) => w.target === "hp-dossier");
  ok("A the turn's end is seen: the wake on Dossier fired", /Dossier finished its turn/.test(wl?.why || ""), JSON.stringify(wk));
  const wline = await world();
  ok("A Thoughts' world tool: blocked on the decision, turn over, give_work reaches it", new RegExp(`blocked: waiting on Angus \\(decision @mathbac ${D}\\); its turn is over, at its prompt: give_work / ask_agent still reach it`).test(wline), wline);
  got.length = 0;
  const gw = await err(() => giveWork("write up the T5 round"));
  ok("A give_work without urgent is accepted (was: \"Dossier is blocked right now\")", gw === "", gw);
  await sleep(300);
  ok("A Dossier got the brief", got.some((g) => /write up the T5 round/.test(JSON.stringify(g.data))), JSON.stringify(got).slice(0, 300));
  await upd({ status: "working" });
  a = await me();
  ok("A its next turn clears the ×", a.status === "working" && !a.blocked_on, JSON.stringify(a));
  await upd({ status: "done" }); await sleep(200);
  a = await me();
  ok("A that turn ends done (the open decision doesn't re-block it)", a.status === "done" && a.run === "done", `${a.status}/${a.run}`);
  const ask = await err(() => api.call("thoughts.ask", { room: "A", agent: "Dossier", question: "status?" }));
  ok("A ask_agent reaches a done agent", ask === "", ask);

  // independent checks: a decision-only overlay accepts ask, but a pending block never makes a live run free.
  await upd({ status: "working" });
  const edge = await dossier.call("board.item", { action: "add", project: "mathbac", section: "decide", text: "Edge decision", options: ["yes", "no"] });
  ok("EDGE working agent with pending decision refuses work", /is working/.test(await err(() => giveWork("must not deliver"))));
  await upd({ status: "done" });
  ok("EDGE ask_agent reaches decision-blocked agent", (await err(() => api.call("thoughts.ask", { room: "A", agent: "Dossier", question: "a different question?" }))) === "");
  await upd({ status: "working" });
  await api.call("board.item", { room: "A", action: "decide", project: "mathbac", h: edge.item.h, answer: "a" });
  await upd({ status: "done" });
  ok("EDGE decision answered mid-turn never blocks its end", (await me()).status === "done");

  // ---- B) a bonk at the prompt still holds it
  await upd({ status: "blocked", quiet: true, note: "need your brev login" });
  a = await me();
  ok("B a bonk at the prompt: blocked, run done, doesn't take work", a.status === "blocked" && a.run === "done" && a.takes_work === false && a.blocked_on.includes('a bonk: "need your brev login"'), JSON.stringify(a));
  const gb = await err(() => giveWork("other work"));
  ok("B give_work refuses, naming the bonk", /Dossier is blocked: waiting on Angus \(.*a bonk: "need your brev login"\); its turn is over right now/.test(gb), gb);
  ok("B ask_agent refuses too", /is blocked: waiting on Angus/.test(await err(() => api.call("thoughts.ask", { room: "A", agent: "Dossier", question: "x?" }))));
  ok("B urgent still goes through", (await err(() => giveWork("urgent work", { urgent: true }))) === "");
  await upd({ status: "working" });
  ok("B working again clears it", (await me()).status === "working");

  // ---- C) a bonk mid-turn
  const p0 = pushes().filter((x) => x.kind === "bonk" || /bonk/.test(x.key || "")).length;
  await upd({ status: "blocked", quiet: true, note: "look at the plot" });
  a = await me();
  ok("C a bonk mid-turn leaves it working", a.status === "working" && a.run === "working", `${a.status}/${a.run}`);
  await sleep(200);
  const p1 = pushes().filter((x) => x.kind === "bonk" || /bonk/.test(x.key || "")).length;
  ok("C its push goes out at once", p1 === p0 + 1, `${p0} → ${p1}`);
  await upd({ status: "done" }); await sleep(300);
  a = await me();
  ok("C at the turn's end: ×, run done, held (a bonk)", a.status === "blocked" && a.run === "done" && a.takes_work === false, JSON.stringify(a));
  ok("C no second push at the turn's end", pushes().filter((x) => x.kind === "bonk" || /bonk/.test(x.key || "")).length === p1);
  await upd({ status: "working" }); await upd({ status: "done" });
  ok("C working again clears it; the next turn ends done", (await me()).status === "done");

  // independent check: a board decision layered over a bonk cannot erase the bonk.
  await upd({ status: "working" });
  await upd({ status: "blocked", quiet: true, note: "held bonk" });
  const both = await dossier.call("board.item", { action: "add", project: "mathbac", section: "decide", text: "Edge layered decision", options: ["yes", "no"] });
  await api.call("board.item", { room: "A", action: "decide", project: "mathbac", h: both.item.h, answer: "a" });
  await upd({ status: "done" }); await sleep(500);
  ok("EDGE answering decision leaves bonk held", (await me()).status === "blocked" && (await me()).takes_work === false && /a bonk/.test((await me()).blocked_on.join(" ")));
  await upd({ status: "working" }); await upd({ status: "done" });

  // ---- D) Angus answers the Decide item on the board
  await upd({ status: "working" });
  const r2 = await dossier.call("board.item", { action: "add", project: "mathbac", section: "decide", text: "29. which seed?", options: ["1", "2"] });
  await upd({ status: "done" }); await sleep(200);
  a = await me();
  ok("D blocked on the new decision, and on D1 (still open on the board: Angus answered it in chat only)", a.status === "blocked" && JSON.stringify(a.blocked_on) === JSON.stringify([`decision @mathbac ${D}`, `decision @mathbac ${r2.item.h}`]), JSON.stringify(a.blocked_on));
  await api.call("board.item", { room: "A", action: "decide", project: "mathbac", h: r2.item.h, answer: "a" });
  await sleep(200);
  a = await me();
  ok("D answering the new one leaves the × on D1 alone", a.status === "blocked" && JSON.stringify(a.blocked_on) === JSON.stringify([`decision @mathbac ${D}`]), JSON.stringify(a.blocked_on));
  await api.call("board.item", { room: "A", action: "decide", project: "mathbac", h: D, answer: "a" });
  await sleep(200);
  a = await me();
  ok("D answering D1 on the board clears the ×", a.status === "idle" && a.run === "done" && !a.blocked_on, `${a.status}/${a.run}`);

  // Independent regression: a different ding after a recent board decision is not filed by autoDecide.
  await upd({ status: "working" });
  const skipped = await dossier.call("board.item", { action: "add", project: "mathbac", section: "decide", text: "Edge seed question", options: ["1", "2"] });
  await upd({ status: "blocked", quiet: true, decision: "Different window-only question: which GPU? a) A100 b) L40S" });
  await upd({ status: "done" }); await sleep(400);
  a = await me();
  ok("REGRESSION unfiled ding must hold despite an existing board question", a.status === "blocked" && a.takes_work === false, JSON.stringify(a.blocked_on) + " takes_work=" + a.takes_work);
  ok("REGRESSION work must refuse for the unfiled ding", /is blocked/.test(await err(() => giveWork("must not reach unfiled ding"))));
  await api.call("board.item", { room: "A", action: "decide", project: "mathbac", h: skipped.item.h, answer: "a" });
  await sleep(400);
  ok("REGRESSION answering seed must not erase different window-only question", (await me()).status === "blocked", (await me()).status);
  await upd({ status: "working" }); await upd({ status: "done" });

  // ---- E) the self-check
  await upd({ status: "working" });
  await dossier.call("board.item", { action: "add", project: "oldcard", section: "decide", text: "30. keep the old card?", options: ["yes", "no"] });
  await upd({ status: "done" }); await sleep(200);
  ok("E blocked on the old card's decision", (await me()).status === "blocked");
  await api.call("board.project", { room: "A", action: "update", project: "oldcard", status: "archived" });
  await sleep(900); // HYPRPI_BLOCKCHECK_MS=300
  a = await me();
  ok("E its card archived (no clearDing): the self-check puts it back to its run state", a.status === "idle" && !a.blocked_on, JSON.stringify(a));
  ok("E and logs it", /status check: Dossier was blocked with nothing open/.test(logs()));

  // ---- G) `ding "question"` mid-turn (hyprpi status blocked --decision): filed on the board, the × at the turn's end
  await upd({ status: "working" });
  await upd({ status: "blocked", quiet: true, decision: "32. which GPU?\na) A100\nb) L40S" });
  a = await me();
  ok("G a ding mid-turn leaves it working", a.status === "working", a.status);
  await upd({ status: "done" }); await sleep(300);
  a = await me();
  const gh = (await api.call("board.get", { room: "A" })).projects.find((x) => x.name === "mathbac").items.find((it) => it.sec === "decide" && /which GPU/.test(it.text))?.h;
  ok("G at the turn's end: × on the filed decision, takes work", a.status === "blocked" && !!gh && JSON.stringify(a.blocked_on) === JSON.stringify([`decision @mathbac ${gh}`]) && a.takes_work === true, JSON.stringify(a.blocked_on) + " " + gh);
  await api.call("board.item", { room: "A", action: "decide", project: "mathbac", h: gh, answer: "b" });
  await sleep(200);
  ok("G answering it clears the ×", (await me()).status === "idle");

  // ---- F) a daemon restart keeps what the × waits on
  await upd({ status: "working" });
  const r3 = await dossier.call("board.item", { action: "add", project: "mathbac", section: "decide", text: "31. 8B?", options: ["yes", "no"] });
  await upd({ status: "done" }); await sleep(300);
  ok("F blocked before the restart", (await me()).status === "blocked");
  api.close?.(); dossier.close?.(); watcher.close?.();
  await stopDaemon(); await startDaemon();
  const api2 = await connect({ path: sock, onEvent: () => {} });
  dossier = await connect({ path: sock, onEvent: () => {} });
  await dossier.call("agent.hello", { agent_id: "hp-dossier", pid: process.pid, name: "Dossier", icon: "🕵", want_workspace: 2, cwd: S });
  await dossier.call("agent.update", { agent_id: "hp-dossier", status: "done", resync: true }); // what its extension re-states
  await sleep(700);
  a = (await api2.call("list")).agents.find((x) => x.id === "hp-dossier");
  ok("F after the restart: still ×, waiting on the same decision, run done", a.status === "blocked" && a.run === "done" && JSON.stringify(a.blocked_on) === JSON.stringify([`decision @mathbac ${r3.item.h}`]), JSON.stringify(a));
  await api2.call("board.item", { room: "A", action: "decide", project: "mathbac", h: r3.item.h, answer: "b" });
  await sleep(200);
  a = (await api2.call("list")).agents.find((x) => x.id === "hp-dossier");
  ok("F answering it after the restart clears the × (it couldn't: openDings was lost)", a.status === "idle", a.status);
  api2.close?.(); dossier.close?.();
} finally { await stopDaemon(); }
console.log(fails ? `${fails} FAILED (state ${S})` : "all passed");
if (!fails) fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(fails ? 1 : 0);
