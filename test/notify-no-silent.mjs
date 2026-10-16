import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
// J663 (no silent success, J662 / Angus's 37a, 38a): hyprpi's notifications to Angus say whether they got there.
//   node test/run.mjs test/notify-no-silent.mjs   (exit 0 = pass; stand-ins only: a loopback HTTP server for ntfy, fake notifier
//   and bonk scripts in a temp dir, a temp daemon; nothing reaches the real ntfy, the desktop, a speaker or the live daemon)
// A) lib/ntfy.mjs against a stand-in ntfy that fails (500), refuses (closed port), hangs, answers late (after the timeout) and
//    answers 200: push() never says "sent" before ntfy's answer; `confirmed` reports each failure; the first failure of a spell
//    is told once (onTrouble), the rest only logged; a confirmed push ends the spell; the hourly cap's drop is told too
// B) lib/desktop-note.mjs with fake notifiers that fail, hang, answer late, aren't installed, and work (-p id)
// C) lib/bonk-run.mjs with a missing bonk, a bonk that exits non-zero and a working one: logged, told to Thoughts once
// D) a temp daemon whose phone pushes go to a failing stand-in ntfy: a bonk's failed push puts ONE ⚠ in Thoughts-A's thread,
//    the daemon log says "handed to ntfy (not confirmed yet)", never "sent"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createPhonePush } from "../lib/ntfy.mjs";
import { desktopNote } from "../lib/desktop-note.mjs";
import { createBonkRunner } from "../lib/bonk-run.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j663n-"));

