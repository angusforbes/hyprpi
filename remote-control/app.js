// hyprpi remote control: the page. A chat with one world's Thoughts agent; world chips switch it.
// Thread entries (lib/thoughts.mjs): { role: you | thoughts | action | reply | agent | note | evidence, text, from?, ts }
import { threadKind, answerLine, actionPrefix, splitLead, phoneHidden } from "/lib/thoughts-lines.mjs";
import { agentIn } from "/lib/tui/agent-click.mjs"; // the desktop panels' Ctrl+click matcher, shared as-is (J45)
import { esc, href, link, inline, md } from "/md.mjs";
import { install as installFileViewer, open as openViewer } from "/fileview.mjs";
// J141: a tapped file LINK (/file?path=…) anywhere in π opens in the Fils tab, in its folder, with
// the viewer on top; this runs before the J70 overlay's own handler. Thumbnails (J63) and [[wiki]]
// links still open in the overlay, over the tab they're in.
addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (e.target.closest?.("img.img, img.mdimg")) return; // J234: an image (his bubble's are wrapped in a link) opens in the overlay, as in Agnt (J221)
  const a = e.target.closest?.("a[href^='/file?path=']"); if (!a || a.closest("#fv")) return;
  const fp = new URLSearchParams(a.getAttribute("href").split("?")[1] || "").get("path"); if (!fp) return;
  e.preventDefault(); e.stopPropagation();
  openInFils(fp);
}, true);
installFileViewer();
import { parseStreamFilter, resolveFilterNames, filterStream } from "/lib/stream.mjs"; // the desktop Stream panel's filter, shared as-is (J60) // the Markdown renderer, shared with the document viewer (J56)
const $ = (s) => document.querySelector(s);
const thread = $("#thread"), input = $("#input"), sendBtn = $("#send"), stopBtn = $("#stop");
let world = null, worlds = [], busy = false, online = false, es = null, loadSeq = 0;

