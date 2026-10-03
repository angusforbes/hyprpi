// hyprpi remote control: the page. A chat with one world's Thoughts agent; world chips switch it.
// Thread entries (lib/thoughts.mjs): { role: you | thoughts | action | reply | agent | note | evidence, text, from?, ts }
import { threadKind, answerLine, actionPrefix, splitLead } from "/lib/thoughts-lines.mjs";
const $ = (s) => document.querySelector(s);
const thread = $("#thread"), input = $("#input"), sendBtn = $("#send"), stopBtn = $("#stop");
let world = null, worlds = [], busy = false, online = false, es = null, loadSeq = 0;

// ---- helpers --------------------------------------------------------------------------------
// Arrows and symbols that iOS would otherwise draw as colour emoji (J40, Angus: "use the nice text
// … for the reply sent arrows rather than turning them into bulky icons"): each gets U+FE0E, the
// text-presentation selector, unless the text already asks for emoji (U+FE0F). Real icons (📱, 🐦‍🔥,
// project and agent icons) are emoji by default and are left alone.
const TEXT_STYLE = /([\u2194-\u2199\u21A9\u21AA\u23CF\u23E9-\u23EF\u23F8-\u23FA\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2611\u2622\u2623\u2660\u2663\u2665\u2666\u267B\u26A0\u2702\u2709\u270B\u270F\u2712\u2714\u2716\u2733\u2734\u2747\u2763\u2764\u27A1\u2934\u2935\u2B05-\u2B07\u203C\u2049\u2122\u2139\u00A9\u00AE])(?![\uFE0E\uFE0F])/g;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// After each render: every such glyph in the text (not in attributes) becomes
// <span class="tx">↩\uFE0E</span>; .tx puts a font that has it as plain text first (Menlo on iOS).
// U+FE0E alone isn't enough when Safari's font list reaches the emoji font first.
function textGlyphs(root) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => { TEXT_STYLE.lastIndex = 0; return TEXT_STYLE.test(n.data) && !n.parentElement?.closest(".tx, code, pre, textarea") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } });
  const nodes = []; while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment(); let last = 0; TEXT_STYLE.lastIndex = 0;
    for (const m of n.data.matchAll(TEXT_STYLE)) {
      if (m.index > last) frag.append(n.data.slice(last, m.index));
      const sp = document.createElement("span"); sp.className = "tx"; sp.textContent = m[1] + "\uFE0E"; frag.append(sp);
      last = m.index + m[0].length;
    }
    if (last < n.data.length) frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
}
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
  s = s.replace(/(^|[\s(])((?:https?:\/\/|file:\/\/\/)[^\s<)]+[^\s<).,;:!?'"])/g, (_, p, u) => p + link(u.startsWith("file:") ? esc(decodeURIComponent(u.replace(/&amp;/g, "&")).split("/").pop()) : u, u.replace(/&amp;/g, "&")));
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
// Which entries show and how: lib/thoughts-lines.mjs, the same rule as the desktop Thoughts window
// (J38). Agents' incoming messages are not drawn (Thoughts' summary covers them): the summary's
// "↩ from Name" lead line opens them (one tap). Action and answer lines show two lines; a tap
// shows the rest.
function hiddenBefore(list, i, lead) {
  // The incoming agent messages since the previous visible exchange, from the lead's names if any.
  const out = [];
  for (let j = i - 1; j >= 0 && threadKind(list[j]) !== "full"; j--) if (threadKind(list[j]) === "hidden") out.unshift(list[j]);
  const names = (/^↩ from (.+)$/.exec(lead) || [])[1]?.split(/,\s*/).map((n) => n.trim()) || [];
  const mine = out.filter((x) => names.some((n) => String(x.from || "").startsWith(n)));
  return mine.length ? mine : out;
}
function entryHtml(e, i, list) {
  const kind = threadKind(e);
  switch (kind) {
    case "hidden": return "";
    case "full": {
      if (e.role === "you") return `<div class="msg you">${esc(e.text)}${e.via === "phone" ? `<span class="via">📱</span>` : ""}${images(e)}</div>`;
      const { lead, body } = splitLead(e);
      const raw = lead && list ? hiddenBefore(list, i, lead) : [];
      const leadHtml = !lead ? "" : raw.length
        ? `<details class="lead"><summary>${esc(lead)} <span class="more">· the message${raw.length > 1 ? "s" : ""}</span></summary>${raw.map((x) => `<div class="raw"><div class="who">${x.role === "reply" ? "↩" : "✉"} ${esc(x.from || "agent")} · ${hhmm(x.ts)}</div><div class="md">${md(x.text)}</div></div>`).join("")}</details>`
        : `<div class="lead">${esc(lead)}</div>`;
      return `<div class="msg thoughts">${leadHtml}<div class="md">${md(body)}</div></div>`;
    }
    case "answer": { const a = answerLine(e); return `<div class="msg small clip" title="tap for all of it">${inline(`↩ to ${a.to}: ${a.said}${a.cutOld ? "…" : ""}`)}</div>`; }
    case "action": case "error": return `<div class="msg small clip${kind === "error" ? " error" : ""}" title="tap for all of it">${inline(actionPrefix(e) + String(e.text || ""))}</div>`;
    case "evidence":
      return `<details class="msg card"><summary>🔎 <span class="who">${esc(e.kind || "evidence")}</span> · ${esc(firstLine(e.query || e.filter || ""))}</summary><div class="md">${md(e.answer || `${e.total ?? e.n ?? 0} lines`)}</div></details>`;
    default: return e.text ? `<div class="msg small note">${inline(String(e.text))}</div>` : "";
  }
}
const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
// keep: "bottom" (stay at the end if we were there), "restore" (the world's saved place), "end"
function render({ keep = "bottom" } = {}) {
  const c = cached(world), entries = c.entries;
  const wasBottom = nearBottom(), was = thread.scrollTop;
  const html = []; let lastDay = "", lastTs = 0;
  for (const [i, e] of entries.entries()) {
    const d = dayOf(e.ts);
    if (e.role === "you" && e.ts && (d !== lastDay || e.ts - lastTs > 30 * 60e3)) html.push(`<div class="time">${d !== lastDay ? esc(new Date(e.ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) + " · " : ""}${hhmm(e.ts)}</div>`);
    if (e.ts) { lastDay = d; lastTs = e.ts; }
    html.push(entryHtml(e, i, entries));
  }
  // "Nothing here yet" only once the server has said the thread really is empty.
  if (!entries.length && c.loaded) html.push(`<div class="small empty" style="text-align:center;margin-top:30vh">Nothing here yet. Say something to Thoughts-${esc(world)}.</div>`);
  thread.innerHTML = html.join("");
  textGlyphs(thread);
  if (keep === "restore" && c.scroll != null) thread.scrollTop = c.scroll;
  else if (keep === "bottom" && !wasBottom) thread.scrollTop = was;
  else thread.scrollTop = thread.scrollHeight;
}
function append(e) {
  const atBottom = nearBottom();
  const list = cached(world).entries;
  if (list.length === 1) return render({ keep: "end" });
  thread.insertAdjacentHTML("beforeend", entryHtml(e, list.length - 1, list));
  if (thread.lastElementChild) textGlyphs(thread.lastElementChild);
  if (atBottom || e.role === "you") thread.scrollTop = thread.scrollHeight;
}
function renderTop() {
  const cur = worlds.find((w) => w.id === world);
  document.documentElement.style.setProperty("--world", cur?.color || "var(--accent)");
  document.title = `${world || ""} · Thoughts`;
  stopBtn.hidden = !busy;
  $("#dot").className = online ? "on" : "off";
  document.querySelector('.tab[data-tab="thoughts"]').classList.toggle("busy", busy);
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("cur", t.dataset.tab === view);
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

// ---- data: every shown world's thread, cached ----------------------------------------------
// Angus (J37 v4): no "Nothing here yet" flash when switching worlds. Each world's thread is kept in
// memory and in localStorage (a reload shows it at once), prefetched for every shown world, kept
// current from the event stream, and refreshed in the background when you switch to it.
const cache = new Map(); // world -> { entries, busy, loaded (fresh from the server), scroll (null = at the end) }
const LS = (w) => "hyprpi-rc.thread." + w, KEEP = 150;
function cached(w) {
  let c = cache.get(w);
  if (!c) {
    c = { entries: [], busy: false, loaded: false, scroll: null };
    try { const st = JSON.parse(localStorage.getItem(LS(w)) || "null"); if (Array.isArray(st?.entries)) c.entries = st.entries; } catch { /* none */ }
    cache.set(w, c);
  }
  return c;
}
const saveTimers = {};
function save(w) {
  clearTimeout(saveTimers[w]);
  saveTimers[w] = setTimeout(() => { try { localStorage.setItem(LS(w), JSON.stringify({ entries: cached(w).entries.slice(-KEEP) })); } catch { /* full: memory only */ } }, 400);
}
const sig = (l) => `${l.length}:${l[l.length - 1]?.ts || 0}:${String(l[l.length - 1]?.text || "").length}`;
async function fetchWorld(w) {
  const t = await call("GET", `/api/thoughts?world=${w}`);
  const c = cached(w), next = t.entries || [], changed = !c.loaded || sig(next) !== sig(c.entries);
  c.entries = next; c.busy = !!t.busy; c.loaded = true; save(w);
  if (w === world) { busy = c.busy; if (changed) render(); renderTop(); note(""); }
}
const prefetched = new Set();
function refreshAll() {
  const ws = new Set([world, ...worlds.filter((x) => x.shown).map((x) => x.id)].filter(Boolean));
  for (const w of ws) prefetched.add(w), fetchWorld(w).catch((e) => { if (w === world) note("✗ " + e.message); }), fetchBoard(w).catch(() => {});
}
function setWorld(w) {
  if (!w || w === world) return;
  if (world) cached(world).scroll = nearBottom() ? null : thread.scrollTop;
  world = w;
  const c = cached(w);
  busy = c.busy || !!worlds.find((x) => x.id === w)?.thoughtsBusy;
  history.replaceState(null, "", `?world=${w}`);
  renderTop(); render({ keep: "restore" }); renderProjects(); // at once, from the cache
  fetchWorld(w).catch((e) => note("✗ " + e.message)); // then fresh, in the background
  fetchBoard(w).catch(() => {});
}
function applyState(s) {
  worlds = s.worlds || []; online = !!s.online;
  if (s.theme) { for (const [k, v] of Object.entries(s.theme)) document.documentElement.style.setProperty("--" + k, v); document.querySelector("meta[name=theme-color]").content = s.theme.bg; }
  const first = !stateSeen; stateSeen = true;
  if (!world) setWorld(new URLSearchParams(location.search).get("world") || s.active);
  renderTop();
  if (first) refreshAll();
  // A world that just appeared (F–I in use): fetch its thread now, so switching to it is instant.
  for (const x of worlds) if (x.shown && !prefetched.has(x.id)) { prefetched.add(x.id); fetchWorld(x.id).catch(() => prefetched.delete(x.id)); fetchBoard(x.id).catch(() => {}); }
}
function listen() {
  if (es && es.readyState !== EventSource.CLOSED) return;
  es = new EventSource("/events");
  es.addEventListener("state", (ev) => applyState(JSON.parse(ev.data)));
  es.addEventListener("board", (ev) => { const d = JSON.parse(ev.data); if (d.room) boardSoon(d.room); });
  es.addEventListener("thoughts", (ev) => {
    const d = JSON.parse(ev.data), c = cached(d.room);
    if (d.entry) { c.entries.push(d.entry); save(d.room); if (d.room === world) append(d.entry); }
    if (d.busy !== undefined) { c.busy = !!d.busy; if (d.room === world) { busy = c.busy; renderTop(); } }
  });
  es.onerror = () => { online = false; renderTop(); };
  es.onopen = () => { if (!online && world) refreshAll(); online = true; renderTop(); }; // catch up after a drop
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
// ■ (J38, Angus: "I want you to reply after I interrupt you"): stop the reply; Thoughts then says in
// a line or two what got cut off and asks what's next. The cursor goes to the box.
stopBtn.addEventListener("click", async () => {
  input.focus({ preventScroll: true });
  try { await call("POST", "/api/stop", { world, ask: true }); } catch (err) { note("✗ " + err.message); }
});
// A tap on a two-line action / answer line shows all of it (and again folds it).
thread.addEventListener("click", (e) => { const c = e.target.closest(".clip"); if (c && !e.target.closest("a")) c.classList.toggle("open"); });
$("#tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (t && !t.classList.contains("soon")) return setView(t.dataset.tab);
  if (t?.classList.contains("soon")) { note(`${t.title.replace(/ \(.*/, "")}: coming later`); setTimeout(() => note(""), 2500); }
});
$("#worlds").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) setWorld(b.dataset.w); });

