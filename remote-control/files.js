// The Files app (J74): a second Home Screen app on the remote-control server. Browse the laptop's
// allowed folders (the server lists them with the J47 rules), open a file in the J70 viewer, select
// several and Share them (the iOS share sheet: Messages, Mail/Gmail, WhatsApp, Save to Files/Photos),
// upload phone files into ~/Phone (the only place it can write), and send files with a short note to
// a world's Thoughts (📱). iOS doesn't let web apps appear in the Share sheet, so sends start here.
import { install as installViewer, open as openViewer } from "/fileview.mjs";
// J141: the same app inside the π app's "Fils" tab (/files/?embed=1, an iframe). Only then: "Send…"
// to Thoughts or any live agent, the world from π's top bar, and π can ask it to open a file. The
// standalone Files app (no ?embed) is unchanged.
const EMBED = new URLSearchParams(location.search).has("embed");
if (EMBED) document.body.classList.add("embed");

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const HOME = "/home/agf";
const IMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic)$/i;
const SHARE_MAX = 100e6; // more than this in one Share: links instead of the files
const fileHref = (p) => "/file?path=" + encodeURIComponent(p);
const tilde = (p) => String(p || "").replace(HOME, "~");

let cur = { path: "", parent: null, entries: [] }, sort = localStorage.getItem("files.sort") || "date", q = "";
let selecting = false;
// J142: the "everywhere" results under the folder's own (a name search across all the allowed roots, on the
// laptop). { q, loading, items, total, truncated, ms, error }
let ev = { q: "", loading: false, items: [], total: 0 }, evTimer = null, evSeq = 0;
const sel = new Map(); // path -> { entry, blob|null, loading: Promise }
let token = null, caps = null, phoneDir = HOME + "/Phone", worlds = [], lastWorld = localStorage.getItem("files.world") || "", agents = [];
if (EMBED) { const w = new URLSearchParams(location.search).get("world"); if (/^[A-Z]$/.test(w || "")) lastWorld = w; }

function note(t, ms = 3000) { const n = $("#fnote"); n.textContent = t; n.hidden = !t; if (t) setTimeout(() => { if (n.textContent === t) n.hidden = true; }, ms); }
async function getJSON(u) { const r = await fetch(u, { cache: "no-store" }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; }
async function tokenNow() { if (!token) { const t = await getJSON("/api/files/token"); token = t.token; caps = t.caps; phoneDir = t.phone || phoneDir; } return token; }

// Theme and worlds, as the main app (colours follow the desktop).
getJSON("/api/state").then((s) => {
  for (const [k, v] of Object.entries(s.theme || {})) document.documentElement.style.setProperty("--" + k, v);
  if (s.theme?.bg) document.querySelector("meta[name=theme-color]").content = s.theme.bg;
  worlds = (s.worlds || []).filter((w) => w.shown !== false);
  agents = (s.directory?.agents || []).filter((a) => a.kind === "agent" && a.live);
  if (!lastWorld) lastWorld = s.active || worlds[0]?.id || "A";
}).catch(() => {});

// ---- the list ---------------------------------------------------------------------------------
const size = (n) => n < 1e3 ? n + " B" : n < 1e6 ? (n / 1e3).toFixed(0) + " KB" : n < 1e9 ? (n / 1e6).toFixed(1) + " MB" : (n / 1e9).toFixed(2) + " GB";
const when = (ms) => { const d = new Date(ms), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }); };
const icon = (e) => e.dir ? "📁" : /\.pdf$/i.test(e.name) ? "📕" : /\.(md|markdown|txt)$/i.test(e.name) ? "📝" : /\.(mov|mp4|m4v|webm)$/i.test(e.name) ? "🎞️" : /\.(mp3|m4a|wav|flac|ogg)$/i.test(e.name) ? "🎵" : /\.(zip|tar|gz|7z)$/i.test(e.name) ? "🗜️" : "📄";