// ---- helpers --------------------------------------------------------------------------------
// Arrows and symbols that iOS would otherwise draw as colour emoji (J40, Angus: "use the nice text
// … for the reply sent arrows rather than turning them into bulky icons"): each gets U+FE0E, the
// text-presentation selector, unless the text already asks for emoji (U+FE0F). Real icons (📱, 🐦‍🔥,
// project and agent icons) are emoji by default and are left alone.
const TEXT_STYLE = /([\u2194-\u2199\u21A9\u21AA\u23CF\u23E9-\u23EF\u23F8-\u23FA\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2611\u2622\u2623\u2660\u2663\u2665\u2666\u267B\u26A0\u2702\u2709\u270B\u270F\u2712\u2714\u2716\u2733\u2734\u2747\u2763\u2764\u27A1\u2934\u2935\u2B05-\u2B07\u203C\u2049\u2122\u2139\u00A9\u00AE])(?![\uFE0E\uFE0F])/g;
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
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { body: j });
  return j;
}
// file:///abs/path (and bare /home/… or ~/…) → /file?path=…, opened read-only by the server.
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
  if (phoneHidden(e)) return ""; // J146: hyprpi's automatic upkeep / orchestration notes stay off the phone
  const kind = threadKind(e);
  switch (kind) {
    case "hidden": return "";
    case "full": {
      if (e.role === "you") return `<div class="msg you">${esc(e.text)}${e.via === "phone" ? `<span class="via">📱</span>` : e.via === "voice" ? `<span class="via">🎤</span>` : ""}${images(e)}</div>`;
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
// Each world's thread is drawn into its own box inside #thread and kept (hidden) when you switch
// away, so switching back is just showing it: no parsing, no name/glyph passes (J45 made those
// passes cost ~100 ms on a long thread). A box is redrawn only when its entries or the name
// directory changed (boxSig).
function boxOf(w) {
  let box = thread.querySelector(`:scope > .tw[data-w="${w}"]`);
  if (!box) { box = document.createElement("div"); box.className = "tw"; box.dataset.w = w; box.hidden = true; thread.append(box); holdRO.observe(box); }
  return box;
}
function threadBox(w) {
  const box = boxOf(w);
  if (box.hidden) delete placeOf(w).st; // J230: #thread's scrollTop was another world's; its place is by entry, not by pixel
  for (const b of thread.querySelectorAll(":scope > .tw")) b.hidden = b !== box;
  return box;
}
// Each entry's element carries data-k (its time and role), so a place in the thread can be found
// again after a redraw (J67).
const entryKey = (e) => `${e.ts || 0}:${e.role}`;
const withKey = (html, k) => html ? html.replace(/^<(\w+)/, `<$1 data-k="${esc(k)}"`) : "";
// entries[from..to) as HTML, with the day / time separators as the full thread would have them.
function rangeHtml(entries, from, to) {
  let lastDay = "", lastTs = 0;
  for (let j = from - 1; j >= 0; j--) if (entries[j].ts) { lastDay = dayOf(entries[j].ts); lastTs = entries[j].ts; break; }
  const html = [];
  for (let i = from; i < to; i++) {
    const e = entries[i], d = dayOf(e.ts);
    if (e.role === "you" && e.ts && (d !== lastDay || e.ts - lastTs > 30 * 60e3)) html.push(`<div class="time" data-k="t${e.ts}">${d !== lastDay ? esc(new Date(e.ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) + " · " : ""}${hhmm(e.ts)}</div>`);
    if (e.ts) { lastDay = d; lastTs = e.ts; }
    html.push(withKey(entryHtml(e, i, entries), entryKey(e)));
  }
  return html.join("");
}
const nodesOf = (html) => { const t = document.createElement("div"); t.innerHTML = html; linkNames(t); textGlyphs(t); return [...t.childNodes]; };
// Draw world w's thread into its box if the box is stale (also for a hidden box). When the new
// entries only add to what's drawn (older turns in front, the server's 300 after the phone's
// cached 150; new turns at the end), they are added in place instead of redrawing the box (J67).
function fillBox(w) {
  const c = cached(w), box = boxOf(w), entries = c.entries;
  if (box.dataset.sig === boxSig(c)) return box;
  const keys = entries.map(entryKey), old = box._keys;
  if (old?.length && box.dataset.dir === String(dirVer)) { // (old entries drawn: no "Nothing here yet" in the box)
    const i = keys.indexOf(old[0]);
    if (i >= 0 && i + old.length <= keys.length && old.every((k, j) => keys[i + j] === k)) {
      if (i > 0) box.prepend(...nodesOf(rangeHtml(entries, 0, i)));
      if (i + old.length < keys.length) box.append(...nodesOf(rangeHtml(entries, i + old.length, keys.length)));
      box._keys = keys; box.dataset.sig = boxSig(c);
      return box;
    }
  }
  // "Nothing here yet" only once the server has said the thread really is empty.
  box.innerHTML = rangeHtml(entries, 0, entries.length) + (!entries.length && c.loaded ? `<div class="small empty" style="text-align:center;margin-top:30vh">Nothing here yet. Say something to Thoughts-${esc(w)}.</div>` : "");
  linkNames(box); textGlyphs(box);
  box._keys = keys; box.dataset.sig = boxSig(c); box.dataset.dir = String(dirVer); box.dataset.loaded = String(!!c.loaded);
  return box;
}
// The other shown worlds' boxes are drawn ahead, when the browser is idle, so the first switch to
// one is as quick as a revisit.
const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
let prerenderQueued = false;
function prerenderSoon() {
  if (prerenderQueued) return; prerenderQueued = true;
  idle(() => {
    prerenderQueued = false;
    const todo = worlds.filter((x) => x.shown && x.id !== world).map((x) => x.id).filter((w) => boxOf(w).dataset.sig !== boxSig(cached(w)));
    if (todo.length) { fillBox(todo[0]); if (todo.length > 1) prerenderSoon(); } // one world per idle slot
  });
}
const boxSig = (c) => `${sig(c.entries)}|${c.loaded}|${dirVer}`;
// The thread never jumps on its own (J67, Angus: "Sometimes the thoughts thread jumps back on its
// own and I have to scroll down a lot"). Per world, where the reader is: pinned to the newest turn,
// or a place (an entry and its offset from the top). It changes only when HE scrolls (touch, wheel,
// keys); anything else that moves the layout (a redraw, older turns added in front, images loading,
// estimated heights of off-screen lines becoming real, the keyboard) is followed by hold(), which
// puts him back: at the bottom, or the same entry at the same offset. Safari has no scroll anchoring
// of its own, so this does it by hand; a ResizeObserver on the thread and its boxes calls hold().
const places = new Map(); // world -> { pinned, k, off }
const placeOf = (w) => places.get(w) || places.set(w, { pinned: true, k: "", off: 0 }).get(w);
const shownBox = () => thread.querySelector(":scope > .tw:not([hidden])");
let lastUser = 0;
for (const t of ["touchstart", "touchmove", "wheel", "pointerdown", "keydown"]) thread.addEventListener(t, () => { lastUser = Date.now(); }, { passive: true });
function remember() {
  const p = placeOf(world), box = shownBox(); if (!box) return;
  p.pinned = nearBottom();
  if (p.pinned) { newestBtn.hidden = true; return; }
  const tr = thread.getBoundingClientRect();
  const el = [...box.children].find((e) => e.dataset.k && e.getBoundingClientRect().bottom > tr.top + 1);
  if (el) { p.k = el.dataset.k; p.off = el.getBoundingClientRect().top - tr.top; p.st = thread.scrollTop; }
}
thread.addEventListener("scroll", () => { if (Date.now() - lastUser < 1200) { lastUser = Date.now(); remember(); } }, { passive: true }); // his scrolling, momentum included
function hold() {
  if (view !== "thoughts" || !world) return;
  const p = placeOf(world), box = shownBox(); if (!box) return;
  if (p.pinned) { const to = thread.scrollHeight - thread.clientHeight; if (Math.abs(thread.scrollTop - to) > 1) thread.scrollTop = to; return; }
  const el = p.k && box.querySelector(`[data-k="${CSS.escape(p.k)}"]`);
  if (!el) return;
  // J230: a scroll of his that its scroll event hasn't reported yet (remember() runs on that event, one
  // frame later) is his, not a layout change: count it, or hold() would scroll him back where he was.
  const moved = p.st === undefined ? 0 : thread.scrollTop - p.st;
  const d = el.getBoundingClientRect().top - thread.getBoundingClientRect().top - (p.off - moved);
  if (Math.abs(d) >= 1) { thread.scrollTop += d; if (p.st !== undefined) p.st += d; }
}
const holdRO = new ResizeObserver(() => hold());
holdRO.observe(thread);
// "↓ newest": shown when something new arrives while he's scrolled up; a tap goes to the newest turn.
const newestBtn = document.createElement("button");
newestBtn.id = "newest"; newestBtn.textContent = "↓ newest"; newestBtn.hidden = true;
document.body.append(newestBtn);
newestBtn.addEventListener("click", () => { placeOf(world).pinned = true; newestBtn.hidden = true; hold(); });
// keep: "end" pins to the newest turn; anything else keeps his place (pinned or not).
function render({ keep = "bottom" } = {}) {
  if (view !== "thoughts") return; // drawn when Thgt is shown (setView), not in the background
  if (keep === "end") placeOf(world).pinned = true;
  threadBox(world); fillBox(world);
  newestBtn.hidden = placeOf(world).pinned || newestBtn.hidden;
  prerenderSoon();
  hold();
}
function toEnd() { placeOf(world).pinned = true; newestBtn.hidden = true; hold(); }
function append(e) {
  const c = cached(world), list = c.entries;
  if (list.length === 1 || view !== "thoughts") return render();
  const box = threadBox(world);
  if (box.dataset.sig !== boxSig({ ...c, entries: list.slice(0, -1) })) return render(); // the box is behind: draw it properly
  box.append(...nodesOf(rangeHtml(list, list.length - 1, list.length)));
  box._keys = [...(box._keys || []), entryKey(e)]; box.dataset.sig = boxSig(c);
  if (!placeOf(world).pinned) newestBtn.hidden = false; // he's reading above: say there's more, don't move him
  hold();
}
function renderTop() {
  const cur = worlds.find((w) => w.id === world);
  document.documentElement.style.setProperty("--world", cur?.color || "var(--accent)");
  document.title = `${world || ""} · Thoughts`;
  stopBtn.hidden = !busy;
  $("#dot").className = online ? "on" : "off";
  document.querySelector('.tab[data-tab="thoughts"]').classList.toggle("busy", busy);
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("cur", t.dataset.tab === (view === "session" ? "agents" : view));
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
  else if (changed) prerenderSoon();
}
const prefetched = new Set();
function refreshAll() {
  const ws = new Set([world, ...worlds.filter((x) => x.shown).map((x) => x.id)].filter(Boolean));
  for (const w of ws) prefetched.add(w), fetchWorld(w).catch((e) => { if (w === world) note("✗ " + e.message); }), fetchBoard(w).catch(() => {}), fetchAgents(w).catch(() => {}), fetchStream(w).catch(() => {});
}
function setWorld(w) {
  if (!w || w === world) return;
  if (world && view === "stream") keepStreamPlace(world);
  world = w;
  const c = cached(w);
  busy = c.busy || !!worlds.find((x) => x.id === w)?.thoughtsBusy;
  history.replaceState(null, "", `?world=${w}`);
  tellHere();
  if (filsWin) filsPost({ world: w });
  renderTop(); // at once, from the cache; only the view on screen (the others draw when shown)
  newestBtn.hidden = true;
  if (view === "thoughts") render(); else if (view === "projects") renderProjects(); else if (view === "agents") renderAgents(); else renderStream({ restore: true });
  fetchWorld(w).catch((e) => note("✗ " + e.message)); // then fresh, in the background
  fetchBoard(w).catch(() => {}); fetchAgents(w).catch(() => {}); fetchStream(w).catch(() => {});
}
// J417 follow-up: a new version of the page on the laptop → reload (the draft and waiting 📎 files are
// kept in localStorage; not while a file is uploading or a message is going: try again shortly).
let build = null;
function reloadForUpdate() {
  if (sending || atts.some((a) => !a.path && !a.err)) return setTimeout(reloadForUpdate, 5000);
  location.reload();
}
function applyState(s) {
  if (s.build) { if (!build) build = s.build; else if (s.build !== build) { build = s.build; reloadForUpdate(); return; } }
  worlds = s.worlds || []; online = !!s.online;
  if (s.directory) { const sig = JSON.stringify(s.directory); if (sig !== dirSig) { dirSig = sig; dirVer++; setDirectory(s.directory); if (world) rerenderAll(); } }
  if (s.theme) { for (const [k, v] of Object.entries(s.theme)) document.documentElement.style.setProperty("--" + k, v); document.querySelector("meta[name=theme-color]").content = s.theme.bg; }
  const first = !stateSeen; stateSeen = true;
  if (!world) setWorld(new URLSearchParams(location.search).get("world") || s.active);
  if (first) tellHere(); // J416: the world it opened on (?world= sets it without setWorld)
  renderTop();
  if (first) refreshAll();
  // A world that just appeared (F–I in use): fetch its thread now, so switching to it is instant.
  for (const x of worlds) if (x.shown && !prefetched.has(x.id)) { prefetched.add(x.id); fetchWorld(x.id).catch(() => prefetched.delete(x.id)); fetchBoard(x.id).catch(() => {}); fetchAgents(x.id).catch(() => {}); fetchStream(x.id).catch(() => {}); }
}
function listen() {
  if (es && es.readyState !== EventSource.CLOSED) return;
  es = new EventSource("/events");
  es.addEventListener("state", (ev) => applyState(JSON.parse(ev.data)));
  es.addEventListener("agents", () => agentsSoon());
  es.addEventListener("stream", (ev) => { const d = JSON.parse(ev.data); if (d.room) fetchStream(d.room).catch(() => {}); }); // the timeline changed // statuses changed: refresh the shown worlds' lists
  es.addEventListener("board", (ev) => { const d = JSON.parse(ev.data); if (d.room) boardSoon(d.room); });
  es.addEventListener("thoughts", (ev) => {
    const d = JSON.parse(ev.data), c = cached(d.room);
    if (d.reset) { c.entries = []; save(d.room); if (d.room === world) refreshAll(); } // J116: a fresh Thoughts session
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
// J194 (Angus: "I never want to be able to delete a prompt and not be able to recover it"): each composer
// keeps its unsent text in localStorage (this phone only) until it is sent, so a reload, a closed tab or
// iOS dropping the page doesn't lose it.
function keepDraft(el, key, after = () => {}) {
  try { const t = localStorage.getItem(key); if (t && !el.value) { el.value = t; after(); } } catch { /* none */ }
  el.addEventListener("input", () => { try { if (el.value) localStorage.setItem(key, el.value); else localStorage.removeItem(key); } catch { /* full */ } });
}
const dropDraft = (key) => { try { localStorage.removeItem(key); } catch { /* none */ } };
keepDraft(input, "hyprpi-rc.draft", grow);
// The box as a chat input (J59, Angus via Thoughts-E: "make the box a chat input:
// enterkeyhint="send", so the keyboard's Return key sends the message (and closes the keyboard)").
// Return sends: on the phone always (there's no Shift+Enter there) and then the keyboard closes;
// on a desktop Shift+Enter is still a new line. An empty box ignores Return; Return while an
// input method is composing (e.g. Japanese) is left to it. Works for a textarea and an <input>.
function chatKeys(el, send) {
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return; // IME: not ours
    if (e.shiftKey && !touch && el.tagName === "TEXTAREA") return; // desktop: a new line
    e.preventDefault();
    if (!el.value.trim() && !(el === input && atts.some((a) => a.path))) return; // nothing to send (J219: photos alone are something)
    send();
    if (touch) el.blur(); // the keyboard closes
  });
}
// ---- J219 (a): 📎 photos with a message to Thoughts. Each picked photo is uploaded at once into
// ~/Phone (the Files app's route and rules: no overwrite, caps; a stale token is refreshed once, J143),
// shown as a small tile with ✕; ➤ sends the text with their paths (the daemon gives Thoughts the images).
// Waiting photos are kept like the draft (J194): a reload or a failed send doesn't lose them.
const attsEl = $("#atts"), attfile = $("#attfile"), ATT_KEY = "hyprpi-rc.atts";
let atts = []; try { atts = JSON.parse(localStorage.getItem(ATT_KEY) || "[]").filter((a) => a.path); } catch { atts = []; }
const saveAtts = () => { try { const done = atts.filter((a) => a.path).map(({ name, path }) => ({ name, path })); done.length ? localStorage.setItem(ATT_KEY, JSON.stringify(done)) : localStorage.removeItem(ATT_KEY); } catch { /* full */ } };
function renderAtts() {
  attsEl.hidden = !atts.length || (typeof view !== "undefined" && view !== "thoughts");
  // J417: any file; an image shows itself (its local copy), anything else (or an image after a reload: the
  // pending folder isn't served) a tile with its name
  attsEl.innerHTML = atts.map((a, i) => `<div class="att${a.err ? " err" : ""}" data-i="${i}">${a.local ? `<img alt="" src="${esc(a.local)}">` : `<div class="af">📄<span>${esc(a.name || "")}</span></div>`}${a.path ? "" : `<div class="ap">${a.err ? "✗" : (a.pct || 0) + "%"}</div>`}<button type="button" class="ax" aria-label="remove">✕</button></div>`).join("");
  sendBtn.disabled = sending || atts.some((a) => !a.path && !a.err);
}
let upToken = null;
async function uploadToken(fresh = false) { if (!upToken || fresh) upToken = (await call("GET", "/api/files/token")).token; return upToken; }
function putPhoto(file, batch, token, onPct) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open("POST", "/api/upload");
    x.setRequestHeader("x-upload-token", token); x.setRequestHeader("x-file-name", encodeURIComponent(file.name || "photo.jpg"));
    x.setRequestHeader("x-batch", batch); x.setRequestHeader("content-type", "application/octet-stream"); x.setRequestHeader("x-pending", "1"); // J417
    x.upload.onprogress = (e) => e.total && onPct(Math.floor(e.loaded / e.total * 100));
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { /* none */ } x.status === 200 ? resolve(j) : reject(Object.assign(new Error(j.error || x.statusText || "failed"), { status: x.status })); };
    x.onerror = () => reject(new Error("network error"));
    x.send(file);
  });
}
// A phone photo can be 5–15 MB (the model takes ≤ ~5 MB an image; the daemon skips > 10 MB, silently),
// so it goes up as a JPEG of at most 2048 px on the long side; a small png/jpeg/webp/gif goes as it is.
async function shrink(f) {
  if (!/^image\//.test(f.type)) return f; // J417: a PDF, video or any other file goes as it is
  if (f.size <= 1.5e6 && /^image\/(png|jpeg|webp|gif)$/.test(f.type)) return f;
  try {
    const bm = await createImageBitmap(f, { imageOrientation: "from-image" }), k = Math.min(1, 2048 / Math.max(bm.width, bm.height));
    const c = document.createElement("canvas"); c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k);
    c.getContext("2d").drawImage(bm, 0, 0, c.width, c.height); bm.close?.();
    const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85)); if (!b) return f;
    return new File([b], (f.name || "photo").replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { return f; } // can't decode it here: send as is (the server says if it's no good)
}
async function addPhotos(files) {
  const batch = crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now();
  const items = files.map((f) => ({ name: f.name, local: /^image\//.test(f.type) ? URL.createObjectURL(f) : "", file: f, pct: 0 }));
  atts.push(...items); renderAtts();
  for (const a of items) {
    try {
      a.file = await shrink(a.file);
      let r; try { r = await putPhoto(a.file, batch, await uploadToken(), (p) => { a.pct = p; renderAtts(); }); }
      catch (e) { if (e.message !== "bad token") throw e; r = await putPhoto(a.file, batch, await uploadToken(true), (p) => { a.pct = p; renderAtts(); }); }
      a.path = r.path; delete a.file;
    } catch (e) { a.err = e.message; note(`✗ ${a.name || "file"} not uploaded: ` + e.message); }
    renderAtts(); saveAtts();
  }
}
$("#attach").addEventListener("click", () => attfile.click());
// J250: an image pasted into the box (a screenshot copied on the phone, or on a desktop) is attached as
// 📎 would; the box keeps any text that came with it.
input.addEventListener("paste", (e) => {
  const cd = e.clipboardData; if (!cd) return;
  const files = [...(cd.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) for (const it of cd.items || []) if (it.kind === "file" && it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) files.push(f); }
  if (!files.length) return;
  if (!cd.getData("text/plain")) e.preventDefault();
  addPhotos(files.map((f, i) => f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now()}${i ? "-" + i : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type })));
});
attfile.addEventListener("change", () => { const f = [...attfile.files]; attfile.value = ""; if (f.length) addPhotos(f); });
attsEl.addEventListener("click", (e) => {
  const x = e.target.closest(".ax"); if (!x) return; const i = +x.closest(".att").dataset.i; const a = atts[i];
  if (a?.local) URL.revokeObjectURL(a.local);
  if (a?.path) uploadToken().then((t) => fetch("/api/upload/discard", { method: "POST", headers: { "content-type": "application/json", "x-upload-token": t }, body: JSON.stringify({ path: a.path }) })).catch(() => {}); // J417: the pending copy goes at once
  atts.splice(i, 1); renderAtts(); saveAtts();
});
queueMicrotask(renderAtts); // after the rest of the module has set up (view)

let sending = false;
async function sendMessage() {
  const text = input.value.trim(), images = atts.filter((a) => a.path).map((a) => a.path);
  if ((!text && !images.length) || !world || sending) return;
  if (atts.some((a) => !a.path && !a.err)) return note("A photo is still uploading…");
  sending = true; sendBtn.disabled = true;
  try {
    await call("POST", "/api/send", { world, text, ...(images.length ? { images } : {}) });
    input.value = ""; dropDraft("hyprpi-rc.draft"); grow();
    for (const a of atts) if (a.local) URL.revokeObjectURL(a.local);
    atts = []; saveAtts(); renderAtts();
    busy = true; renderTop(); note(""); toEnd();
  }
  catch (err) { // the text and the photos stay; a photo that's gone from disk is marked ✗ (Pocket's check)
    const bad = err.body?.bad, a = bad && atts.find((x) => x.path === bad);
    if (a) { a.err = "gone"; delete a.path; saveAtts(); note(`✗ not sent: ${a.name} is no longer on the laptop; remove it (✕) and send again`); }
    else note("✗ not sent: " + err.message);
  }
  finally { sending = false; renderAtts(); }
}
chatKeys(input, sendMessage);
sendBtn.addEventListener("click", () => { sendMessage(); if (touch) input.blur(); });
// ■ (J38, Angus: "I want you to reply after I interrupt you"): stop the reply; Thoughts then says in
// a line or two what got cut off and asks what's next. The cursor goes to the box.
stopBtn.addEventListener("click", async () => {
  input.focus({ preventScroll: true });
  try { await call("POST", "/api/stop", { world, ask: true }); } catch (err) { note("✗ " + err.message); }
});
// A tap on a thumbnail (J63) or on any file link, in every tab, opens the file viewer over the app
// (J70, fileview.mjs: ✕ back to the same place, Share). Installed once, at the top.
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
//  4. Drags outside the scrollable panes and the text box are swallowed (no rubber-banding the bar).
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
input.addEventListener("focus", () => { fitViewport(); requestAnimationFrame(() => { fitViewport(); hold(); }); });
// Scrollable panes (the thread, the Proj tab: J42) and the text box keep their drags.
document.addEventListener("touchmove", (e) => { if (!e.target.closest("#thread, #projects, #agents, #stream, #input, #sbar, #files, #session, #sinput")) e.preventDefault(); }, { passive: false });

// J416: tell the server which world is on screen, so a share from the iPhone's Share sheet with no
// ?world= lands here (Angus: "yes to currently open wrld"). On a switch, on coming to the front, and
// every minute while visible. Fire and forget.
function tellHere() { if (world && document.visibilityState === "visible") fetch("/api/shot/here", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ world }), cache: "no-store" }).catch(() => {}); }
setInterval(tellHere, 60e3);
// iOS drops the connection when the app goes to the background: catch up on return.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { listen(); tellHere(); if (world) refreshAll(); } });
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
const boardSoon = (w) => { clearTimeout(boardTimers[w]); boardTimers[w] = setTimeout(() => { fetchBoard(w).catch(() => {}); fetchAgents(w).catch(() => {}); }, 250); }; // agents show their projects too
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
    const by = (it) => it.by ? ` <span class="small">(${esc(it.by)})</span>` : ""; // who added it, as on the desktop card
    const items = (list, done) => list.length ? `<ul class="items">${list.map((it) => `<li><span class="h">${esc(it.h)}</span> <div class="md">${md(it.text)}${by(it)}</div>${done && it.verified ? `<div class="small clip">✓ ${inline(it.verified)}</div>` : ""}${it.resolution ? `<div class="small">→ decided: ${inline(it.resolution)}</div>` : ""}</li>`).join("")}</ul>` : "";
    // J219 (b): each option is tappable (a confirm sheet, then it's answered as from the desktop panel);
    // "Answer in my own words…" for an answer that isn't one of them.
    const decide = p.decide.map((it) => `<li><span class="h">${esc(it.h)}</span> <div class="md">${md(it.text)}${by(it)}</div>${(it.options || []).length ? `<ol class="opts">${it.options.map((o) => `<li class="opt" data-p="${esc(p.id)}" data-h="${esc(it.h)}" data-k="${esc(o.key)}"><b>${esc(o.key)})</b> ${inline(o.text)}${o.key === it.default ? ` <span class="small">(default)</span>` : ""}${o.key === it.recommend ? ` <span class="rec">★ recommended</span>` : ""}</li>`).join("")}</ol>` : ""}<button type="button" class="ownans" data-p="${esc(p.id)}" data-h="${esc(it.h)}">Answer in my own words…</button></li>`).join("");
    html.push(`<div class="psum">` // no back button (J41 v2): the title, or Proj in the top bar, goes back to the list
      // The header (J48): icon, name, badge, title and owner/members as ONE tap target, the full width,
      // that goes back to the list. Names in it are not links (the J45 pass skips .phead): the
      // name used to be a link to this same project, which took the tap and re-opened it.
      + `<div class="phead ptoggle" title="back to the projects"><h2><span class="backbtn" aria-label="back to the projects">‹</span><span class="pic">${esc(p.icon)}</span><span>@${esc(p.name)} ${badge(p.status)}</span></h2>`
      + `${p.title ? `<div class="ptitle">${esc(p.title)}</div>` : ""}`
      + `</div>`
      // J219 (c): owner and members just below the header (outside its back-tap, J48), each a link to
      // that agent's session page when it's a listed agent; plain text otherwise.
      + (p.writer || p.members?.length ? `<div class="ppeople">${p.writer ? `owner ${personLink(p.writer)}` : ""}${(p.members || []).filter((m) => m !== p.writer).length ? `${p.writer ? " · " : ""}members ${(p.members || []).filter((m) => m !== p.writer).map(personLink).join(", ")}` : ""}</div>` : "")
      + sec("Where", p.where ? `<div class="md">${md(p.where)}</div>` : "")
      + (p.decide.length ? `<details class="needs"${needsOpen ? " open" : ""}><summary>Needs you <span class="cnt">${p.decide.length}</span></summary><ul class="items">${decide}</ul></details>` : "")
      + sec("Next", items(p.next)) + sec("Done", items(p.done, true))
      + sec("Next first step", p.next_step ? `<div class="md">${md(p.next_step)}</div>` : "")
      + `</div>`);
  }
  projectsEl.innerHTML = html.join("");
  linkNames(projectsEl); textGlyphs(projectsEl);
  projectsEl.scrollTop = keepScroll ? was : 0;
}
function setView(v) {
  if (v === "agents" && view === "session") { view = "agents"; sessEl.hidden = true; $("#scomp").hidden = true; sess.agent = null; agentsEl.hidden = false; renderTop(); renderAgents(); return; } // J161: Agnt from a session → its summary
  if (v === view) { // Proj / Agnt again: back to the list
    if (v === "projects" && openProject.get(world)) { openProject.delete(world); renderProjects(); }
    if (v === "agents" && openAgent.get(world)) { openAgent.delete(world); renderAgents(); }
    return;
  }
  // leaving Strm: keep its place (J144: this ran after `view = v`, so it never saw Strm being left and a
  // return to Strm always jumped to the newest event).
  if (view === "stream" && world) keepStreamPlace(world);
  view = v;
  $("#thread").hidden = v !== "thoughts"; $("#composer").hidden = v !== "thoughts"; projectsEl.hidden = v !== "projects"; agentsEl.hidden = v !== "agents"; streamEl.hidden = v !== "stream"; sbar.hidden = v !== "stream";
  filsEl.hidden = v !== "files"; if (v === "files") filsFrame();
  attsEl.hidden = v !== "thoughts" || !atts.length; // J219: waiting photos belong to the Thgt box
  sessEl.hidden = v !== "session"; $("#scomp").hidden = v !== "session"; if (v !== "session") sess.agent = null; // J161
  renderTop();
  if (v === "projects") { renderProjects(); fetchBoard(world).catch(() => {}); }
  else if (v === "agents") { renderAgents(); fetchAgents(world).catch(() => {}); }
  else if (v === "stream") { renderStream({ restore: true }); fetchStream(world).catch(() => {}); }
  else render({ keep: "restore" });
}
// J219 (c): a person in a project's owner/members line → that agent's session page (its world too).
const agentByName = (n) => dirAgents.find((a) => a.kind === "agent" && (a.display === n || a.name === n));
const personLink = (n) => agentByName(n) ? `<a class="pagent" href="#" data-name="${esc(n)}">${esc(n)}</a>` : esc(n);
// J219 (b): answering a decision from the phone. A tap on an option (or "own words") opens a confirm
// sheet with an optional note; Answer sends it like the desktop panel (board.item decide: the item becomes
// a Next item holding the answer, and its raiser and the card's owner are told). Nothing is sent without
// the confirm.
function decideSheet(pid, h, key) {
  const b = boardOf(world), p = b.projects.find((x) => x.id === pid), it = p?.decide.find((x) => x.h === h); if (!it) return;
  const o = key ? it.options.find((x) => x.key === key) : null;
  const sh = document.createElement("div"); sh.id = "dsheet";
  sh.innerHTML = `<div class="dpanel" role="dialog"><div class="small">@${esc(p.name)} ${esc(h)}</div><div class="dq">${inline(it.text)}</div>`
    + (o ? `<div class="dchoice"><b>${esc(o.key)})</b> ${inline(o.text)}</div>` : "")
    + `<textarea id="dwords" rows="2" placeholder="${o ? "add a note (optional)" : "your answer"}"></textarea>`
    + `<div class="dact"><button type="button" class="dno">Cancel</button><button type="button" class="dyes">${o ? `Answer ${esc(o.key)}` : "Answer"}</button></div></div>`;
  document.body.append(sh);
  const close = () => sh.remove();
  sh.addEventListener("click", (e) => { if (e.target === sh || e.target.closest(".dno")) close(); });
  sh.querySelector(".dyes").addEventListener("click", async (e) => {
    const words = sh.querySelector("#dwords").value.trim();
    if (!o && !words) return sh.querySelector("#dwords").focus();
    e.target.disabled = true;
    try {
      const r = await call("POST", "/api/decide", { world, project: pid, h, ...(o ? { answer: words ? `${o.key} ${words}` : o.key } : { answer: words, typed: true }) });
      close(); note(`${h} answered${r.told?.length ? " → " + r.told.join(", ") + " told" : ""}`); setTimeout(() => note(""), 4000);
      fetchBoard(world).catch(() => {});
    } catch (err) { e.target.disabled = false; note("✗ not answered: " + err.message); }
  });
}
projectsEl.addEventListener("click", (e) => {
  const op = e.target.closest(".opt, .ownans");
  if (op && !e.target.closest("a")) return decideSheet(op.dataset.p, op.dataset.h, op.dataset.k || "");
  const pa = e.target.closest(".pagent");
  if (pa) { e.preventDefault(); const a = agentByName(pa.dataset.name); if (a) { if (a.room && a.room !== world) setWorld(a.room); openSession(a.id); } return; }
  const pr = e.target.closest(".proj"); if (pr) { openProject.set(world, pr.dataset.p); return renderProjects(); }
  if (e.target.closest(".phead")) { openProject.delete(world); return renderProjects(); } // the header: back to the list
  const c = e.target.closest(".clip"); if (c && !e.target.closest("a")) c.classList.toggle("open");
});
projectsEl.addEventListener("toggle", (e) => {
  if (e.target.matches("details.needs")) { needsOpen = e.target.open; localStorage.setItem("hyprpi-rc.needsOpen", needsOpen ? "1" : "0"); }
}, true);