// iOS keyboard (J37 v4, Angus: "it kind of animates away and comes back. i'd rather it jsut
// stayed"). Safari normally pans the page to show the focused box, and correcting that afterwards
// is the animation he saw. So the page never scrolls in the first place:
//  1. html and body can't scroll (overflow hidden, body position fixed); only the thread scrolls.
//  2. A tap on the text box focuses it with preventScroll, so Safari doesn't pan to it.
//  3. The body's height follows the visual viewport (the part above the keyboard), so the box
//     sits right above the keyboard and the bar stays at the top. If Safari pans anyway, the
//     offset is applied at once (no transition).
//  4. Drags outside the thread and the text box are swallowed (no rubber-banding the bar).
const vv = window.visualViewport;
function fitViewport() {
  if (!vv) return;
  if (window.scrollY) window.scrollTo(0, 0);
  document.body.style.height = vv.height + "px";
  document.body.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
}
if (vv) { vv.addEventListener("resize", fitViewport); vv.addEventListener("scroll", fitViewport); fitViewport(); }
input.addEventListener("touchend", (e) => {
  if (document.activeElement === input) return; // already typing: let taps move the caret
  e.preventDefault();
  input.focus({ preventScroll: true });
}, { passive: false });
input.addEventListener("focus", () => { fitViewport(); requestAnimationFrame(() => { fitViewport(); if (!cached(world).scroll) thread.scrollTop = thread.scrollHeight; }); });
document.addEventListener("touchmove", (e) => { if (!e.target.closest("#thread, #input")) e.preventDefault(); }, { passive: false });