// ---- the stand-in ntfy: /fail answers 500, /hang never answers, /late answers 200 after 800 ms, /ok answers 200
const hits = [];
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => {
    hits.push({ url: req.url, body: b });
    if (req.url === "/fail") { res.writeHead(500); res.end("boom"); }
    else if (req.url === "/hang") { /* never */ }
    else if (req.url === "/late") setTimeout(() => { try { res.writeHead(200); res.end("{}"); } catch { /* aborted */ } }, 800);
    else { res.writeHead(200); res.end("{}"); }
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
const closed = http.createServer(); await new Promise((r) => closed.listen(0, "127.0.0.1", r)); const DEAD = `http://127.0.0.1:${closed.address().port}`; await new Promise((r) => closed.close(r));

try {
  // ---- A) ntfy
  {
    const env = { ...process.env }; delete env.HYPRPI_PHONE_PUSH_LOG;
    let conf = { enabled: true, topic: "j663", server: `${BASE}/fail`, kinds: ["bonk", "decision"], maxPerHour: 0 };
    const logs = [], told = [];
    const P = createPhonePush({ stateDir: T, log: (...a) => logs.push(a.join(" ")), policy: () => ({ phone: { ntfy: conf } }), env, timeoutMs: 300, onTrouble: (x) => told.push(x) });
    const said = (re) => logs.some((l) => re.test(l));
    // fails
    let r = P.push("bonk", { key: "k-fail", world: "C" });
    ok("A1 push returns queued, not sent, before ntfy answers", r.queued === true && r.sent !== true && !said(/sent k-fail/), JSON.stringify({ ...r, confirmed: undefined }));
    let c = await r.confirmed;
    ok("A1 a 500 is reported: confirmed.ok false with the status", c.ok === false && /answered 500/.test(c.why), JSON.stringify(c));
    ok("A1 logged as NOT sent, never as sent", said(/NOT sent bonk:k-fail: .*answered 500/) && !said(/: sent bonk:k-fail/), logs.join(" | "));
    ok("A1 the first failure is told once, with its world", told.length === 1 && told[0].kind === "failed" && told[0].world === "C" && /500/.test(told[0].why), JSON.stringify(told));
    // refused
    conf = { ...conf, server: DEAD };
    c = await P.push("bonk", { key: "k-refused" }).confirmed;
    ok("A2 a refused connection is reported", c.ok === false && /ECONNREFUSED|fetch failed/.test(c.why), JSON.stringify(c));
    ok("A2 same spell: not told again", told.length === 1);
    // hangs
    conf = { ...conf, server: `${BASE}/hang` };
    const t0 = Date.now(); c = await P.push("bonk", { key: "k-hang" }).confirmed;
    ok("A3 a hung ntfy: 'no answer within', after the timeout (not before, not much later)", c.ok === false && /no answer .* within .*may or may not have arrived/.test(c.why) && Date.now() - t0 >= 280 && Date.now() - t0 < 3000, `${c.why} after ${Date.now() - t0} ms`);
    // late
    conf = { ...conf, server: `${BASE}/late` };
    c = await P.push("bonk", { key: "k-late" }).confirmed; await sleep(1000);
    ok("A4 an answer after the timeout: reported as no answer, never logged as sent", c.ok === false && /no answer/.test(c.why) && !said(/: sent bonk:k-late/), c.why);
    let st = JSON.parse(fs.readFileSync(path.join(T, "phone-push.json"), "utf8"));
    ok("A5 the spell counts every failure (4) in STATE/phone-push.json", st.trouble?.count === 4 && st.trouble.told === true, JSON.stringify(st.trouble));
    // ok
    conf = { ...conf, server: `${BASE}/ok` };
    c = await P.push("decision", { key: "k-ok", text: "q" }).confirmed;
    ok("A6 a 200 is confirmed, and only then logged as sent", c.ok === true && c.status === 200 && said(/: sent decision:k-ok \(ntfy answered 200\)/), JSON.stringify(c));
    ok("A6 the spell ends, logged with its count", said(/get through again \(4 didn't/) && !JSON.parse(fs.readFileSync(path.join(T, "phone-push.json"), "utf8")).trouble);
    conf = { ...conf, server: `${BASE}/fail` };
    await P.push("bonk", { key: "k-fail2", world: "D" }).confirmed;
    ok("A7 a new spell after a success is told again", told.length === 2 && told[1].world === "D", JSON.stringify(told));
    // cap
    const T2 = fs.mkdtempSync(path.join(os.tmpdir(), "j663c-")), told2 = [], logs2 = [];
    const conf2 = { enabled: true, topic: "j663", server: `${BASE}/ok`, kinds: ["bonk"], maxPerHour: 1 };
    const P2 = createPhonePush({ stateDir: T2, log: (...a) => logs2.push(a.join(" ")), policy: () => ({ phone: { ntfy: conf2 } }), env, timeoutMs: 300, onTrouble: (x) => told2.push(x) });
    await P2.push("bonk", { key: "c1", world: "B" }).confirmed;
    const r2 = P2.push("bonk", { key: "c2", world: "B" }), r3 = P2.push("bonk", { key: "c3", world: "B" });
    ok("A8 over the hourly cap: not sent, and why", r2.sent === false && /maxPerHour/.test(r2.why) && !r2.queued, JSON.stringify(r2));
    ok("A8 the cap's drop is told once (not per push), with the key and world", told2.length === 1 && told2[0].kind === "capped" && told2[0].key === "bonk:c2" && told2[0].world === "B" && r3.sent === false, JSON.stringify(told2));
    // the test log (HYPRPI_PHONE_PUSH_LOG) is a receiver: confirmed when written, failure when it can't be
    const PL = createPhonePush({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "j663l-")), policy: () => ({ phone: { ntfy: { ...conf2, maxPerHour: 0 } } }), env: { HYPRPI_PHONE_PUSH_LOG: path.join(T, "nope", "x.jsonl") } });
    c = await PL.push("bonk", { key: "l1" }).confirmed;
    ok("A9 a push log that can't be written is a failure, not a success", c.ok === false, JSON.stringify(c));
    // J722 nss3a: a key marked before ntfy answers is "already queued or sent", never "already sent"; a failed push isn't retried
    { const hb = hits.length; const again = P.push("bonk", { key: "k-fail" });
      ok("A10 a repeat of a failed key: not sent again, worded as queued-or-sent, no retry", again.sent === false && /already queued or sent/.test(again.why) && !/^already sent/.test(again.why) && !again.queued && hits.length === hb, JSON.stringify(again)); }
  }

  // ---- B) desktop notifications through fake notifiers
  {
    const mk = (name, body) => { const d = path.join(T, "bin-" + name); fs.mkdirSync(d); fs.symlinkSync("/bin/sh", path.join(d, "sh")); if (body) { fs.writeFileSync(path.join(d, "omarchy-notification-send"), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(d, "omarchy-notification-send"), 0o755); } return { ...process.env, PATH: d }; };
    const SLEEP = ["/usr/bin/sleep", "/bin/sleep"].find((f) => fs.existsSync(f));
    const logs = []; const log = (...a) => logs.push(a.join(" "));
    let r = await desktopNote(["--app-name", "t", "title", "body"], { what: "t-fail", log, timeoutMs: 2000, env: mk("fail", 'echo "Failed to connect to bus" >&2; exit 1') });
    ok("B1 a notifier error is reported with its exit code and message, and logged", r.ok === false && /exited 1: Failed to connect to bus/.test(r.why) && logs.some((l) => /t-fail: desktop notification NOT shown/.test(l)), JSON.stringify(r));
    const PIDF = path.join(T, "hang.pid");
    const t0 = Date.now();
    r = await desktopNote(["x"], { what: "t-hang", log, timeoutMs: 300, env: mk("hang", `echo $$ > ${PIDF}; exec ${SLEEP} 30`) });
    let alive = true; await sleep(100); try { process.kill(Number(fs.readFileSync(PIDF, "utf8")), 0); } catch { alive = false; }
    ok("B2 a hung notifier: no answer within the timeout, reported (never hangs the caller), and killed", r.ok === false && /no answer within/.test(r.why) && Date.now() - t0 < 3000 && !alive, `${r.why} alive=${alive}`);
    r = await desktopNote(["x"], { what: "t-late", log, timeoutMs: 300, env: mk("late", `${SLEEP} 1; echo 9; exit 0`) });
    await sleep(1200);
    ok("B3 a notifier answering after the timeout stays a failure", r.ok === false && /no answer/.test(r.why), JSON.stringify(r));
    r = await desktopNote(["x"], { what: "t-none", log, timeoutMs: 2000, env: mk("none", "") });
    ok("B4 no notifier installed (exit 127) is said so", r.ok === false && /no notifier installed/.test(r.why), JSON.stringify(r));
    r = await desktopNote(["x"], { what: "t-nosh", log, timeoutMs: 2000, env: { ...process.env, PATH: path.join(T, "empty") } });
    ok("B5 the notifier can't even start: reported", r.ok === false && /couldn't start/.test(r.why), JSON.stringify(r));
    const before = logs.length;
    r = await desktopNote(["-p", "x"], { what: "t-ok", log, timeoutMs: 2000, env: mk("ok", "echo 42") });
    ok("B6 a notifier that takes it: ok with its id, nothing logged", r.ok === true && r.id === "42" && logs.length === before, JSON.stringify(r));
  }

  // ---- C) bonk
  {
    const logs = [], alerts = []; const log = (...a) => logs.push(a.join(" "));
    const run = createBonkRunner({ bin: path.join(T, "no-such-bonk"), log, alert: (room, text) => alerts.push({ room, text }) });
    run({ name: "Atlas", room: "C" }, ["--ding", "pick one"], process.env); await sleep(300);
    ok("C1 a missing bonk: logged, and told to that world's Thoughts once", logs.some((l) => /ding for Atlas NOT played\/shown: couldn't start .*ENOENT/.test(l)) && alerts.length === 1 && alerts[0].room === "C" && /didn't reach Angus's desktop/.test(alerts[0].text), JSON.stringify({ logs, alerts }));
    run({ name: "Bolt", room: "D" }, ["look"], process.env); await sleep(300);
    ok("C1 a second failure: logged only", logs.filter((l) => /NOT played/.test(l)).length === 2 && alerts.length === 1);
    const bad = path.join(T, "bonk-bad"); fs.writeFileSync(bad, "#!/bin/sh\nexit 3\n"); fs.chmodSync(bad, 0o755);
    const logs2 = [], alerts2 = [];
    createBonkRunner({ bin: bad, log: (...a) => logs2.push(a.join(" ")), alert: (room, text) => alerts2.push({ room, text }) })({ name: "Atlas", room: "A" }, ["x"], process.env); await sleep(500);
    ok("C2 a bonk that exits non-zero: logged and told", logs2.some((l) => /bonk for Atlas NOT played\/shown: .*exited 3/.test(l)) && alerts2.length === 1, JSON.stringify(logs2));
    const good = path.join(T, "bonk-good"); fs.writeFileSync(good, "#!/bin/sh\nexit 0\n"); fs.chmodSync(good, 0o755);
    const logs3 = [];
    createBonkRunner({ bin: good, log: (...a) => logs3.push(a.join(" ")), alert: () => logs3.push("ALERT") })({ name: "Atlas", room: "A" }, ["x"], process.env); await sleep(500);
    ok("C3 a working bonk: nothing logged or told", logs3.length === 0, JSON.stringify(logs3));
    const logs4 = [];
    createBonkRunner({ bin: path.join(T, "no-such-bonk"), log: (...a) => logs4.push(a.join(" ")), alert: null })({ name: "X", room: "H" }, ["x"], process.env); await sleep(300);
    ok("C4 no alert channel (a remote world's machine): still logged", logs4.some((l) => /NOT played/.test(l)), JSON.stringify(logs4));
  }

  // ---- D) a temp daemon: a bonk whose phone push fails → one ⚠ in Thoughts-A's thread
  {
    const S = fs.mkdtempSync(path.join(os.tmpdir(), "j663d-")), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock");
    fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
    fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
    fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } }, phone: { ntfy: { enabled: true, topic: "j663d", server: `${BASE}/fail`, kinds: ["bonk", "decision"], maxPerHour: 0 } } }));
    const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j663-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000", HYPRPI_TEST: "1", XDG_STATE_HOME: path.join(S, "xdg"), HYPRPI_NTFY_TIMEOUT_MS: "1000" };
    delete env.HYPRPI_PHONE_PUSH_LOG; delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
    const dlog = path.join(S, "d.log");
    const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(dlog, "w"), fs.openSync(path.join(S, "d.err"), "w")] });
    try {
      for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
      const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
      const agent = await connect({ path: sock, onEvent: () => {} });
      await agent.call("agent.hello", { agent_id: "hp-atlas", pid: process.pid, name: "Atlas", icon: "🗺", want_workspace: 2, cwd: S });
      const upd = (p) => agent.call("agent.update", { agent_id: "hp-atlas", ...p });
      const thread = () => { try { return fs.readFileSync(path.join(S, "thoughts", "A.thread.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
      const notes = () => thread().filter((e) => /phone push NOT delivered/.test(e.text || ""));
      const before = hits.filter((h) => h.url === "/fail").length;
      await upd({ status: "working" }); await upd({ status: "blocked", quiet: true, note: "the build needs your password" });
      for (let i = 0; i < 30 && !notes().length; i++) await sleep(100);
      const L = () => { try { return fs.readFileSync(dlog, "utf8") + fs.readFileSync(path.join(S, "d.err"), "utf8"); } catch { return ""; } };
      ok("D1 the stand-in ntfy got the bonk's push", hits.filter((h) => h.url === "/fail").length === before + 1);
      ok("D1 ONE ⚠ note in Thoughts-A's thread says the push wasn't delivered and why", notes().length === 1 && /answered 500/.test(notes()[0].text) && /^⚠/.test(notes()[0].text), JSON.stringify(thread().map((e) => e.text)));
      ok("D1 the daemon log says handed over (not confirmed), then NOT sent; never 'sent'", /handed to ntfy \(not confirmed yet\)/.test(L()) && /phone push: NOT sent bonk:/.test(L()) && !/phone push: sent /.test(L()), L().split("\n").filter((l) => /phone/.test(l)).join(" | "));
      await upd({ status: "working" }); await sleep(20); await upd({ status: "blocked", quiet: true, note: "one more thing" });
      for (let i = 0; i < 20 && hits.filter((h) => h.url === "/fail").length < before + 2; i++) await sleep(100);
      await sleep(300);
      ok("D2 a second failed push: logged, no second note (one per spell)", hits.filter((h) => h.url === "/fail").length === before + 2 && notes().length === 1 && (L().match(/phone push: NOT sent/g) || []).length === 2, `notes ${notes().length}`);
      agent.close?.();
    } finally { try { d.kill("SIGTERM"); } catch { /* gone */ } await sleep(300); fs.rmSync(S, { recursive: true, force: true }); }
  }
} finally {
  srv.closeAllConnections?.(); srv.close(); fs.rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