// ---- the Agnt tab (J43): this world's agents, as the desktop agents panel lists them -----------
// Angus: "lets make the agents panel for remote-control". The list: mark (● working · × needs you ·
// ✓ finished · ○ idle · ◌ not open), icon, name, workspace, topic, how long ago. Tap one: a short
// read-only summary (status, topic, current job, projects, model, last room posts); the title (its
// row) or Agnt goes back. Cached, prefetched and refreshed live like the boards. Read-only.
const agentLists = new Map(); // world -> { agents, loaded }
const openAgent = new Map(); // world -> agent id
const agentsEl = $("#agents");
const LSA = (w) => "hyprpi-rc.agents." + w;
function agentsOf(w) {
  let l = agentLists.get(w);
  if (!l) {
    l = { agents: [], loaded: false };
    try { const st = JSON.parse(localStorage.getItem(LSA(w)) || "null"); if (Array.isArray(st?.agents)) l.agents = st.agents; } catch { /* none */ }
    agentLists.set(w, l);
  }
  return l;
}
async function fetchAgents(w) {
  const r = await call("GET", `/api/agents?world=${w}`), l = agentsOf(w);
  const changed = !l.loaded || JSON.stringify(r.agents) !== JSON.stringify(l.agents);
  l.agents = r.agents || []; l.loaded = true;
  try { localStorage.setItem(LSA(w), JSON.stringify({ agents: l.agents })); } catch { /* memory only */ }
  if (w === world && view === "agents" && changed) renderAgents({ keepScroll: true });
}
let agentsTimer = null;
function agentsSoon() {
  clearTimeout(agentsTimer);
  agentsTimer = setTimeout(() => { for (const w of new Set([world, ...worlds.filter((x) => x.shown).map((x) => x.id)])) fetchAgents(w).catch(() => {}); }, 300);
}
function ago(ts) {
  if (!ts) return "";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
const agentName = (a) => `<span class="aname"${a.color ? ` style="color:${esc(a.color)}"` : ""}>${esc(a.name)}</span>`;
function agentRow(a, cls = "agent") {
  const meta = [a.ws, a.compactions >= 1 ? `⟳${a.compactions}` : "", a.topic ? `<i>${esc(a.topic)}</i>` : "", a.active ? ago(a.active) : ""].filter(Boolean).join(" · "); // J117 ⟳N: compactions
  return `<button class="${cls}${a.mark === "◌" ? " gone" : ""}" data-a="${esc(a.id)}">${cls === "agent open" ? `<span class="backbtn" aria-label="back to the agents">‹</span>` : ""}<span class="amark m${a.mark === "●" ? "w" : a.mark === "◐" ? "b" : a.mark === "×" ? "x" : a.mark === "✓" ? "d" : "i"}">${esc(a.mark)}</span><span class="pic">${esc(a.icon || "")}</span><span class="pmain"><span class="pname">${agentName(a)}</span><span class="pwhere">${meta}</span></span>${cls === "agent" || (cls === "agent open" && a.mark !== "◌") ? `<span class="chev aopen" title="open its session">›</span>` : ""}</button>`; // J236: the summary's header too
}
function renderAgents({ keepScroll = false } = {}) {
  if (view !== "agents") return;
  const l = agentsOf(world), was = agentsEl.scrollTop;
  const a = l.agents.find((x) => x.id === openAgent.get(world));
  const html = [];
  if (!a) {
    for (const x of l.agents) html.push(agentRow(x));
    if (!l.agents.length && l.loaded) html.push(`<div class="small empty" style="text-align:center;margin-top:30vh">No agents in world ${esc(world)}.</div>`);
  } else {
    const sec = (title, inner) => inner ? `<section><h3>${title}</h3>${inner}</section>` : "";
    const status = { "●": "working", "◐": "background (subagents still running)", "×": "needs you", "✓": "finished (not seen yet)", "○": "idle", "◌": a.status }[a.mark] || a.status;
    html.push(`<div class="psum"><div class="phead ptoggle" title="back to the agents">` + agentRow(a, "agent open") + `</div>` // its row is the header: one tap target back to the list (J48)
      + sec("Status", `<div>${esc(a.mark)} ${esc(status)}${(a.helpers || []).length ? ` <span class="small">· ${a.helpers.map((h) => esc(`${h.description || h.type || "?"} (${[h.type, h.startedAt ? Math.max(1, Math.round((Date.now() - h.startedAt) / 60000)) + " min" : ""].filter(Boolean).join(", ")})`)).join(", ")}</span>` : ""}${a.active ? ` <span class="small">· last turn ${ago(a.active)} ago</span>` : ""}</div>${a.topic ? `<div class="md"><i>${esc(a.topic)}</i></div>` : ""}${a.did ? `<div class="small clip">${inline(a.did)}</div>` : ""}`)
      + sec("Current job", a.job ? `<div>⟦${esc(a.job.id)} v${esc(a.job.version)} · ${esc(a.job.state)}⟧${a.job.project ? ` <span class="small">@${esc(a.job.project)}</span>` : ""}</div><div class="md">${md(a.job.goal)}</div>` : "")
      + sec("Projects", a.projects.length ? `<div>${a.projects.map((p) => `${esc(p.icon)} @${esc(p.name)}${p.writer ? ` <span class="small">(owner)</span>` : ""}`).join("<br>")}</div>` : "")
      + sec("Model", a.model ? `<div>${esc(a.model)}${a.thinking ? ` <span class="small">· thinking ${esc(a.thinking)}</span>` : ""}</div>` : "")
      // Its last lines in the Stream, any kind (room D #304: Summoner had events but no room posts),
      // then a link to Strm filtered on it.
      + sec("In the stream", `${(a.recent || []).length ? `<ul class="items">${a.recent.map((m) => `<li><span class="h">${hhmm(m.ts)}</span> <div class="clip">${inline(m.text)}</div></li>`).join("")}</ul>` : `<div class="small">nothing in the last 200 interactions</div>`}${a.mark !== "◌" ? `<button class="tosession" data-a="${esc(a.id)}">Open ${esc(a.name)} session ›</button>` : ""}<button class="tostream" data-name="${esc(a.name)}">Stream: only ${esc(a.name)} ›</button>`)
      + `</div>`);
  }
  agentsEl.innerHTML = html.join("");
  linkNames(agentsEl); textGlyphs(agentsEl);
  agentsEl.scrollTop = keepScroll ? was : 0;
}
agentsEl.addEventListener("click", (e) => {
  const hs = e.target.closest(".phead .aopen"); if (hs) return openSession(hs.closest(".agent").dataset.a); // J236: › at the top right → its session
  if (e.target.closest(".phead")) { openAgent.delete(world); return renderAgents(); } // the header: back to the list (J48)
  const ts = e.target.closest(".tostream"); if (ts) { streamOnly(ts.dataset.name); return setView("stream"); } // its lines in Strm
  const so = e.target.closest(".tosession"); if (so) return openSession(so.dataset.a); // J161
  if (e.target.closest("a")) return;
  const t = e.target.closest(".agent");
  if (t && e.target.closest(".aopen") && !t.classList.contains("gone")) return openSession(t.dataset.a); // J161: the arrow opens its session
  if (t) { openAgent.set(world, t.dataset.a); return renderAgents(); }
  const c = e.target.closest(".clip"); if (c) c.classList.toggle("open");
});

// ---- names as links (J45, Angus: "jump from agents to project or another agent when they are
// listed, and also from inside projects to agents mentioned or assigned, and to other projects …
// ALso the same thing for inside thoughts"). After each render, agent names (live or lost to a
// restart, any world), "Thoughts-X" and @projects in the text become tappable: the agent opens in
// Agnt, the project in Proj, Thoughts-X in Thgt, switching world if it lives elsewhere. Matching
// is the desktop's agentIn() (longest name after an icon/@/punctuation, not followed by a letter).
// Phone-only guards so plain words never link: a project needs its "@"; an agent named without
// "@" must match its name's capitalisation (so "remote control" isn't Remote, "knock" isn't Knock).
let dirAgents = [], dirProjects = [], namesRe = null, dirSig = "", dirVer = 0;
// The directory changed (an agent came or went, a project was added): redraw what's on screen.
function rerenderAll() { if (view === "thoughts") render(); else if (view === "projects") renderProjects({ keepScroll: true }); else if (view === "agents") renderAgents({ keepScroll: true }); else renderStream(); }
function setDirectory(d) {
  dirAgents = d.agents || []; dirProjects = d.projects || [];
  const names = [...dirAgents.flatMap((a) => [a.display, a.name]), ...dirProjects.map((p) => p.name)].filter((n) => n && n.length > 1);
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  namesRe = names.length ? new RegExp(names.sort((a, b) => b.length - a.length).map(escRe).join("|"), "i") : null;
}
function matchWord(word) {
  const lead = (/^[^\p{L}\p{N}]+/u.exec(word) || [""])[0], at = lead.endsWith("@");
  if (at) { const p = agentIn(word, dirProjects); if (p) return { hit: p, kind: "project", len: lead.length + p.display.length, skip: lead.length - 1 }; } // the link starts at its "@"
  const a = agentIn(word, dirAgents);
  if (!a) return null;
  const rest = word.slice(lead.length);
  const n = [a.display, a.name].filter(Boolean).sort((x, y) => y.length - x.length).find((x) => rest.toLowerCase().startsWith(x.toLowerCase()));
  if (!n || (!at && !rest.startsWith(n))) return null; // without "@": its own capitalisation only
  return { hit: a, kind: a.kind, len: lead.length + n.length, skip: at ? lead.length - 1 : lead.length }; // from its "@" if any
}
function linkNames(root) {
  if (!namesRe) return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => namesRe.test(n.data) && !n.parentElement?.closest("a, code, pre, .nl, .tx, .phead, .ppeople, button, textarea") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
  const nodes = []; while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const n of nodes) {
    const parts = n.data.split(/(\s+)/); let changed = false;
    const frag = document.createDocumentFragment();
    for (const w of parts) {
      const m = w && !/^\s+$/.test(w) && namesRe.test(w) ? matchWord(w) : null; // the quick test first: most words name nothing
      // In the open agent's own row (its title) its own name stays plain: that row goes back.
      if (!m) { frag.append(w); continue; }
      const start = m.skip ?? 0;
      if (start) frag.append(w.slice(0, start));
      const sp = document.createElement("span");
      sp.className = "nl"; sp.dataset.kind = m.kind; sp.dataset.id = m.hit.id; sp.dataset.room = m.hit.room;
      if (m.hit.color) sp.style.color = m.hit.color;
      sp.textContent = w.slice(start, m.len); frag.append(sp);
      if (m.len < w.length) frag.append(w.slice(m.len));
      changed = true;
    }
    if (changed) n.replaceWith(frag);
  }
}
// Tap a name: open it where it lives. No history stack: the tabs work as before.
function jumpTo(kind, id, room) {
  if (room && room !== world) setWorld(room);
  if (kind === "thoughts") return setView("thoughts");
  const target = kind === "project" ? "projects" : "agents";
  (kind === "project" ? openProject : openAgent).set(world, id);
  if (view === target) { kind === "project" ? renderProjects() : renderAgents(); } else setView(target);
  (kind === "project" ? projectsEl : agentsEl).scrollTop = 0;
}
document.addEventListener("click", (e) => {
  const l = e.target.closest(".nl"); if (!l) return;
  e.preventDefault(); e.stopPropagation(); // not a <summary> toggle, a row tap or a .clip unfold
  jumpTo(l.dataset.kind, l.dataset.id, l.dataset.room);
}, true);