// iOS drops the connection when the app goes to the background: catch up on return.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { listen(); if (world) refreshAll(); } });
addEventListener("pageshow", (e) => { if (e.persisted) { listen(); if (world) refreshAll(); } });

// ---- the Proj tab (J39): this world's projects; one open at a time, as a short summary --------
// Angus: "a list that we can click on … when I click on one it opens it but just the summary not
// the full thing, not the entire archive, just the active, where, next, done and step". Plus a
// "Needs you" section (open decisions) he can open or close; the choice is remembered. Read-only.
// Boards are cached like the threads (memory + localStorage), prefetched for every shown world and
// re-fetched when the daemon says a card changed.
let view = "thoughts";
const boards = new Map(); // world -> { projects, loaded }
const openProject = new Map(); // world -> project id (one open at a time)
const projectsEl = $("#projects");
const LSB = (w) => "hyprpi-rc.board." + w;
function boardOf(w) {
  let b = boards.get(w);
  if (!b) {
    b = { projects: [], loaded: false };
    try { const st = JSON.parse(localStorage.getItem(LSB(w)) || "null"); if (Array.isArray(st?.projects)) b.projects = st.projects; } catch { /* none */ }
    boards.set(w, b);
  }
  return b;
}
async function fetchBoard(w) {
  const r = await call("GET", `/api/board?world=${w}`), b = boardOf(w);
  const changed = !b.loaded || JSON.stringify(r.projects) !== JSON.stringify(b.projects);
  b.projects = r.projects || []; b.loaded = true;
  try { localStorage.setItem(LSB(w), JSON.stringify({ projects: b.projects })); } catch { /* memory only */ }
  if (w === world && view === "projects" && changed) renderProjects({ keepScroll: true });
}
const boardTimers = {};
const boardSoon = (w) => { clearTimeout(boardTimers[w]); boardTimers[w] = setTimeout(() => fetchBoard(w).catch(() => {}), 250); };
let needsOpen = localStorage.getItem("hyprpi-rc.needsOpen") !== "0"; // open unless he closed it
const badge = (st) => `<span class="badge ${esc(st)}">${esc(st)}</span>`;
function renderProjects({ keepScroll = false } = {}) {
  if (view !== "projects") return;
  const b = boardOf(world), was = projectsEl.scrollTop;
  const p = b.projects.find((x) => x.id === openProject.get(world));
  const html = [];
  if (!p) {
    for (const q of b.projects) {
      const counts = [q.decide.length ? `<b>D${q.decide.length}</b>` : "", q.next.length ? `N${q.next.length}` : ""].filter(Boolean).join(" · ");
      html.push(`<button class="proj" data-p="${esc(q.id)}"><span class="pic">${esc(q.icon)}</span><span class="pmain"><span class="pname">@${esc(q.name)} ${badge(q.status)}${counts ? ` <span class="cnt">${counts}</span>` : ""}</span><span class="pwhere">${esc(q.where || q.title)}</span></span><span class="chev">›</span></button>`);
    }
    if (!b.projects.length && b.loaded) html.push(`<div class="small empty" style="text-align:center;margin-top:30vh">No projects in world ${esc(world)}.</div>`);
  } else {
    const sec = (title, inner) => inner ? `<section><h3>${title}</h3>${inner}</section>` : "";
    const items = (list, done) => list.length ? `<ul class="items">${list.map((it) => `<li><span class="h">${esc(it.h)}</span> <div class="md">${md(it.text)}</div>${done && it.verified ? `<div class="small clip">✓ ${inline(it.verified)}</div>` : ""}${it.resolution ? `<div class="small">→ decided: ${inline(it.resolution)}</div>` : ""}</li>`).join("")}</ul>` : "";
    const decide = p.decide.map((it) => `<li><span class="h">${esc(it.h)}</span> <div class="md">${md(it.text)}</div>${(it.options || []).length ? `<ol class="opts">${it.options.map((o) => `<li><b>${esc(o.key)})</b> ${inline(o.text)}${o.key === it.default ? ` <span class="small">(default)</span>` : ""}${o.key === it.recommend ? ` <span class="rec">★ recommended</span>` : ""}</li>`).join("")}</ol>` : ""}</li>`).join("");
    html.push(`<div class="psum"><button class="back">‹ Projects</button>`
      + `<h2>${esc(p.icon)} @${esc(p.name)} ${badge(p.status)}</h2>${p.title ? `<div class="ptitle">${esc(p.title)}</div>` : ""}`
      + sec("Where", p.where ? `<div class="md">${md(p.where)}</div>` : "")
      + (p.decide.length ? `<details class="needs"${needsOpen ? " open" : ""}><summary>Needs you <span class="cnt">${p.decide.length}</span></summary><ul class="items">${decide}</ul></details>` : "")
      + sec("Next", items(p.next)) + sec("Done", items(p.done, true))
      + sec("Next first step", p.next_step ? `<div class="md">${md(p.next_step)}</div>` : "")
      + `</div>`);
  }
  projectsEl.innerHTML = html.join("");
  textGlyphs(projectsEl);
  projectsEl.scrollTop = keepScroll ? was : 0;
}
function setView(v) {
  if (v === view) { if (v === "projects" && openProject.get(world)) { openProject.delete(world); renderProjects(); } return; } // Proj again: back to the list
  view = v;
  $("#thread").hidden = v !== "thoughts"; $("#composer").hidden = v !== "thoughts"; projectsEl.hidden = v !== "projects";
  renderTop();
  if (v === "projects") { renderProjects(); fetchBoard(world).catch(() => {}); }
  else render({ keep: "restore" });
}
projectsEl.addEventListener("click", (e) => {
  const pr = e.target.closest(".proj"); if (pr) { openProject.set(world, pr.dataset.p); return renderProjects(); }
  if (e.target.closest(".back")) { openProject.delete(world); return renderProjects(); }
  const c = e.target.closest(".clip"); if (c && !e.target.closest("a")) c.classList.toggle("open");
});
projectsEl.addEventListener("toggle", (e) => {
  if (e.target.matches("details.needs")) { needsOpen = e.target.open; localStorage.setItem("hyprpi-rc.needsOpen", needsOpen ? "1" : "0"); }
}, true);

window.__rc = { cached, setWorld, boardOf, setView }; // for tests (CDP)
// A reload (the URL keeps ?world=): show that world's cached thread before the server answers.
let stateSeen = false;
{ const w0 = new URLSearchParams(location.search).get("world"); if (/^[A-Z]$/.test(w0 || "")) { world = w0; render({ keep: "end" }); } }
call("GET", "/api/state").then(applyState).catch((e) => note("✗ " + e.message));
listen();
