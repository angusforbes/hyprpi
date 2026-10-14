#!/usr/bin/env node
// J562 proof (Angus: "Hey I'm not seeing hub agents in wI … No agents working in I"): the phone page (π, the live server on
// 127.0.0.1:8897) in a HEADLESS Chromium of its own (temp profile, no window), driven over CDP with the page's own code
// (window.__rc): world I's Agnt lists hub-alpha and its session opens; world H's lists omni-alpha and Mailwise and they open;
// a stale / closed agent (a gone Ping helper) falls back to the world's agent list with a note instead of a dead "✗ no such
// agent or session" page. Read-only: nothing is sent to any agent.
//   node test/phone-remote-agents.mjs [http://127.0.0.1:8897]   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8897";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "j562-chrome-")), port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(process.env.CHROMIUM || "chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=430,900", "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch { /* gone */ } try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* fine */ } };
process.on("exit", cleanup);
try {
  let tabs = null;
  for (let i = 0; i < 50 && !tabs; i++) { await sleep(200); tabs = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null); }
  const page = tabs.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0; const waits = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; waits.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await ev(expr); if (v) return v; await sleep(300); } return v; };
  await cdp("Page.navigate", { url: `${BASE}/?world=A` });
  await until("!!window.__rc");
  const agentsText = (w) => `(async()=>{ window.__rc.setWorld(${JSON.stringify(w)}); window.__rc.setView("agents"); return document.querySelector("#agents")?.innerText || ""; })()`;
  const sessionLoaded = `(()=>{ const t = document.querySelector("#session")?.innerText || ""; return !document.querySelector("#session").hidden && t && !/loading…/.test(t) ? t.slice(0, 200) : ""; })()`;
  const idOf = async (w, name) => ev(`(window.__rc.agentsOf(${JSON.stringify(w)}).agents.find((a) => a.name === ${JSON.stringify(name)}) || {}).id || ""`);
  for (const [w, names] of [["I", ["hub-alpha"]], ["H", ["omni-alpha", "Mailwise"]]]) {
    await ev(agentsText(w));
    const listed = await until(`(()=>{ const t = document.querySelector("#agents")?.innerText || ""; return ${JSON.stringify(names)}.every((n) => t.includes(n)) ? t : ""; })()`);
    ok(`world ${w}'s Agnt lists ${names.join(" and ")}`, !!listed, String(listed || (await ev(`document.querySelector("#agents")?.innerText`)) || "").replace(/\s+/g, " ").slice(0, 160));
    for (const n of names) {
      const id = await idOf(w, n);
      await ev(`window.__rc.openSession(${JSON.stringify(id)})`);
      const s = await until(sessionLoaded, 45000);
      ok(`world ${w}: ${n}'s session opens (no "no such agent or session")`, !!s && !/no such agent|✗/.test(s), String(s || (await ev(`document.querySelector("#session")?.innerText`))).replace(/\s+/g, " ").slice(0, 120));
      await ev(`window.__rc.setView("agents")`);
    }
  }
  // a stale / closed agent (e.g. a Ping helper Thoughts-I closed): back to the list with a note
  await ev(agentsText("I"));
  await ev(`window.__rc.openSession("rmt:world-i:i-ping-gone-j562")`);
  const back = await until(`(()=>{ const a = document.querySelector("#agents"), n = document.querySelector("#note"); return a && !a.hidden && document.querySelector("#session").hidden && n && !n.hidden ? (n.textContent + " | " + a.innerText) : ""; })()`, 20000);
  ok("a stale agent id falls back to world I's agent list with a note (not a dead error page)", !!back && /hub-alpha/.test(back) && /can't be opened/.test(back), String(back || "").replace(/\s+/g, " ").slice(0, 200));
  await ev(`window.__rc.openSession("sbx:nope:x")`);
  const back2 = await until(`(()=>{ const a = document.querySelector("#agents"); return a && !a.hidden && document.querySelector("#session").hidden ? "list" : ""; })()`, 20000);
  ok("… also for a malformed / unknown-world id", back2 === "list");
  ws.close();
} finally { cleanup(); }
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