// ---- the Strm tab (J49, Angus: "we might as well add Strm … a compact mode by default, but then
// make it easy to open up events fully, and close them again … multiple events open fully at the
// same time, they stay within the scrollable stream"). The world's Stream as the desktop panel
// builds it (server: lib/stream.mjs); one line per event (time, who in its colour, the first
// line); a tap opens it in place (full text, Markdown, links, name links) and a tap closes it.
// Open events are remembered per world (in memory) across tabs and worlds. Read-only; cached,
// prefetched and live like the other tabs.
const streamEl = $("#stream"), sbar = $("#sbar"), sq = $("#sq"), sx = $("#sx"), skinds = $("#skinds");
const streams = new Map(); // world -> { items, loaded, open: Set(key), scroll, q, kinds: Set, pool, all }
const LSS = (w) => "hyprpi-rc.stream." + w;
function streamOf(w) {
  let st = streams.get(w);
  if (!st) {
    st = { items: [], loaded: false, open: new Set(), scroll: null, q: "", kinds: new Set(), pool: { agents: [], projects: [] }, all: null };
    try { const x = JSON.parse(localStorage.getItem(LSS(w)) || "null"); if (Array.isArray(x?.items)) st.items = x.items; } catch { /* none */ }
    streams.set(w, st);
  }
  return st;
}
const streamNearEnd = () => streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 60;
async function fetchStream(w) {
  const r = await call("GET", `/api/stream?world=${w}`), st = streamOf(w);
  const next = r.items || [], changed = !st.loaded || next.length !== st.items.length || next.at(-1)?.k !== st.items.at(-1)?.k || next.at(-1)?.text !== st.items.at(-1)?.text;
  st.items = next; st.loaded = true; st.pool = { agents: r.agents || [], projects: r.projects || [] };
  try { localStorage.setItem(LSS(w), JSON.stringify({ items: next.slice(-250) })); } catch { /* memory only */ }
  if (w === world && view === "stream" && changed) renderStream();
}

