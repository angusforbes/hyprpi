// hyprpi remote control: the page. A chat with one world's Thoughts agent; world chips switch it.
// Thread entries (lib/thoughts.mjs): { role: you | thoughts | action | reply | agent | note | evidence, text, from?, ts }
"use strict";
const $ = (s) => document.querySelector(s);
const thread = $("#thread"), input = $("#input"), sendBtn = $("#send"), stopBtn = $("#stop");
let world = null, worlds = [], entries = [], busy = false, online = false, es = null, loadSeq = 0;

// ---- helpers --------------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function note(text) { const n = $("#note"); n.textContent = text || ""; n.hidden = !text; }
async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
// file:///abs/path (and bare /home/… or ~/…) → /file?path=…, opened read-only by the server.
function href(u) {
  u = String(u).trim();
  if (/^file:\/\//i.test(u)) { try { return "/file?path=" + encodeURIComponent(decodeURIComponent(new URL(u).pathname)); } catch { return "#"; } }
  if (u.startsWith("/") || u.startsWith("~/")) return "/file?path=" + encodeURIComponent(u); // the server expands ~
  if (/^(https?|mailto):/i.test(u)) return u;
  return "#";
}
const link = (text, u) => `<a href="${esc(href(u))}" target="_blank" rel="noopener">${text}</a>`;

// ---- a small Markdown renderer (escapes everything first) ---------------------------------
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => link(t, u.replace(/&amp;/g, "&")));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, p, u) => p + link(u, u.replace(/&amp;/g, "&")));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|\W)_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}
function md(src) {
  const lines = String(src ?? "").replace(/\r/g, "").split("\n"), out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    if (/^\s*$/.test(l)) { i++; continue; }
    const h = l.match(/^(#{1,4})\s+(.*)/); if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let t = `<table><tr>${row(l).map((c) => `<th>${c}</th>`).join("")}</tr>`; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) t += `<tr>${row(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      out.push(t + "</table>"); continue;
    }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${md(buf.join("\n"))}</blockquote>`); continue; }
    const li = /^\s*([-*•]|\d+[.)])\s+/;
    if (li.test(l)) {
      const ordered = /^\s*\d/.test(l), items = [];
      while (i < lines.length && (li.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (li.test(lines[i])) items.push(lines[i].replace(li, "")); else items[items.length - 1] += "\n" + lines[i].trim();
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x).replace(/\n/g, "<br>")}</li>`).join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```|^#{1,4}\s|^>\s?/.test(lines[i]) && !li.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

// ---- rendering ------------------------------------------------------------------------------
const hhmm = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
const dayOf = (ts) => ts ? new Date(ts).toDateString() : "";
function firstLine(s, n = 90) { const l = String(s || "").split("\n").find((x) => x.trim()) || ""; return l.length > n ? l.slice(0, n - 1) + "…" : l; }
function images(e) {
  return (e.images || []).map((p) => /\.(png|jpe?g|gif|webp)$/i.test(p) ? `<a href="${esc(href(p))}" target="_blank"><img class="img" src="${esc(href(p))}" alt=""></a>` : `<div class="small">📎 ${link(esc(p.split("/").pop()), p)}</div>`).join("");
}
function entryHtml(e) {
  switch (e.role) {
    case "you": return `<div class="msg you">${esc(e.text)}${e.via === "phone" ? `<span class="via">📱</span>` : ""}${images(e)}</div>`;
    case "thoughts": {
      let t = String(e.text || ""), lead = "";
      const m = t.match(/^\s*(↩ from [^\n]+|↪ to [^\n]+)\n/); if (m) { lead = m[1]; t = t.slice(m[0].length); }
      return `<div class="msg thoughts">${lead ? `<div class="lead">${esc(lead)}</div>` : ""}<div class="md">${md(t)}</div></div>`;
    }
    case "action": return `<div class="msg small action">${inline(String(e.text || ""))}</div>`;
    case "note": return `<div class="msg small note">${inline(String(e.text || ""))}</div>`;
    case "reply": case "agent":
      return `<details class="msg card"><summary>${e.role === "reply" ? "↩" : "✉"} <span class="who">${esc(e.from || "agent")}</span> · ${esc(firstLine(e.text))}</summary><div class="md">${md(e.text)}</div></details>`;
    case "evidence":
      return `<details class="msg card"><summary>🔎 <span class="who">${esc(e.kind || "evidence")}</span> · ${esc(firstLine(e.query || e.filter || ""))}</summary><div class="md">${md(e.answer || `${e.total ?? e.n ?? 0} lines`)}</div></details>`;
    default: return e.text ? `<div class="msg small">${inline(String(e.text))}</div>` : "";
  }
}
function render({ keepScroll = false } = {}) {
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const html = []; let lastDay = "", lastTs = 0;
  for (const e of entries) {
    const d = dayOf(e.ts);
    if (e.role === "you" && e.ts && (d !== lastDay || e.ts - lastTs > 30 * 60e3)) html.push(`<div class="time">${d !== lastDay ? esc(new Date(e.ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) + " · " : ""}${hhmm(e.ts)}</div>`);
    if (e.ts) { lastDay = d; lastTs = e.ts; }
    html.push(entryHtml(e));
  }
  if (!entries.length) html.push(`<div class="small" style="text-align:center;margin-top:30vh">Nothing here yet. Say something to Thoughts-${esc(world)}.</div>`);
  thread.innerHTML = html.join("");
  if (!keepScroll || atBottom) thread.scrollTop = thread.scrollHeight;
}
function append(e) {
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  entries.push(e);
  if (entries.length === 1) return render();
  thread.insertAdjacentHTML("beforeend", entryHtml(e));
  if (atBottom || e.role === "you") thread.scrollTop = thread.scrollHeight;
}
function renderTop() {
  const cur = worlds.find((w) => w.id === world);
  document.documentElement.style.setProperty("--world", cur?.color || "var(--accent)");
  document.title = `${world || ""} · Thoughts`;
  stopBtn.hidden = !busy;
  $("#dot").className = online ? "on" : "off";
  document.querySelector('.tab[data-tab="thoughts"]').classList.toggle("busy", busy);
  // The desktop bar's worlds (server: shown), plus the one open here even if it's hidden there.
  $("#worlds").innerHTML = worlds.filter((w) => w.shown || w.id === world).map((w) => `<button class="chip${w.id === world ? " cur" : ""}${w.needsYou ? " needs" : w.working || w.thoughtsBusy ? " working" : ""}" style="--c:${esc(w.color)}" data-w="${esc(w.id)}" title="world ${esc(w.id)} · ${w.agents} agents${w.working ? ` · ${w.working} working` : ""}${w.needsYou ? ` · ${w.needsYou} need you` : ""}">${esc(w.id)}</button>`).join("");
  fitTop();
}

// The top bar is as big as fits on one line: start large, shrink in small steps only while
// it overflows (more worlds showing, a narrow phone).
function fitTop() {
  const top = $("#top"); let s = 0.99; // Angus: bigger, then smaller, then "smaller by 10%": 33.7 px chips at most; shrink to fit
  top.style.setProperty("--s", s);
  while (s > 0.5 && top.scrollWidth > top.clientWidth) { s -= 0.03; top.style.setProperty("--s", s.toFixed(2)); }
}
addEventListener("resize", fitTop);

// ---- data -----------------------------------------------------------------------------------
async function load() {
  const seq = ++loadSeq;
  try {
    const t = await call("GET", `/api/thoughts?world=${world}`);
    if (seq !== loadSeq) return;
    entries = t.entries || []; busy = !!t.busy; note("");
    render(); renderTop();
  } catch (e) { note("✗ " + e.message); }
}
function setWorld(w) {
  if (!w || w === world) return;
  world = w; entries = []; busy = !!worlds.find((x) => x.id === w)?.thoughtsBusy;
  history.replaceState(null, "", `?world=${w}`);
  renderTop(); render(); load();
}
function applyState(s) {
  worlds = s.worlds || []; online = !!s.online;
  if (s.theme) { for (const [k, v] of Object.entries(s.theme)) document.documentElement.style.setProperty("--" + k, v); document.querySelector("meta[name=theme-color]").content = s.theme.bg; }
  if (!world) { setWorld(new URLSearchParams(location.search).get("world") || s.active); return; }
  renderTop();
}
function listen() {
  if (es && es.readyState !== EventSource.CLOSED) return;
  es = new EventSource("/events");
  es.addEventListener("state", (ev) => applyState(JSON.parse(ev.data)));
  es.addEventListener("thoughts", (ev) => {
    const d = JSON.parse(ev.data);
    if (d.room !== world) return;
    if (d.entry) append(d.entry);
    if (d.busy !== undefined) { busy = !!d.busy; renderTop(); }
  });
  es.onerror = () => { online = false; renderTop(); };
  es.onopen = () => { online = true; renderTop(); };
}

// ---- input ----------------------------------------------------------------------------------
const touch = matchMedia("(pointer: coarse)").matches;
function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight + 2, innerHeight * 0.4) + "px"; }
input.addEventListener("input", grow);
input.addEventListener("keydown", (e) => {
  // Desktop: Enter sends, Shift+Enter is a new line. Phone: Enter is a new line, ➤ sends.
  if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
});
$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim(); if (!text || !world) return;
  sendBtn.disabled = true;
  try { await call("POST", "/api/send", { world, text }); input.value = ""; grow(); busy = true; renderTop(); note(""); }
  catch (err) { note("✗ not sent: " + err.message); }
  finally { sendBtn.disabled = false; }
});
stopBtn.addEventListener("click", async () => { try { await call("POST", "/api/stop", { world }); } catch (err) { note("✗ " + err.message); } });
$("#tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (t?.classList.contains("soon")) { note(`${t.title.replace(/ \(.*/, "")}: coming later`); setTimeout(() => note(""), 2500); }
});
$("#worlds").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) setWorld(b.dataset.w); });

// iOS keyboard: Safari shrinks only the visual viewport and scrolls the page under it, which would
// push the top bar off screen. Keep the body exactly on the visual viewport instead, so only the
// thread scrolls and the bar stays put.
const vv = window.visualViewport;
function fitViewport() {
  if (!vv) return;
  document.body.style.height = vv.height + "px";
  document.body.style.transform = `translateY(${vv.offsetTop}px)`;
}
if (vv) { vv.addEventListener("resize", fitViewport); vv.addEventListener("scroll", fitViewport); fitViewport(); }
input.addEventListener("focus", () => setTimeout(() => { fitViewport(); thread.scrollTop = thread.scrollHeight; }, 250));

// iOS drops the connection when the app goes to the background: catch up on return.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { listen(); if (world) load(); } });
addEventListener("pageshow", (e) => { if (e.persisted) { listen(); if (world) load(); } });

call("GET", "/api/state").then(applyState).catch((e) => note("✗ " + e.message));
listen();