function render() {
  const el = $("#flist");
  document.body.classList.toggle("selecting", selecting);
  $("#fup").hidden = cur.parent === null;
  $("#fname").textContent = cur.path ? cur.path.split("/").pop() : "Files";
  $("#fdir").textContent = cur.path ? "\u200e" + tilde(cur.path.replace(/\/[^/]*$/, "")) : "the laptop's allowed folders";
  $("#fsort").textContent = sort === "date" ? "Date ↓" : "Name ↑";
  let list = cur.entries.slice();
  const k = q.trim().toLowerCase();
  if (k) list = list.filter((e) => e.name.toLowerCase().includes(k));
  if (cur.path) list.sort((a, b) => (b.dir - a.dir) || (sort === "date" ? b.mtime - a.mtime : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
  el.innerHTML = list.length ? list.map((e) => `<div class="fe${e.dir ? " dir" : ""}${sel.has(e.path) ? " on" : ""}" data-p="${esc(e.path)}">
    <div class="ic">${!e.dir && IMG.test(e.name) && !/\.heic$/i.test(e.name) ? `<img loading="lazy" decoding="async" alt="" src="${esc(fileHref(e.path))}">` : icon(e)}</div>
    <div class="nm"><div class="n1">${esc(e.name)}</div><div class="n2">${e.dir ? (cur.path ? "folder" : tilde(e.path)) : `${size(e.size)} · ${when(e.mtime)}`}${!cur.path && e.name === "Phone" ? " · uploads land here" : ""}</div></div>
    <div class="ck"></div></div>`).join("") + (cur.truncated ? `<div class="fempty">(the first 5000 shown)</div>` : "")
    : k ? (cur.path ? `<div class="fempty fevw">Nothing in this folder matches.</div>` : "") : `<div class="fempty">This folder is empty.</div>`;
  if (k.length >= 2) el.insertAdjacentHTML("beforeend", everywhereHtml(k));
  $("#fcount").textContent = `${sel.size} selected`;
  $("#fnormal").hidden = selecting; $("#fselbar").hidden = !selecting;
}
function rowHtml(e, sub) {
  return `<div class="fe${e.dir ? " dir" : ""}${sel.has(e.path) ? " on" : ""}" data-p="${esc(e.path)}"${sub ? ' data-ev="1"' : ""}>
    <div class="ic">${!e.dir && IMG.test(e.name) && !/\.heic$/i.test(e.name) ? `<img loading="lazy" decoding="async" alt="" src="${esc(fileHref(e.path))}">` : icon(e)}</div>
    <div class="nm"><div class="n1">${esc(e.name)}</div><div class="n2">${sub}</div></div>
    <div class="ck"></div></div>`;
}
function everywhereHtml(k) {
  const head = `<div class="fevh">Everywhere${ev.q === k && !ev.loading ? ` · ${ev.total > ev.items.length ? `the first ${ev.items.length} of ${ev.truncated ? "many" : ev.total}` : ev.items.length}` : ""}</div>`;
  if (ev.q !== k || ev.loading) return head + `<div class="fempty fevw">searching all folders…</div>`;
  if (ev.error) return head + `<div class="fempty fevw">✗ ${esc(ev.error)}</div>`;
  if (!ev.items.length) return head + `<div class="fempty fevw">No names match anywhere.</div>`;
  return head + ev.items.map((e) => rowHtml(e, `${esc(tilde(e.path.replace(/\/[^/]*$/, "")))}${e.dir ? "" : ` · ${size(e.size)} · ${when(e.mtime)}`}`)).join("");
}
function searchEverywhere(k) {
  clearTimeout(evTimer);
  if (k.length < 2) { ev = { q: "", loading: false, items: [], total: 0 }; return; }
  if (ev.q === k && !ev.error) return;
  ev = { q: k, loading: true, items: [], total: 0 };
  const my = ++evSeq;
  evTimer = setTimeout(async () => {
    try { const r = await getJSON("/api/find?q=" + encodeURIComponent(k)); if (my !== evSeq) return; ev = { q: k, loading: false, items: r.results || [], total: r.total || 0, truncated: !!r.truncated, ms: r.ms }; }
    catch (e) { if (my !== evSeq) return; ev = { q: k, loading: false, items: [], total: 0, error: e.message }; }
    if (q.trim().toLowerCase() === k) render();
  }, 250);
}
async function go(p, { push = true } = {}) {
  try {
    const l = await getJSON("/api/ls?path=" + encodeURIComponent(p));
    cur = l; q = ""; $("#fq").value = "";
    if (push) history.pushState({ dir: l.path }, "");
    else history.replaceState({ ...(history.state || {}), dir: l.path }, "");
    render(); $("#flist").scrollTop = 0;
    localStorage.setItem("files.dir", l.path);
  } catch (e) { note("✗ " + e.message); if (!push && p) go("", { push: false }); } // a folder that is gone (or no longer allowed): the roots
}
addEventListener("popstate", (e) => { if (e.state?.fv) return; const d = e.state?.dir ?? ""; if (d !== cur.path) go(d, { push: false }); });

// Prefetch a selected file, so Share has it at the tap (iOS needs the share inside the gesture).
function select(e, on) {
  if (!on) { sel.delete(e.path); return; }
  const s = { entry: e, blob: null };
  s.loading = e.size <= SHARE_MAX ? fetch(fileHref(e.path)).then((r) => r.ok ? r.blob() : null).then((b) => { s.blob = b; }).catch(() => {}) : Promise.resolve();
  sel.set(e.path, s);
}
$("#flist").addEventListener("click", (ev) => {
  const row = ev.target.closest(".fe"); if (!row) return;
  if (row.dataset.ev) { // J142: an "everywhere" result: a folder opens, a file opens in its folder's viewer
    const hit = everywhereHit(row.dataset.p); if (!hit) return;
    if (hit.dir) return go(hit.path);
    go(hit.path.replace(/\/[^/]*$/, "")).then(() => openViewer(fileHref(hit.path)));
    return;
  }
  const e = cur.entries.find((x) => x.path === row.dataset.p); if (!e) return;
  if (e.dir) return go(e.path);
  if (selecting) { select(e, !sel.has(e.path)); render(); return; }
  openViewer(fileHref(e.path));
});
$("#fup").addEventListener("click", () => go(cur.parent ?? ""));
$("#fq").addEventListener("input", (e) => { q = e.target.value; searchEverywhere(q.trim().toLowerCase()); render(); });
function everywhereHit(p) { return ev.items.find((x) => x.path === p); }
$("#fsort").addEventListener("click", () => { sort = sort === "date" ? "name" : "date"; localStorage.setItem("files.sort", sort); render(); });
$("#fsel").addEventListener("click", () => { selecting = !selecting; if (!selecting) sel.clear(); $("#fsel").textContent = selecting ? "Done" : "Select"; render(); });
$("#fcancel").addEventListener("click", () => { selecting = false; sel.clear(); $("#fsel").textContent = "Select"; render(); });

// ---- Share (several files) ---------------------------------------------------------------------
$("#fshare").addEventListener("click", async () => {
  const items = [...sel.values()]; if (!items.length) return note("Select some files first");
  const total = items.reduce((n, s) => n + s.entry.size, 0);
  const ready = items.every((s) => s.blob);
  try {
    if (!navigator.share) throw Object.assign(new Error("no share sheet here"), { name: "NoShare" });
    if (ready && total <= SHARE_MAX) {
      const files = items.map((s) => new File([s.blob], s.entry.name, { type: s.blob.type || "application/octet-stream" }));
      if (navigator.canShare?.({ files })) { await navigator.share({ files }); return; }
    } else if (!ready && total <= SHARE_MAX) { note("Still loading the files… tap Share again in a moment"); return; }
    // too big (or the phone won't take these files): their links, one per line
    await navigator.share({ text: items.map((s) => location.origin + fileHref(s.entry.path)).join("\n"), title: `${items.length} files` });
  } catch (e) {
    if (e.name === "AbortError") return;
    if (e.name === "NoShare") { for (const s of items) { const a = document.createElement("a"); a.href = fileHref(s.entry.path); a.download = s.entry.name; a.click(); } return; }
    note(e.name === "NotAllowedError" ? "Tap Share again" : "✗ " + e.message);
  }
});

// ---- sheets ------------------------------------------------------------------------------------
function sheet(html) { const s = $("#fsheet"); s.querySelector(".fpanel").innerHTML = html; s.hidden = !html; return s.querySelector(".fpanel"); }
$("#fsheet").addEventListener("click", (e) => { if (e.target.id === "fsheet" && !$("#fsheet").dataset.busy) sheet(""); });
$("#fhelp").addEventListener("click", () => {
  const p = sheet(`<h3>Files</h3>
    <p>The laptop's allowed folders (Obsidian, Work, Downloads, Documents, Screenshots, Phone). Hidden files and anything named like a key or password are never shown.</p>
    <p><b>Search</b> filters this folder at once, and below it lists matching <b>names everywhere</b> in the allowed folders (folders first; tap one to go there, a file to open it). Contents aren't searched, and files a project's .gitignore leaves out (build output, caches) aren't listed.</p>
    <p><b>Tap</b> a file to open it; <b>Share</b> sends it with the iPhone's share panel (Messages, Mail, Gmail, WhatsApp, Save Image, Save to Files). <b>Select</b> picks several.</p>
    <p><b>⬆ Upload</b> sends photos or files from the phone into <b>~/Phone</b> on the laptop (the only folder this app can write to; nothing is ever overwritten or deleted)${caps ? `, up to ${caps.fileMB} MB a file and ${caps.batchMB} MB at once` : ""}. Afterwards you can send them to Thoughts with a note.</p>
    <p><b>→ Thoughts</b> sends the selected files with a short note to a world's Thoughts, so an agent can act on them.</p>
    <p>iOS doesn't let web apps appear in the Share sheet, so you can't send to this app from Photos: open Files and use Upload.</p>
    <div class="fact"><button type="button" class="fclose">OK</button></div>`);
  p.querySelector(".fclose").onclick = () => sheet("");
  tokenNow().catch(() => {});
});

// ---- → Thoughts -------------------------------------------------------------------------------
// J141 (embed): "Send…": Thoughts of a world, or any live agent (grouped by world, this one first).
function sendSheet(paths) {
  const byWorld = new Map();
  for (const a of agents) (byWorld.get(a.room) || byWorld.set(a.room, []).get(a.room)).push(a);
  const order = [...byWorld.keys()].sort((x, y) => (x === lastWorld ? -1 : y === lastWorld ? 1 : x.localeCompare(y)));
  const p = sheet(`<h3>Send ${paths.length === 1 ? "this file" : paths.length + " files"} to…</h3>
    <div class="fto"><button type="button" class="fto1 on" data-to="thoughts">💭 Thoughts-<span class="tw">${esc(lastWorld)}</span></button>
    ${order.map((w) => `<div class="ftow">${esc(w)}</div>` + byWorld.get(w).map((a) => `<button type="button" class="fto1" data-to="${esc(a.id)}" style="color:${esc(a.color || "")}">${esc((a.icon ? a.icon + " " : "") + a.display)}</button>`).join("")).join("")}</div>
    <textarea id="ftnote" placeholder="a note (what to do with ${paths.length === 1 ? "it" : "them"})"></textarea>
    <div class="ffiles">${paths.map((x) => "📎 " + esc(tilde(x))).join("<br>")}</div>
    <div class="fact"><button type="button" class="fclose">Cancel</button><button type="button" class="fgo">Send 📱</button></div>`);
  let to = "thoughts";
  p.querySelector(".fto").onclick = (e) => { const b = e.target.closest(".fto1"); if (!b) return; to = b.dataset.to; p.querySelectorAll(".fto1").forEach((x) => x.classList.toggle("on", x === b)); };
  p.querySelector(".fclose").onclick = () => sheet("");
  p.querySelector(".fgo").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const t = await tokenNow(), noteText = p.querySelector("#ftnote").value;
      const [url, payload] = to === "thoughts" ? ["/api/files/thoughts", { world: lastWorld, note: noteText, paths }] : ["/api/files/agent", { agent: to, note: noteText, paths }];
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-upload-token": t }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText);
      sheet(""); note(`Sent to ${to === "thoughts" ? "Thoughts-" + lastWorld : j.name || "the agent"} ✓`);
      if (selecting) $("#fcancel").click();
    } catch (err) { e.target.disabled = false; note("✗ " + err.message); }
  };
}
function thoughtsSheet(paths) {
  if (EMBED) return sendSheet(paths);
  const p = sheet(`<h3>→ Thoughts</h3>
    <div class="fworlds">${(worlds.length ? worlds : [{ id: lastWorld || "A" }]).map((w) => `<button type="button" data-w="${esc(w.id)}" style="--w:${esc(w.color || "")}" class="${w.id === lastWorld ? "on" : ""}">${esc(w.id)}</button>`).join("")}</div>
    <textarea id="ftnote" placeholder="a note for Thoughts (what to do with ${paths.length === 1 ? "it" : "them"})"></textarea>
    <div class="ffiles">${paths.map((x) => "📎 " + esc(tilde(x))).join("<br>")}</div>
    <div class="fact"><button type="button" class="fclose">Cancel</button><button type="button" class="fgo">Send 📱</button></div>`);
  p.querySelector(".fworlds").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; lastWorld = b.dataset.w; p.querySelectorAll(".fworlds button").forEach((x) => x.classList.toggle("on", x === b)); };
  p.querySelector(".fclose").onclick = () => sheet("");
  p.querySelector(".fgo").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const t = await tokenNow();
      const r = await fetch("/api/files/thoughts", { method: "POST", headers: { "content-type": "application/json", "x-upload-token": t }, body: JSON.stringify({ world: lastWorld, note: p.querySelector("#ftnote").value, paths }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText);
      localStorage.setItem("files.world", lastWorld);
      sheet(""); note(`Sent to Thoughts-${lastWorld} ✓`);
      if (selecting) $("#fcancel").click();
    } catch (err) { e.target.disabled = false; note("✗ " + err.message); }
  };
}
$("#fthink").addEventListener("click", () => { if (!sel.size) return note("Select some files first"); thoughtsSheet([...sel.keys()]); });