// ---- the Strm filter bar (J60, Angus: "a search bar at the bottom of stream to filter messages w
// a keyword - maybe also to do everything the reg text bar does in hyprpi version on laptop … Yes to
// all"). Filter-only: it never posts anywhere. The syntax is the desktop Stream panel's own,
// parsed and applied by lib/stream.mjs (served as-is, the same module room-tui uses): words (all
// must match), @Name / @project (by, to, about), 3h · 90m · 2d · today · yesterday · since 9am.
// Names resolve against the same pool as the desktop (the world's agents and dormant ones, the
// board's projects). Phone extras: @Angus (his lines), board changes made under a name, and kind
// chips (Posts · Did · Topics · Talk · Board · Other). "search all history ›" runs the same filter
// over the world's whole history on the server. Kept per world; ✕ clears.
const KINDS = [["posts", "Posts"], ["did", "Did"], ["topics", "Topics"], ["talk", "Talk"], ["board", "Board"], ["other", "Other"]];
const kindGroup = (k) => k === "post" || k === "angus" || k === "thoughts" ? "posts" : k === "turn" ? "did" : k === "topic" ? "topics" : k === "board" ? "board" : ["talk", "demand", "reply", "prompt"].includes(k) ? "talk" : "other";
const filtering = (st) => !!(st.q.trim() || st.kinds.size);
// The items as lib/stream.mjs's filter sees them (the raw fields the server sends along, J60).
const asStreamItem = (it) => ({ key: it.k, ts: it.ts, kind: it.kind, who: { id: it.f?.id || "", name: it.f?.name || "", human: !!it.f?.human }, to: it.f?.to || [], project: it.f?.project || null, text: it.f?.text ?? it.text, pname: it.f?.pname || "" });
function applyFilter(st, items) {
  const f = parseStreamFilter(st.q), objs = items.map(asStreamItem);
  const r = f.names.length ? resolveFilterNames(f.names, { agents: st.pool.agents, projects: st.pool.projects, items: objs }) : null;
  const keep = new Set(filterStream(objs, f, r).map((o) => o.key));
  for (const n of f.names) { // the phone's extras (the same on the server's "all history")
    if (n.toLowerCase() === "angus") for (const o of objs) if (o.who.human || o.kind === "prompt") keep.add(o.key);
    for (const o of objs) if (o.kind === "board" && o.who.name.toLowerCase() === n.toLowerCase()) keep.add(o.key);
  }
  const unknown = (r?.unknown || []).filter((n) => n.toLowerCase() !== "angus" && !objs.some((o) => o.kind === "board" && o.who.name.toLowerCase() === n.toLowerCase()));
  return { f, unknown, list: items.filter((it) => keep.has(it.k) && (!st.kinds.size || st.kinds.has(kindGroup(it.kind)))) };
}
// Matched words, highlighted: in an escaped one-liner, and in the text nodes of an opened event.
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordsRe = (words) => words.length ? new RegExp("(" + words.map(reEsc).sort((a, b) => b.length - a.length).join("|") + ")", "gi") : null;
const hlText = (html, re) => re ? html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => tag || txt.replace(re, "<mark>$1</mark>")) : html;
function hlNodes(root, re) {
  if (!re) return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
  while (walk.nextNode()) { re.lastIndex = 0; if (re.test(walk.currentNode.data)) nodes.push(walk.currentNode); }
  for (const n of nodes) { const span = document.createElement("span"); re.lastIndex = 0; span.innerHTML = esc(n.data).replace(re, "<mark>$1</mark>"); n.replaceWith(...span.childNodes); }
}
function streamOnly(name, w = world) { // "only X ›" and Agnt's "Stream: only X ›": the filter becomes @X
  const st = streamOf(w);
  st.q = name ? "@" + name : ""; st.all = null; st.scroll = null; st.pinEnd = true;
  if (w === world && view === "stream") renderStream({ restore: true });
}
const evFirst = (t) => String(t || "").split("\n").find((x) => x.trim()) || "";
function streamRow(it, open, re) {
  const day = new Date(it.ts).toDateString() !== new Date().toDateString();
  const when = new Date(it.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const tag = it.project ? ` <span class="sproj">@${esc(it.project)}</span>` : "";
  const who = `<span class="swho"${it.who.color ? ` style="color:${esc(it.who.color)}"` : ""}>${esc(it.who.name)}</span>`;
  // Compact: who and the first line, no time (J52). Open: the time (and the date if not today).
  const stamp = `${esc(when)}${day ? " · " + esc(new Date(it.ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) : ""}`;
  // Open: "only X ›" at the right of the time line (room D #304) puts @X in the filter.
  const only = it.by && streamOf(world).q.trim() !== "@" + it.by ? `<button class="sonly" data-name="${esc(it.by)}">only ${esc(it.by)} ›</button>` : "";
  return `<div class="ev k-${esc(it.kind)}${open ? " open" : ""}" data-k="${esc(it.k)}"><div class="sline">${who} <span class="sone">${hlText(esc(evFirst(it.text)), re)}</span></div>`
    + (open ? `<div class="stime"><span>${stamp}</span>${only}</div><div class="sfull md">${md(it.text)}${tag}</div>` : "") + `</div>`;
}
let shown = []; // the rows on screen (for taps)
function renderStream({ restore = false } = {}) {
  if (view !== "stream") return;
  const st = streamOf(world), atEnd = streamNearEnd(), was = streamEl.scrollTop;
  // J230: a live redraw keeps him on the same event at the same offset (the oldest events drop off the
  // top as new ones come, so a pixel scrollTop alone slid him a row or more each time).
  const top0 = streamEl.getBoundingClientRect().top;
  const a0 = !restore && !atEnd && [...streamEl.querySelectorAll(".ev[data-k]")].find((e) => e.getBoundingClientRect().bottom > top0 + 1);
  const anc = a0 ? { k: a0.dataset.k, off: a0.getBoundingClientRect().top - top0 } : null;
  const on = filtering(st), allOn = on && st.all && st.all.q === st.q && st.all.kinds === [...st.kinds].join(",");
  let list = st.items, f = null, unknown = [], head = "", foot = "";
  if (allOn) {
    list = st.all.items || []; f = parseStreamFilter(st.q);
    head = `<div class="shead">All history · ${st.all.loading ? "searching…" : `${st.all.total} match${st.all.total === 1 ? "" : "es"}${st.all.total > list.length ? `, the newest ${list.length}` : ""}${st.all.from ? " since " + esc(new Date(st.all.from).toLocaleDateString([], { month: "short", day: "numeric" })) : ""}`}<button class="sback">recent only</button></div>`;
  } else if (on) {
    ({ f, unknown, list } = applyFilter(st, st.items));
    foot = `<div class="sfoot"><span>${list.length} of the last ${st.items.length} events</span><button class="sall">search all history ›</button></div>`;
  }
  const re = f ? wordsRe(f.words) : null;
  shown = list;
  const hint = unknown.length ? `<div class="small shint">no agent or project named ${unknown.map((n) => "@" + esc(n)).join(", ")} in world ${esc(world)}</div>` : "";
  const empty = !list.length && (allOn ? !st.all.loading : on || st.loaded)
    ? `<div class="small empty" style="text-align:center;margin-top:24vh">${on ? `Nothing matches${allOn ? " in all of world " + esc(world) + "'s history" : " in the last " + st.items.length + " events"}.` : `Nothing in world ${esc(world)}'s stream yet.`}</div>` : "";
  streamEl.innerHTML = head + hint + list.map((it) => streamRow(it, st.open.has(it.k), re)).join("") + empty + foot;
  for (const el of streamEl.querySelectorAll(".ev.open .sfull")) { linkNames(el); textGlyphs(el); hlNodes(el, re); }
  textGlyphs(streamEl);
  // the bar shows this world's filter
  if (document.activeElement !== sq || sq.dataset.w !== world) sq.value = st.q; // another world: its own filter, even while typing
  sq.dataset.w = world;
  sx.hidden = !on;
  for (const c of skinds.querySelectorAll(".kchip")) c.classList.toggle("on", st.kinds.has(c.dataset.k));
  if (st.pinEnd || (restore && st.scroll == null) || (!restore && atEnd)) streamToEnd(); // at the end: follow new events
  else {
    streamEl.scrollTop = restore ? st.scroll : was;
    const A = restore ? st.anchor : anc, el = A && streamEl.querySelector(`.ev[data-k="${CSS.escape(A.k)}"]`);
    if (el) { const d = el.getBoundingClientRect().top - streamEl.getBoundingClientRect().top - A.off; if (Math.abs(d) >= 1) streamEl.scrollTop += d; }
  }
  if (st.pinEnd && st.loaded && !(allOn && st.all.loading)) st.pinEnd = false;
}
// To the end; rows off screen have estimated heights (content-visibility), so pin again for a few frames.
// J144: Strm's place is kept as the first visible event and its offset (not a pixel scrollTop): events
// come and go above it between visits, which made a return land a few rows off.
function keepStreamPlace(w) {
  const st = streamOf(w);
  if (streamNearEnd()) { st.scroll = null; st.anchor = null; return; }
  st.scroll = streamEl.scrollTop;
  const top = streamEl.getBoundingClientRect().top;
  const el = [...streamEl.querySelectorAll(".ev[data-k]")].find((e) => e.getBoundingClientRect().bottom > top + 1);
  st.anchor = el ? { k: el.dataset.k, off: el.getBoundingClientRect().top - top } : null;
}
function streamToEnd(n = 4) {
  streamEl.scrollTop = streamEl.scrollHeight;
  if (n > 0) requestAnimationFrame(() => { if (!streamEl.hidden && streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 2500) streamToEnd(n - 1); });
}
async function searchAllHistory() {
  const st = streamOf(world), w = world, q = st.q, kinds = [...st.kinds].join(",");
  st.all = { q, kinds, items: [], total: 0, loading: true }; st.pinEnd = true; renderStream();
  try { const r = await call("GET", `/api/stream?world=${w}&all=1&q=${encodeURIComponent(q)}&kinds=${encodeURIComponent(kinds)}`); if (st.all?.q === q && st.all.kinds === kinds) { st.all = { q, kinds, items: r.items || [], total: r.total || 0, from: r.from || 0, loading: false }; st.pinEnd = true; } }
  catch (e) { st.all = null; note("✗ " + e.message); }
  if (w === world) renderStream();
}
// A tap on an event opens / closes it in place (not when the tap is on a link inside it).
streamEl.addEventListener("click", (e) => {
  const on = e.target.closest(".sonly"); if (on) return streamOnly(on.dataset.name); // @that agent in the filter
  if (e.target.closest(".sall")) return searchAllHistory();
  if (e.target.closest(".sback")) { streamOf(world).all = null; streamOf(world).pinEnd = true; return renderStream(); }
  if (e.target.closest("a, .nl, .shead, .sfoot")) return;
  const ev = e.target.closest(".ev"); if (!ev) return;
  const st = streamOf(world), k = ev.dataset.k, it = shown.find((x) => x.k === k); if (!it) return;
  if (st.open.has(k)) st.open.delete(k); else st.open.add(k);
  const re = filtering(st) ? wordsRe(parseStreamFilter(st.q).words) : null;
  const tmp = document.createElement("div"); tmp.innerHTML = streamRow(it, st.open.has(k), re);
  const row = tmp.firstElementChild; ev.replaceWith(row);
  const full = row.querySelector(".sfull"); if (full) { linkNames(full); hlNodes(full, re); }
  textGlyphs(row);
});
// The bar: live as you type (a short pause batches fast typing); Return closes the keyboard;
// ✕ clears words, names, times and chips. Nothing here is ever sent.
skinds.innerHTML = KINDS.map(([k, l]) => `<button class="kchip" data-k="${k}">${l}</button>`).join("");
let sqTimer = null;
sq.addEventListener("input", () => {
  const st = streamOf(world); st.q = sq.value; st.all = null; st.pinEnd = true;
  clearTimeout(sqTimer); sqTimer = setTimeout(() => renderStream(), 60);
});
sq.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (touch) sq.blur(); } });
sx.addEventListener("click", () => { const st = streamOf(world); st.q = ""; st.kinds.clear(); st.all = null; st.pinEnd = true; sq.value = ""; renderStream(); });
skinds.addEventListener("click", (e) => {
  const c = e.target.closest(".kchip"); if (!c) return;
  const st = streamOf(world); st.kinds.has(c.dataset.k) ? st.kinds.delete(c.dataset.k) : st.kinds.add(c.dataset.k); st.all = null; st.pinEnd = true; renderStream();
});
// J37 for this box too: a tap focuses it without Safari panning the page.
sq.addEventListener("touchend", (e) => { if (document.activeElement === sq) return; e.preventDefault(); sq.focus({ preventScroll: true }); }, { passive: false });
sq.addEventListener("focus", () => { fitViewport(); requestAnimationFrame(fitViewport); });

