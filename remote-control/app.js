// hyprpi remote control: the page. A chat with one world's Thoughts agent; world chips switch it.
// Thread entries (lib/thoughts.mjs): { role: you | thoughts | action | reply | agent | note | evidence, text, from?, ts }
import { threadKind, answerLine, actionPrefix, splitLead, phoneHidden } from "/lib/thoughts-lines.mjs";
import { agentIn } from "/lib/tui/agent-click.mjs"; // the desktop panels' Ctrl+click matcher, shared as-is (J45)
import { esc, href, link, inline, md } from "/md.mjs";
import { install as installFileViewer } from "/fileview.mjs";
// J141: a tapped file LINK (/file?path=…) anywhere in π opens in the Fils tab, in its folder, with
// the viewer on top; this runs before the J70 overlay's own handler. Thumbnails (J63) and [[wiki]]
// links still open in the overlay, over the tab they're in.
addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
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
  if (!r.ok) throw new Error(j.error || r.statusText);
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
  if (el) { p.k = el.dataset.k; p.off = el.getBoundingClientRect().top - tr.top; }
}
thread.addEventListener("scroll", () => { if (Date.now() - lastUser < 1200) { lastUser = Date.now(); remember(); } }, { passive: true }); // his scrolling, momentum included
function hold() {
  if (view !== "thoughts" || !world) return;
  const p = placeOf(world), box = shownBox(); if (!box) return;
  if (p.pinned) { const to = thread.scrollHeight - thread.clientHeight; if (Math.abs(thread.scrollTop - to) > 1) thread.scrollTop = to; return; }
  const el = p.k && box.querySelector(`[data-k="${CSS.escape(p.k)}"]`);
  if (!el) return;
  const d = el.getBoundingClientRect().top - thread.getBoundingClientRect().top - p.off;
  if (Math.abs(d) >= 1) thread.scrollTop += d;
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
  if (filsWin) filsPost({ world: w });
  renderTop(); // at once, from the cache; only the view on screen (the others draw when shown)
  newestBtn.hidden = true;
  if (view === "thoughts") render(); else if (view === "projects") renderProjects(); else if (view === "agents") renderAgents(); else renderStream({ restore: true });
  fetchWorld(w).catch((e) => note("✗ " + e.message)); // then fresh, in the background
  fetchBoard(w).catch(() => {}); fetchAgents(w).catch(() => {}); fetchStream(w).catch(() => {});
}
function applyState(s) {
  worlds = s.worlds || []; online = !!s.online;
  if (s.directory) { const sig = JSON.stringify(s.directory); if (sig !== dirSig) { dirSig = sig; dirVer++; setDirectory(s.directory); if (world) rerenderAll(); } }
  if (s.theme) { for (const [k, v] of Object.entries(s.theme)) document.documentElement.style.setProperty("--" + k, v); document.querySelector("meta[name=theme-color]").content = s.theme.bg; }
  const first = !stateSeen; stateSeen = true;
  if (!world) setWorld(new URLSearchParams(location.search).get("world") || s.active);
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
    if (!el.value.trim()) return; // nothing to send
    send();
    if (touch) el.blur(); // the keyboard closes
  });
}
let sending = false;
async function sendMessage() {
  const text = input.value.trim(); if (!text || !world || sending) return;
  sending = true; sendBtn.disabled = true;
  try { await call("POST", "/api/send", { world, text }); input.value = ""; grow(); busy = true; renderTop(); note(""); toEnd(); }
  catch (err) { note("✗ not sent: " + err.message); }
  finally { sending = false; sendBtn.disabled = false; }
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
    const decide = p.decide.map((it) => `<li><span class="h">${esc(it.h)}</span> <div class="md">${md(it.text)}${by(it)}</div>${(it.options || []).length ? `<ol class="opts">${it.options.map((o) => `<li><b>${esc(o.key)})</b> ${inline(o.text)}${o.key === it.default ? ` <span class="small">(default)</span>` : ""}${o.key === it.recommend ? ` <span class="rec">★ recommended</span>` : ""}</li>`).join("")}</ol>` : ""}</li>`).join("");
    html.push(`<div class="psum">` // no back button (J41 v2): the title, or Proj in the top bar, goes back to the list
      // The header (J48): icon, name, badge, title and owner/members as ONE tap target, the full width,
      // that goes back to the list. Names in it are not links (the J45 pass skips .phead): the
      // name used to be a link to this same project, which took the tap and re-opened it.
      + `<div class="phead ptoggle" title="back to the projects"><h2><span class="pic">${esc(p.icon)}</span><span>@${esc(p.name)} ${badge(p.status)}</span></h2>`
      + `${p.title ? `<div class="ptitle">${esc(p.title)}</div>` : ""}`
      + (p.writer || p.members?.length ? `<div class="ppeople">${p.writer ? `owner ${esc(p.writer)}` : ""}${(p.members || []).filter((m) => m !== p.writer).length ? `${p.writer ? " · " : ""}members ${(p.members || []).filter((m) => m !== p.writer).map(esc).join(", ")}` : ""}</div>` : "")
      + `</div>`
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
  sessEl.hidden = v !== "session"; $("#scomp").hidden = v !== "session"; if (v !== "session") sess.agent = null; // J161
  renderTop();
  if (v === "projects") { renderProjects(); fetchBoard(world).catch(() => {}); }
  else if (v === "agents") { renderAgents(); fetchAgents(world).catch(() => {}); }
  else if (v === "stream") { renderStream({ restore: true }); fetchStream(world).catch(() => {}); }
  else render({ keep: "restore" });
}
projectsEl.addEventListener("click", (e) => {
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
  return `<button class="${cls}${a.mark === "◌" ? " gone" : ""}" data-a="${esc(a.id)}"><span class="amark m${a.mark === "●" ? "w" : a.mark === "◐" ? "b" : a.mark === "×" ? "x" : a.mark === "✓" ? "d" : "i"}">${esc(a.mark)}</span><span class="pic">${esc(a.icon || "")}</span><span class="pmain"><span class="pname">${agentName(a)}</span><span class="pwhere">${meta}</span></span>${cls === "agent" ? `<span class="chev aopen" title="open its session">›</span>` : ""}</button>`;
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
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => namesRe.test(n.data) && !n.parentElement?.closest("a, code, pre, .nl, .tx, .phead, button, textarea") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
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
    const el = restore && st.anchor && streamEl.querySelector(`.ev[data-k="${CSS.escape(st.anchor.k)}"]`);
    if (el) streamEl.scrollTop += el.getBoundingClientRect().top - streamEl.getBoundingClientRect().top - st.anchor.off;
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
    const atEnd = sessNearEnd();
    sess.items.push(...r.items); sess.end = r.end;
    renderSession({ toEnd: atEnd });
    if (!atEnd) $("#snew").hidden = false; // he's reading further up: don't move him
  } catch { /* the next poll tries again */ }
}
async function loadOlder() {
  if (!sess.more || sess.loading) return;
  sess.loading = true;
  const id = sess.agent, h0 = sessEl.scrollHeight, t0 = sessEl.scrollTop;
  try {
    const r = await call("GET", `/api/session?agent=${encodeURIComponent(id)}&before=${sess.before}`);
    if (sess.agent !== id) return;
    sess.items = r.items.concat(sess.items); sess.before = r.before; sess.more = r.more;
    renderSession();
    sessEl.scrollTop = t0 + (sessEl.scrollHeight - h0); // keep his place
  } finally { sess.loading = false; }
}
sessEl.addEventListener("scroll", () => { if (sessEl.scrollTop < 300) loadOlder(); if (sessNearEnd()) $("#snew") && ($("#snew").hidden = true); }, { passive: true });
// A file it read: the cached thumbnail (opens in Fils). If the file isn't servable (in /tmp, outside the
// allowed folders, or deleted since: Pocket's review), the session's own copy of what it saw (the tool
// result's inline image), else a small label. An inline image: from the session.
const sessImgUrl = (im) => `/api/session/img?agent=${encodeURIComponent(sess.agent)}&at=${im.at}&i=${im.i}`;
const sessThumb = (im, fallback) => im.file
  ? `<img class="sthumb" loading="lazy" src="/api/thumb?path=${encodeURIComponent(im.file)}" data-file="${esc(im.file)}"${fallback ? ` data-fb="${esc(sessImgUrl(fallback))}"` : ""} alt="" onerror="window.__sthumbFail(this)">`
  : `<img class="sthumb" loading="lazy" src="${esc(sessImgUrl(im))}" alt="" onerror="window.__sthumbFail(this)">`;
window.__sthumbFail = (img) => {
  if (img.dataset.fb) { img.src = img.dataset.fb; delete img.dataset.fb; delete img.dataset.file; return; } // what it saw, from the session; tap enlarges it in place
  const s = document.createElement("span"); s.className = "small sgone"; s.textContent = "image no longer on disk"; img.replaceWith(s);
};
function sessItemHtml(it) {
  if (it.k === "in") {
    const mine = it.from === "Angus" || /^\[Angus, from his phone\]/.test(it.text);
    const text = it.text.replace(/^\[Angus, from his phone\]\n/, "");
    if (mine) return `<div class="msg you">${esc(text)}${(it.imgs || []).map((im) => sessThumb(im)).join("")}</div>`;
    const first = text.split("\n").find((l) => l.trim()) || "";
    return `<details class="msg card sin"><summary>${it.reply ? "↩" : "✉"} <span class="who">${esc(it.from)}</span> · ${esc(first.replace(/^\[hyprpi [^\]]*\]\s*/, "").slice(0, 90))}</summary><div class="md">${md(text)}</div></details>`;
  }
  if (it.k === "text") return `<div class="msg thoughts"><div class="md">${md(it.text)}</div></div>`;
  if (it.k === "tool") {
    const r = sess.results.get(it.id);
    const imgs = it.file ? [{ file: it.file }] : ((r?.imgs) || []);
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
  $("#sstop").hidden = !working; sint.hidden = !working;
}
function renderSession({ toEnd = false } = {}) {
  const a = sessAgent() || { name: "agent", icon: "", mark: "○" };
  for (const it of sess.items) if (it.k === "result") sess.results.set(it.id, it);
  const projects = (a.projects || []).map((p) => `${esc(p.icon || "")} @${esc(p.name)}`).join(" ");
  const body = sess.items.filter((it) => it.k !== "result").map(sessItemHtml).join("");
  sessEl.innerHTML = `<div id="shead" class="phead"><div class="shrow"><span class="pic">${esc(a.icon || "")}</span><span class="pname">${agentName(a)}</span><span class="sst"></span><button id="sstop" type="button" hidden title="stop its turn (like Esc)">Stop</button></div><div class="ssub">${esc([a.model, a.thinking].filter(Boolean).join(" · "))}${projects ? " · " + projects : ""}</div></div>`
    + (sess.more ? `<div class="small" style="text-align:center;padding:8px">↑ older turns load as you scroll up</div>` : "")
    + `<div class="sbody">${body}</div><button id="snew" type="button" hidden>new below ↓</button>`;
  linkNames(sessEl.querySelector(".sbody")); textGlyphs(sessEl);
  renderSessionHead();
  if (toEnd) { sessEl.scrollTop = sessEl.scrollHeight; requestAnimationFrame(() => { sessEl.scrollTop = sessEl.scrollHeight; }); }
}
sessEl.addEventListener("click", async (e) => {
  if (e.target.id === "snew") { sessEl.scrollTop = sessEl.scrollHeight; e.target.hidden = true; return; }
  if (e.target.id === "sstop") { try { await call("POST", "/api/agent/stop", { agent: sess.agent }); note("stopped"); } catch (err) { note("✗ " + err.message); } return; }
  const th = e.target.closest(".sthumb");
  if (th) { if (th.dataset.file) return openInFils(th.dataset.file); th.classList.toggle("big"); return; } // a file: in Fils; an inline image: bigger in place
  if (e.target.closest("#shead")) { const id = sess.agent, a = sessAgent(); if (a) openAgent.set(world, id); return setView("agents"); } // the header: back to its summary
  const t = e.target.closest(".stool"); if (t && !e.target.closest("a")) { const x = t.querySelector(".stx"); x.hidden = !x.hidden; }
});
async function sessSend(how) {
  const text = sinput.value.trim(); if (!text || !sess.agent) return;
  ssend.disabled = sint.disabled = true;
  try {
    // J163: a slash command runs as if typed in its window (after a running turn); Interrupt doesn't stop for it.
    const r = await call("POST", how === "interrupt" ? "/api/agent/interrupt" : "/api/agent/send", { agent: sess.agent, text });
    note(r.slash ? (r.queued ? `${text.split(/\s/)[0]}: runs when its turn ends` : `${text.split(/\s/)[0]}: sent as typed`)
      : how === "interrupt" ? "interrupted: your message is its next turn" : r.queued ? "queued: it reads this after its current turn" : "sent");
    sinput.value = ""; sinput.style.height = "auto"; setTimeout(() => note(""), 3000);
    if (touch) sinput.blur();
  } catch (err) { note("✗ not sent: " + err.message); }
  finally { ssend.disabled = sint.disabled = false; }
}
ssend.addEventListener("click", () => sessSend("send"));
sint.addEventListener("click", () => sessSend("interrupt"));
sinput.addEventListener("input", () => { sinput.style.height = "auto"; sinput.style.height = Math.min(sinput.scrollHeight + 2, innerHeight * 0.4) + "px"; });
chatKeys(sinput, () => sessSend("send"));
sinput.addEventListener("touchend", (e) => { if (document.activeElement === sinput) return; e.preventDefault(); sinput.focus({ preventScroll: true }); }, { passive: false });
sinput.addEventListener("focus", () => { fitViewport(); requestAnimationFrame(fitViewport); });

window.__rc = { openSession, sess, cached, setWorld, boardOf, setView, agentsOf, jumpTo, linkNames, textGlyphs, streamOf, streamOnly, chatKeys }; // for tests (CDP)
// A reload (the URL keeps ?world=): show that world's cached thread before the server answers.
let stateSeen = false;
{ const w0 = new URLSearchParams(location.search).get("world"); if (/^[A-Z]$/.test(w0 || "")) { world = w0; render({ keep: "end" }); } }
call("GET", "/api/state").then(applyState).catch((e) => note("✗ " + e.message));
listen();