// ---- Upload (into ~/Phone) ---------------------------------------------------------------------
function put(file, batch, t, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/upload");
    x.setRequestHeader("x-upload-token", t);
    x.setRequestHeader("x-file-name", encodeURIComponent(file.name || "upload"));
    x.setRequestHeader("x-batch", batch);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { /* none */ } x.status === 200 ? resolve(j) : reject(new Error(j.error || x.statusText || "failed")); };
    x.onerror = () => reject(new Error("network error"));
    x.send(file);
  });
}
$("#ffile").addEventListener("change", async (ev) => {
  const files = [...ev.target.files]; ev.target.value = "";
  if (!files.length) return;
  let t; try { t = await tokenNow(); } catch (e) { return note("✗ " + e.message); }
  const total = files.reduce((n, f) => n + f.size, 0);
  const batch = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now());
  $("#fsheet").dataset.busy = "1";
  const p = sheet(`<h3>Uploading ${files.length} to ~/Phone</h3><div class="fprog"><div></div></div>${files.map((f, i) => `<div class="fup1" id="fu${i}"><span>${esc(f.name)}</span><span class="s">${size(f.size)}</span></div>`).join("")}<div class="fact"></div>`);
  const bar = p.querySelector(".fprog > div");
  let done = 0; const ok = [];
  for (const [i, f] of files.entries()) {
    const row = p.querySelector("#fu" + i);
    if (caps && f.size > caps.fileMB * 1e6) { row.classList.add("err"); row.querySelector(".s").textContent = `over ${caps.fileMB} MB`; done += f.size; continue; }
    try {
      const r = await put(f, batch, t, (n) => { bar.style.width = ((done + n) / total * 100).toFixed(1) + "%"; });
      ok.push(r.path); row.classList.add("ok"); row.querySelector(".s").textContent = r.name === f.name ? "✓" : `✓ as ${r.name}`;
    } catch (e) { row.classList.add("err"); row.querySelector(".s").textContent = "✗ " + e.message; }
    done += f.size; bar.style.width = (done / total * 100).toFixed(1) + "%";
  }
  delete $("#fsheet").dataset.busy;
  const act = p.querySelector(".fact");
  act.innerHTML = `<button type="button" class="fclose">Done</button>${ok.length ? `<button type="button" class="fgo">→ Thoughts</button>` : ""}`;
  act.querySelector(".fclose").onclick = () => sheet("");
  if (ok.length) act.querySelector(".fgo").onclick = () => thoughtsSheet(ok);
  p.querySelector("h3").textContent = `${ok.length} of ${files.length} uploaded to ~/Phone`;
  if (ok.length) go(phoneDir, { push: cur.path !== phoneDir });
});

installViewer();
if (EMBED) {
  $("#fthink").textContent = "Send…";
  // From π (same origin): { world } when its top bar changes; { open: path } for a tapped file link:
  // show its folder and open it in the viewer.
  addEventListener("message", async (e) => {
    if (e.origin !== location.origin) return;
    if (/^[A-Z]$/.test(e.data?.world || "")) lastWorld = e.data.world;
    if (typeof e.data?.open === "string") {
      const fp = e.data.open.replace(/\/+$/, "") || e.data.open;
      // A folder link opens the folder; a file link its folder, with the file in the viewer.
      const isDir = await getJSON("/api/ls?path=" + encodeURIComponent(fp)).then(() => true, () => false);
      if (isDir) return go(fp, { push: cur.path !== fp });
      const dir = fp.replace(/\/[^/]*$/, "");
      await go(dir, { push: cur.path !== dir });
      openViewer(fileHref(fp));
    }
  });
  parent.postMessage({ filsReady: true }, location.origin);
}
go(localStorage.getItem("files.dir") || "", { push: false });