// ---- the Fils tab (J141, Angus: "integrate the file app and the remote control app … a separate
// "Fils" tab next to Strm"). iOS doesn't let two Home Screen apps share anything, so the Files app
// (Pocket's J74, still at /files/ on its own icon) is embedded: /files/?embed=1 in a frame, made the
// first time Fils is shown and kept (its folder, selection and uploads stay while you switch tabs).
// In there: browse and view the allowed folders, upload into ~/Phone, Share, and "Send…" to a
// world's Thoughts or any live agent. π tells it the current world and which file to open.
const filsEl = $("#files");
let filsWin = null, filsReady = false, filsQueue = [];
function filsFrame() {
  if (filsEl.firstElementChild) return;
  const f = document.createElement("iframe");
  f.src = `/files/?embed=1&world=${world || ""}`; f.title = "Files"; f.allow = "web-share; clipboard-write";
  filsEl.append(f); filsWin = f.contentWindow;
}
addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data?.filsReady) return;
  filsReady = true; filsPost({ world });
  for (const m of filsQueue.splice(0)) filsPost(m);
});
function filsPost(m) { if (filsReady && filsWin) filsWin.postMessage(m, location.origin); else filsQueue.push(m); }
// J144: remember the tab a file link was tapped in; when its viewer closes in Fils (✕ or a back-swipe),
// go back there (Strm, a thread, Proj…), scroll untouched. A folder link stays in Fils.
let filsFrom = "";
// J164: the tab switches when Fils says its viewer (or the folder) is up ({filsShow}), so the folder list
// never flashes first; a fallback switches anyway after 1.5 s (Fils still loading the first time).
let filsShowTimer = 0;
function openInFils(fp) {
  filsFrom = view !== "files" ? view : "";
  if (filsFrom) { filsFrame(); clearTimeout(filsShowTimer); filsShowTimer = setTimeout(() => setView("files"), 1500); }
  filsPost({ open: fp });
}
addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data?.filsShow) return;
  clearTimeout(filsShowTimer); if (view !== "files") setView("files");
});
addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data?.filsClosed) return;
  if (filsFrom && view === "files") setView(filsFrom);
  filsFrom = "";
});

