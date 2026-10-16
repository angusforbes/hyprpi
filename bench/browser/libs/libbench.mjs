// J680 W4: the same typical steps with each library, against a THROWAWAY headless Brave (port from argv[2]):
// connect, open a new tab on the J669 bench form, read the page (title + interactive elements), fill 2 fields + select
// + check + upload + submit, read the result, close the tab. N runs each; prints medians. agent-browser is timed as
// the agents use it: one CLI process per command, then batch.
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { chromium } from "playwright-core";
import CDP from "chrome-remote-interface";
const PORT = process.argv[2], N = +(process.argv[3] || 5), URL = "http://127.0.0.1:8669/", FILE = process.env.HOME + "/Harness/hyprpi/bench/browser/upload.txt";
const WANT = "Submitted: Angus / angus@example.com / plan=Pro / agree=yes / file=upload.txt";
const now = () => performance.now();
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
async function timed(name, fn) {
  const rows = [];
  for (let i = 0; i < N; i++) rows.push(await fn());
  const ok = rows.every((r) => r.result === WANT); if (!ok) process.exitCode = 1;
  const keys = Object.keys(rows[0]).filter((k) => k !== "result");
  console.log(`${name.padEnd(16)} ${keys.map((k) => `${k} ${med(rows.map((r) => r[k])).toFixed(0)} ms`).join(", ")}  ${ok ? "all correct" : "WRONG: " + rows.map((r) => r.result).join(" | ")}`);
}
await timed("raw CDP (ws)", async () => {
  const t0 = now();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${URL}`, { method: "PUT" })).json();
  const ws = new WebSocket(list.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const send = (method, params = {}) => new Promise((r) => { const i = ++id; const h = (m) => { const d = JSON.parse(m.data); if (d.id === i) { ws.removeEventListener("message", h); r(d.result); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  // (a new target starts on about:blank: wait for OUR page and its form, not just any complete document)
  while ((await ev(`location.href === ${JSON.stringify(URL)} && document.readyState === "complete" && !!document.getElementById("name")`)) !== true) await new Promise((r) => setTimeout(r, 20));
  const t1 = now();
  await ev(`JSON.stringify([document.title, [...document.querySelectorAll("input,select,button")].map(e => e.id || e.textContent)])`);
  const t2 = now();
  await ev(`(() => { const s = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input", {bubbles:true})); e.dispatchEvent(new Event("change", {bubbles:true})); }; s("name","Angus"); s("email","angus@example.com"); s("plan","Pro"); document.getElementById("agree").click(); })()`);
  const doc = await send("DOM.getDocument", { depth: 1 }); const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#file" });
  await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [FILE] });
  await ev(`document.querySelector("button[type=submit]").click()`);
  const result = await ev(`document.getElementById("out").textContent`);
  const t3 = now(); ws.close(); await fetch(`http://127.0.0.1:${PORT}/json/close/${list.id}`);
  return { open: t1 - t0, read: t2 - t1, act: t3 - t2, total: now() - t0, result };
});
await timed("chrome-remote-if", async () => {
  const t0 = now();
  const tgt = await CDP.New({ port: +PORT, url: URL }); const c = await CDP({ port: +PORT, target: tgt });
  await c.Page.enable();
  while ((await c.Runtime.evaluate({ expression: `location.href === ${JSON.stringify(URL)} && document.readyState === "complete" && !!document.getElementById("name")`, returnByValue: true })).result.value !== true) await new Promise((r) => setTimeout(r, 20));
  const t1 = now();
  await c.Runtime.evaluate({ expression: `JSON.stringify([...document.querySelectorAll("input,select,button")].map(e => e.id))`, returnByValue: true });
  const t2 = now();
  await c.Runtime.evaluate({ expression: `(() => { const s = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("change", {bubbles:true})); }; s("name","Angus"); s("email","angus@example.com"); s("plan","Pro"); document.getElementById("agree").click(); })()` });
  const { root } = await c.DOM.getDocument({ depth: 1 }); const { nodeId } = await c.DOM.querySelector({ nodeId: root.nodeId, selector: "#file" });
  await c.DOM.setFileInputFiles({ nodeId, files: [FILE] });
  await c.Runtime.evaluate({ expression: `document.querySelector("button[type=submit]").click()` });
  const result = (await c.Runtime.evaluate({ expression: `document.getElementById("out").textContent`, returnByValue: true })).result.value;
  const t3 = now(); await c.close(); await CDP.Close({ port: +PORT, id: tgt.id });
  return { open: t1 - t0, read: t2 - t1, act: t3 - t2, total: now() - t0, result };
});
await timed("agent-browser", async () => {
  const ab = (...a) => execFileSync("agent-browser", ["--cdp", PORT, "--session", "libbench", ...a], { encoding: "utf8" });
  const t0 = now(); ab("tab", "new", URL); const t1 = now();
  ab("snapshot", "-i", "-c"); const t2 = now();
  const out = ab("batch", "--bail", "fill #name Angus", "fill #email angus@example.com", "select #plan Pro", "check #agree", `upload #file ${FILE}`, "click button[type=submit]", "get text #out");
  const t3 = now(); ab("tab", "close");
  return { open: t1 - t0, read: t2 - t1, act: t3 - t2, total: now() - t0, result: out.trim().split("\n").pop() };
});
{ // puppeteer-core: connect once (agents would keep it), then per run
  const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  await timed("puppeteer-core", async () => {
    const t0 = now(); const p = await b.newPage(); await p.goto(URL); const t1 = now();
    await p.$$eval("input,select,button", (es) => es.map((e) => e.id)); const t2 = now();
    await p.type("#name", "Angus", { delay: 0 }); await p.type("#email", "angus@example.com", { delay: 0 }); await p.select("#plan", "Pro"); await p.click("#agree");
    await (await p.$("#file")).uploadFile(FILE); await p.click("button[type=submit]");
    const result = await p.$eval("#out", (e) => e.textContent); const t3 = now(); await p.close();
    return { open: t1 - t0, read: t2 - t1, act: t3 - t2, total: now() - t0, result };
  });
  await b.disconnect();
}
{ // Playwright connectOverCDP: connect once, then per run (a new page in the default context = a tab of that browser)
  const t = now(); const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); const connectMs = now() - t;
  const ctx = b.contexts()[0];
  await timed("playwright", async () => {
    const t0 = now(); const p = await ctx.newPage(); await p.goto(URL); const t1 = now();
    await p.locator("input,select,button").evaluateAll((es) => es.map((e) => e.id)); const t2 = now();
    await p.fill("#name", "Angus"); await p.fill("#email", "angus@example.com"); await p.selectOption("#plan", "Pro"); await p.check("#agree");
    await p.setInputFiles("#file", FILE); await p.click("button[type=submit]");
    const result = await p.textContent("#out"); const t3 = now(); await p.close();
    return { open: t1 - t0, read: t2 - t1, act: t3 - t2, total: now() - t0, result };
  });
  console.log(`  (playwright connectOverCDP itself: ${connectMs.toFixed(0)} ms, once per process)`);
  await b.close().catch(() => {}); // for a CDP-connected browser this only disconnects
}
process.exit(process.exitCode || 0);