// ---- an agent's session (J161, Angus: "if i click on the arrow to the right, open the agent … a box
// similar to what we have for Thgt. queue and interrupt are fine … just the last say 10 turns, and then
// we can scroll up to load"). The server reads only the tail of its session file (session-read.mjs).
// Turns: one input (his prompt, a talk, a brief) and everything the agent did after it; tool calls are
// one grey line each (tap: what it ran and what came back). Live: polled every 1.5 s while open; when
// he's scrolled up, new things show a "new below" pill instead of moving him. Send queues if it's
// working (it reads it after its turn); Interrupt (only while it works) stops the turn and the message
// becomes its next turn; Stop (header) stops the turn, like Esc.
const sessEl = $("#session"), sinput = $("#sinput"), ssend = $("#ssend"), sint = $("#sint");
const sess = { agent: null, items: [], before: 0, more: false, end: 0, loading: false, timer: null, results: new Map() };
const sessAgent = () => { for (const l of agentLists.values()) { const a = l.agents.find((x) => x.id === sess.agent); if (a) return a; } return null; };
const sessNearEnd = () => sessEl.scrollHeight - sessEl.scrollTop - sessEl.clientHeight < 80;
async function openSession(id) {
  sess.agent = id; sess.items = []; sess.results = new Map(); sess.before = 0; sess.more = false; sess.end = 0;
  splace.pinned = true; splace.el = null;
  loadSessDraft(id); // J194: this agent's own unsent draft (or an empty box)
  setView("session");
  sessEl.innerHTML = `<div class="small empty" style="text-align:center;margin-top:30vh">loading…</div>`;
  try {
    const r = await call("GET", `/api/session?agent=${encodeURIComponent(id)}`);
    if (sess.agent !== id) return;
    sess.items = r.items; sess.before = r.before; sess.more = r.more; sess.end = r.end;
    renderSession({ toEnd: true });
  } catch (e) { sessEl.innerHTML = `<div class="small empty" style="text-align:center;margin-top:30vh">✗ ${esc(e.message)}</div>`; }
  clearInterval(sess.timer); sess.timer = setInterval(pollSession, 1500);
}
async function pollSession() {
  if (view !== "session" || !sess.agent || document.hidden || sess.loading) return;
  const id = sess.agent;
  try {
    const r = await call("GET", `/api/session?agent=${encodeURIComponent(id)}&after=${sess.end}`);
    if (sess.agent !== id) return;
    renderSessionHead();
    if (!r.items.length) { sess.end = r.end; return; }
    sess.items.push(...r.items); sess.end = r.end;
    addSession(r.items, "end"); // J230: added in place (was: the whole page redrawn every poll, images and all)
    if (!splace.pinned && r.items.some((it) => it.k !== "result")) $("#snew").hidden = false; // he's reading further up: don't move him
  } catch { /* the next poll tries again */ }
}
async function loadOlder() {
  if (!sess.more || sess.loading) return;
  sess.loading = true;
  const id = sess.agent;
  try {
    const r = await call("GET", `/api/session?agent=${encodeURIComponent(id)}&before=${sess.before}`);
    if (sess.agent !== id) return;
    sess.items = r.items.concat(sess.items); sess.before = r.before; sess.more = r.more;
    // J230: put in front of what's there, and he stays on the same item at the same offset (was: the
    // scrollTop from before the fetch put back, which undid whatever he had scrolled meanwhile).
    if (!splace.pinned) sRemember();
    addSession(r.items, "start");
  } finally { sess.loading = false; }
}
sessEl.addEventListener("scroll", () => {
  if (Date.now() - sUser < 1200) { sUser = Date.now(); sRemember(); } // his scrolling, momentum included
  if (sessEl.scrollTop < 300) loadOlder();
  if (sessNearEnd()) { $("#snew") && ($("#snew").hidden = true); }
}, { passive: true });
// J230 (Angus: "the phone app seems jumpy"): the session page keeps his place like the Thgt thread does
// (hold()): at the end (it follows new turns), or an item and its offset. Anything that moves the
// layout without him (older turns added in front, images loading, a tool's result filled in) is
// followed by sHold(), which puts him back. Safari has no scroll anchoring of its own.
const splace = { pinned: true, el: null, off: 0, st: undefined };
let sUser = 0;
for (const t of ["touchstart", "touchmove", "wheel", "pointerdown", "keydown"]) sessEl.addEventListener(t, () => { sUser = Date.now(); }, { passive: true });
function sRemember() {
  splace.pinned = sessNearEnd(); if (splace.pinned) return;
  const tr = sessEl.getBoundingClientRect(), body = sessEl.querySelector(".sbody"); if (!body) return;
  // the first item that STARTS on screen (an item cut off at the top may still grow, an image in it loading)
  const kids = [...body.children], el = kids.find((e) => e.getBoundingClientRect().top >= tr.top) || kids.findLast((e) => e.getBoundingClientRect().top < tr.top);
  if (el) { splace.el = el; splace.off = el.getBoundingClientRect().top - tr.top; splace.st = sessEl.scrollTop; }
}
function sHold() {
  if (view !== "session") return;
  if (splace.pinned) { const to = sessEl.scrollHeight - sessEl.clientHeight; if (sessEl.scrollTop < to - 1) sessEl.scrollTop = to; return; }
  const el = splace.el; if (!el?.isConnected) return;
  const moved = splace.st === undefined ? 0 : sessEl.scrollTop - splace.st; // a scroll of his not yet reported
  const d = el.getBoundingClientRect().top - sessEl.getBoundingClientRect().top - (splace.off - moved);
  if (Math.abs(d) >= 1) { sessEl.scrollTop += d; if (splace.st !== undefined) splace.st += d; }
}
const sRO = new ResizeObserver(() => sHold());
// Every item is observed (an image loading in one item while another shrinks can leave the whole body's
// height unchanged), and every image load or failure puts him back too.
const sObserve = (nodes) => { for (const n of nodes) if (n.nodeType === 1) sRO.observe(n); };
sessEl.addEventListener("load", () => sHold(), true); sessEl.addEventListener("error", () => sHold(), true);
// New items into the drawn page: at the end (a poll) or in front (older turns). A result for a tool
// already on the page fills that tool in place (its output, an image it returned, err), keeping it
// open if he opened it.
function addSession(items, where) {
  const body = sessEl.querySelector(".sbody"); if (!body) return renderSession();
  for (const it of items) if (it.k === "result") sess.results.set(it.id, it);
  for (const it of items) {
    if (it.k !== "result") continue;
    const el = body.querySelector(`.stool[data-id="${CSS.escape(it.id)}"]`), tool = el && sess.items.find((x) => x.k === "tool" && x.id === it.id);
    if (!tool) continue;
    const n = nodesOf(sessItemHtml(tool))[0], open = !el.querySelector(".stx")?.hidden;
    el.classList.toggle("err", n.classList.contains("err"));
    const ni = n.querySelector(".simgs"); if (ni && !el.querySelector(".simgs")) el.querySelector(".stl").after(ni);
    const nx = n.querySelector(".stx"); nx.hidden = !open; el.querySelector(".stx").replaceWith(nx);
  }
  const html = items.filter((it) => it.k !== "result").map(sessItemHtml).join("");
  if (html) { const nodes = nodesOf(html); where === "start" ? body.prepend(...nodes) : body.append(...nodes); sObserve(nodes); }
  if (!sess.more) sessEl.querySelector(".solder")?.remove();
  renderSessionHead();
  sHold();
}
// A file it read: the cached thumbnail (opens in Fils). If the file isn't servable (in /tmp, outside the
// allowed folders, or deleted since: Pocket's review), the session's own copy of what it saw (the tool
// result's inline image), else a small label. An inline image: from the session.
// J221 (Angus: "the images could be bigger, maybe width of the phone when it's held in portrait, and
// then clicking on it could let you view the image in an image viewer"): images are the screen's width
// (never upscaled past their own size, capped on a desktop); a file's small cached thumbnail shows first
// (stretched to that width, class lo) and the full file replaces it once loaded. A tap opens the viewer.
const sessImgUrl = (im) => `/api/session/img?agent=${encodeURIComponent(sess.agent)}&at=${im.at}&i=${im.i}`;
// J230: with its pixel size known (the server reads it), an image has its final size before it loads (the
// screen's width, never past its own pixels, ≤ 75vh), so nothing moves when it arrives. Unknown: as before.
const sdim = (im) => im.w > 0 && im.h > 0 ? ` style="width:min(100%,${+im.w}px);aspect-ratio:${+im.w}/${+im.h}"` : "";
const sessThumb = (im, fallback) => im.file
  ? `<img class="sthumb lo"${sdim(im)} src="/api/thumb?path=${encodeURIComponent(im.file)}" data-file="${esc(im.file)}"${fallback ? ` data-fb="${esc(sessImgUrl(fallback))}"` : ""} alt="" onload="window.__sthumbLoad(this)" onerror="window.__sthumbFail(this)">`
  : `<img class="sthumb"${sdim(im)} loading="lazy" src="${esc(sessImgUrl(im))}" alt="" onerror="window.__sthumbFail(this)">`;
// J230: thumbnails load when drawn (they're small), so the page's heights settle at once rather than
// while he scrolls back; the full file replaces one only when it comes near the screen (same width).
const upObs = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { upObs.unobserve(e.target); e.target.src = "/file?path=" + encodeURIComponent(e.target.dataset.file); } }, { root: sessEl, rootMargin: "100% 0px" });
window.__sthumbLoad = (img) => {
  if (!img.dataset.file) { img.classList.remove("lo"); return; }
  if (!img.dataset.up) { img.dataset.up = "1"; upObs.observe(img); return; } // the thumbnail is up: the full file once it's near the screen (J230)
  img.classList.remove("lo");
};
// J249 (Angus: "yes to text instead of ?. That way I would know to ask you to move it to an allowed folder"):
// an image the phone can't load (outside the allowed folders, or missing) becomes a label naming the file.
function imgName(src) {
  try { const u = new URL(src, location.href), p = u.searchParams.get("path") || u.searchParams.get("name") || u.pathname; return decodeURIComponent(p.split("/").pop() || p) || "image"; } catch { return "image"; }
}
function imgGone(img, name) {
  const s = document.createElement("span"); s.className = "small sgone"; s.textContent = `🖼 image not available on the phone: ${name || imgName(img.getAttribute("src"))}`;
  s.title = img.dataset.file || img.getAttribute("src") || "";
  const a = img.parentElement?.tagName === "A" && img.parentElement.children.length === 1 ? img.parentElement : null;
  (a || img).replaceWith(s);
}
document.addEventListener("error", (e) => { const t = e.target; if (t?.tagName === "IMG" && t.matches("img.img, img.mdimg")) imgGone(t); }, true);
window.__sthumbFail = (img) => {
  if (img.dataset.up && img.dataset.file && !img.dataset.lofail) { img.dataset.lofail = "1"; img.src = "/api/thumb?path=" + encodeURIComponent(img.dataset.file); return; } // the full file failed: keep the thumbnail
  if (img.dataset.fb) { img.classList.remove("lo"); img.src = img.dataset.fb; delete img.dataset.fb; delete img.dataset.file; return; } // what it saw, from the session
  imgGone(img, img.dataset.file ? img.dataset.file.split("/").pop() : null);
};
function sessItemHtml(it) {
  if (it.k === "in") {
    const mine = it.mine || it.from === "Angus" || /^\[Angus, from his phone\]/.test(it.text); // J261: mine from the server; the rest for older servers
    const text = it.text.replace(/^\[Angus, from his phone\]\n/, "");
    if (mine) return `<div class="msg you">${esc(text)}${(it.imgs || []).map((im) => sessThumb(im)).join("")}</div>`;
    const first = text.split("\n").find((l) => l.trim()) || "";
    return `<details class="msg card sin"><summary>${it.reply ? "↩" : "✉"} <span class="who">${esc(it.from)}</span> · ${esc(first.replace(/^\[hyprpi [^\]]*\]\s*/, "").slice(0, 90))}</summary><div class="md">${md(text)}</div></details>`;
  }
  if (it.k === "text") return `<div class="msg thoughts"><div class="md">${md(it.text)}</div></div>`;
  if (it.k === "tool") {
    const r = sess.results.get(it.id);
    const imgs = it.file ? [{ file: it.file, w: it.fw || r?.imgs?.[0]?.w, h: it.fh || r?.imgs?.[0]?.h }] : ((r?.imgs) || []); // J230: a file gone from disk takes the size of the session's copy
    return `<div class="stool${r?.err ? " err" : ""}" data-id="${esc(it.id)}"><div class="stl">${esc("↳ " + it.line)}</div>${imgs.length ? `<div class="simgs">${imgs.map((im) => sessThumb(im, it.file ? r?.imgs?.[0] : null)).join("")}</div>` : ""}<div class="stx" hidden><pre>${esc(it.args)}</pre>${r ? `<pre class="sres">${esc(r.text || "(no output)")}</pre>` : ""}</div></div>`;
  }
  if (it.k === "note") return `<div class="msg small note${it.err ? " error" : ""}">${esc(it.text)}</div>`;
  return "";
}
function renderSessionHead() {
  const a = sessAgent(), h = $("#shead"); if (!h || !a) return;
  const status = { "●": "working", "◐": "background", "×": "needs you", "✓": "done", "○": "idle", "◌": a.status }[a.mark] || a.status;
  h.querySelector(".sst").textContent = `${a.mark} ${status}`;
  const working = a.mark === "●";
  sint.hidden = !working; sintLabel();
}
function renderSession({ toEnd = false } = {}) {
  const a = sessAgent() || { name: "agent", icon: "", mark: "○" };
  for (const it of sess.items) if (it.k === "result") sess.results.set(it.id, it);
  const projects = (a.projects || []).map((p) => `${esc(p.icon || "")} @${esc(p.name)}`).join(" ");
  const body = sess.items.filter((it) => it.k !== "result").map(sessItemHtml).join("");
  sessEl.innerHTML = `<div id="shead" class="phead"><div class="shrow"><button id="sback" type="button" aria-label="back to the agents" title="back to the agents">‹</button><span class="pic">${esc(a.icon || "")}</span><span class="pname">${agentName(a)}</span><span class="sst"></span></div><div class="ssub">${esc([a.model, a.thinking].filter(Boolean).join(" · "))}${projects ? " · " + projects : ""}</div></div>`
    + (sess.more ? `<div class="small solder" style="text-align:center;padding:8px">↑ older turns load as you scroll up</div>` : "")
    + `<div class="sbody">${body}</div><button id="snew" type="button" hidden>new below ↓</button>`;
  linkNames(sessEl.querySelector(".sbody")); textGlyphs(sessEl);
  renderSessionHead();
  sRO.disconnect(); sRO.observe(sessEl.querySelector(".sbody")); sObserve(sessEl.querySelector(".sbody").children); // J230: images loading, etc. → sHold()
  if (toEnd) splace.pinned = true;
  sHold();
}
sessEl.addEventListener("click", async (e) => {
  if (e.target.id === "snew") { splace.pinned = true; sHold(); e.target.hidden = true; return; }
  // J235 (Angus: "Why is there a big red stop button … I feel like we're about to go back to the agent list"):
  // ‹ at the top left goes back to the Agnt list. v2 ("I think the interrupt is enough"): no separate Stop;
  // the composer's button is Stop with an empty box (cancel, no new turn) and Interrupt with text.
  if (e.target.id === "sback") { openAgent.delete(world); return setView("agents"); }

  const th = e.target.closest(".sthumb");
  if (th) return openViewer(th.dataset.file ? "/file?path=" + encodeURIComponent(th.dataset.file) : th.getAttribute("src")); // J221: the viewer over the session (✕, a tap beside it, swipe down or back closes)
  if (e.target.closest("#shead")) { const id = sess.agent, a = sessAgent(); if (a) openAgent.set(world, id); return setView("agents"); } // the header: back to its summary
  const t = e.target.closest(".stool"); if (t && !e.target.closest("a")) { const x = t.querySelector(".stx"); x.hidden = !x.hidden; }
});
// J235 v2: the composer's red button: "Stop" with an empty box (stops its turn, nothing sent), "Interrupt"
// with text (stops its turn; the text is its next turn).
function sintLabel() { const empty = !sinput.value.trim(); sint.textContent = empty ? "Stop" : "Interrupt"; sint.title = empty ? "stop its turn (like Esc)" : "stop its turn; this message is its next turn"; }
async function sessStop() {
  if (!sess.agent) return;
  sint.disabled = true;
  try { await call("POST", "/api/agent/stop", { agent: sess.agent }); note("stopped"); setTimeout(() => note(""), 3000); }
  catch (err) { note("✗ not stopped: " + err.message); }
  finally { sint.disabled = false; }
}
async function sessSend(how) {
  const text = sinput.value.trim();
  if (!text && how === "interrupt") return sessStop();
  if (!text || !sess.agent) return;
  ssend.disabled = sint.disabled = true;
  try {
    // J163: a slash command runs as if typed in its window (after a running turn); Interrupt doesn't stop for it.
    const r = await call("POST", how === "interrupt" ? "/api/agent/interrupt" : "/api/agent/send", { agent: sess.agent, text });
    note(r.slash ? (r.queued ? `${text.split(/\s/)[0]}: runs when its turn ends` : `${text.split(/\s/)[0]}: sent as typed`)
      : how === "interrupt" ? "interrupted: your message is its next turn" : r.queued ? "queued: it reads this after its current turn" : "sent");
    sinput.value = ""; dropDraft(sdraftKey(sess.agent)); sinput.style.height = "auto"; sintLabel(); setTimeout(() => note(""), 3000);
    if (touch) sinput.blur();
  } catch (err) { note("✗ not sent: " + err.message); }
  finally { ssend.disabled = sint.disabled = false; }
}
ssend.addEventListener("click", () => sessSend("send"));
sint.addEventListener("click", () => sessSend("interrupt"));
sinput.addEventListener("input", sintLabel);
sinput.addEventListener("input", () => { sinput.style.height = "auto"; sinput.style.height = Math.min(sinput.scrollHeight + 2, innerHeight * 0.4) + "px"; });
chatKeys(sinput, () => sessSend("send"));
// J194: one draft per agent's session page (pi·wpzt: a shared key could send X's draft to Y).
const sdraftKey = (id) => "hyprpi-rc.sdraft." + String(id || "");
const sgrow = () => { sinput.style.height = "auto"; sinput.style.height = Math.min(sinput.scrollHeight + 2, innerHeight * 0.4) + "px"; };
sinput.addEventListener("input", () => { if (!sess.agent) return; try { if (sinput.value) localStorage.setItem(sdraftKey(sess.agent), sinput.value); else localStorage.removeItem(sdraftKey(sess.agent)); } catch { /* full */ } });
function loadSessDraft(id) { let t = ""; try { t = localStorage.getItem(sdraftKey(id)) || ""; } catch { /* none */ } sinput.value = t; sgrow(); sintLabel(); }
sinput.addEventListener("touchend", (e) => { if (document.activeElement === sinput) return; e.preventDefault(); sinput.focus({ preventScroll: true }); }, { passive: false });
sinput.addEventListener("focus", () => { fitViewport(); requestAnimationFrame(fitViewport); });

window.__rc = { openSession, sess, cached, setWorld, boardOf, setView, agentsOf, jumpTo, linkNames, textGlyphs, streamOf, streamOnly, chatKeys }; // for tests (CDP)
// A reload (the URL keeps ?world=): show that world's cached thread before the server answers.
let stateSeen = false;
{ const w0 = new URLSearchParams(location.search).get("world"); if (/^[A-Z]$/.test(w0 || "")) { world = w0; render({ keep: "end" }); } }
call("GET", "/api/state").then(applyState).catch((e) => note("✗ " + e.message));
listen();
