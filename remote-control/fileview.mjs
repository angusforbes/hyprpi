// The file viewer (J70, Angus via Thoughts-E: he opened an image link on the iPhone and "couldn't
// copy or share it (e.g. to send in a text message)" and "couldn't get back to the remote control
// app and had to quit and reopen it"). In the Home Screen app a /file link replaced the page and
// there is no browser back button. Now every file link (thread, Proj, Agnt, Strm, thumbnails, the
// Markdown viewer's own links) opens here, over the app: a bar with ✕ (back to exactly where he
// was: the app underneath is never touched, so its scroll stays), the name and Share.
//   images: a real <img> (long-press gives iOS's Save/Copy menu), fitted; pinch or double-tap zooms
//   Markdown: the J56 document viewer in a frame (its links open here too)
//   PDF: in a frame; text: shown as text; anything else: Share / Download
// Share: navigator.share with the file itself (the blob, fetched when the viewer opens, so the tap
// still counts as the user's gesture), so iOS offers Messages, Save Image, Copy; else the URL; else
// a download. The server's /file guard (J47, J69) decides what can be read, as before.
const HOME = "/home/agf";
const IMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i, MEDIA = /\.(mp4|m4v|mov|webm|mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i; // J175
const MDX = /\.(md|markdown)$/i;
const PDF = /\.pdf$/i;
import { MAX as MAX_BLOB, loadBlob, shareFiles, asFile, download, mb } from "/share.mjs"; // J173: real files to the share sheet
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let el = null, depth = 0, cur = null, gen = 0;

function build() {
  el = document.createElement("div");
  el.id = "fv"; el.hidden = true;
  el.innerHTML = `<header id="fvbar"><button id="fvback" type="button" title="back" hidden>‹</button><div id="fvtitle"><div id="fvname"></div><div id="fvdir"></div></div><span class="fpair"><button id="fvshare" type="button" title="share">Share</button><button id="fvsend" type="button" title="send to Thoughts or an agent" hidden>Send…</button></span><button id="fvx" type="button" title="close" aria-label="close">✕</button></header><div id="fvbody"></div><div id="fvnote" hidden></div>`;
  document.body.append(el);
  el.querySelector("#fvx").addEventListener("click", closeAll);
  el.querySelector("#fvback").addEventListener("click", () => history.back());
  el.querySelector("#fvshare").addEventListener("click", share);
  el.querySelector("#fvsend").addEventListener("click", () => { if (cur?.path && sendHandler) sendHandler(cur.path); });
  el.querySelector("#fvsend").hidden = !sendHandler;
  addEventListener("popstate", (e) => {
    const d = e.state?.fv || 0;
    if (!d) { depth = 0; hide(); return; }
    depth = d; show(e.state.href);
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.hidden) closeAll(); });
  // Links inside the framed Markdown viewer come here (viewer.js posts them).
  addEventListener("message", (e) => { if (e.origin === location.origin && e.data?.fvOpen) open(e.data.fvOpen); });
}

// Every way a file can be tapped in the app: /file and /wiki links, and images that aren't links.
export function fileTarget(t) {
  const a = t.closest?.("a[href]");
  if (a) { const h = a.getAttribute("href") || ""; return /^\/(file|wiki)\?/.test(h) ? h : null; }
  const im = t.closest?.("img.mdimg, img.img");
  if (im) { const s = im.getAttribute("src") || ""; return /^\/(file|wiki)\?/.test(s) ? s : null; }
  return null;
}
export function install(root = document) {
  root.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (el && el.contains(e.target)) return;
    const h = fileTarget(e.target); if (!h) return;
    e.preventDefault(); e.stopPropagation();
    open(h);
  }, true);
}

export function open(href) {
  if (!el) build();
  depth++;
  history.pushState({ ...(history.state || {}), fv: depth, href }, "");
  document.activeElement?.blur?.(); // the keyboard down, if it was up
  show(href);
}
function closeAll() { if (depth > 0) history.go(-depth); else hide(); }
function hide() { const was = !el.hidden; gen++; el.hidden = true; el.querySelector("#fvbody").innerHTML = ""; cur = null; if (was) for (const f of closers) try { f(); } catch { /* ignore */ } }
// J144: told when the viewer closes (✕, Esc or a back-swipe all end here), so a caller can return the
// user to where the file was opened from.
const closers = new Set();
// J155 (Angus: "i should be able to send... and share a single file from within the file once i've
// opened it"): a page that can send files (the Files app and π's Fils tab) registers a handler; the
// viewer then shows Send… beside Share for the open file. Elsewhere (the π overlay) there is none.
let sendHandler = null;
export function onSend(f) { sendHandler = f; if (el) el.querySelector("#fvsend").hidden = !f; }
export function onClose(f) { closers.add(f); return () => closers.delete(f); }

const pathOf = (u) => { try { return new URL(u, location.href).searchParams.get("path") || ""; } catch { return ""; } };
function note(t) { const n = el.querySelector("#fvnote"); n.textContent = t || ""; n.hidden = !t; if (t) setTimeout(() => { if (n.textContent === t) n.hidden = true; }, 3000); }

async function show(href) {
  const my = ++gen;
  el.hidden = false;
  el.querySelector("#fvback").hidden = depth < 2;
  const body = el.querySelector("#fvbody"); body.innerHTML = `<div class="fvmsg">…</div>`; body.className = "";
  el.querySelector("#fvname").textContent = "…"; el.querySelector("#fvdir").textContent = "";
  // A [[wiki link]]: the server finds the file and redirects to /file?path=…
  let url = href;
  if (href.startsWith("/wiki?")) {
    try { const r = await fetch(href, { cache: "no-store" }); if (!r.ok) throw new Error("not found in the vault"); url = new URL(r.url).pathname + new URL(r.url).search; r.body?.cancel?.(); }
    catch (e) { if (my === gen) fail(e.message); return; }
    if (my !== gen) return;
  }
  const p = pathOf(url), name = p.split("/").pop() || "file";
  url = "/file?path=" + encodeURIComponent(p);
  cur = { url, name, path: p, blob: null, ready: null };
  el.querySelector("#fvname").textContent = name;
  el.querySelector("#fvdir").textContent = p.replace(/\/[^/]*$/, "").replace(HOME, "~");
  // The file itself, fetched now so Share has it at the tap (iOS needs the share in the gesture).
  const c = cur;
  // (Markdown: /file serves the viewer page, so the text itself comes with raw=1.)
  // J173: with progress on the Share button for a big file (iOS only opens the sheet inside the tap, so
  // the file has to be here before it); a file over MAX_BLOB isn't held (Share downloads it instead).
  const shareBtn = el.querySelector("#fvshare");
  shareBtn.textContent = "Share"; shareBtn.classList.remove("loading");
  c.loaded = 0; c.total = 0;
  c.fetch = () => {
    if (c.ready) return c.ready;
    c.ready = loadBlob(MDX.test(p) ? url + "&raw=1" : url, { onProgress: (got, total) => {
      c.loaded = got; c.total = total;
      if (cur === c && total > 3e6) { shareBtn.classList.add("loading"); shareBtn.textContent = `Share ${Math.floor(got / total * 100)}%`; }
    } });
    c.ready.then((b) => { c.blob = b; c.tooBig = b === null; if (cur === c) { shareBtn.textContent = "Share"; shareBtn.classList.remove("loading"); if (c.waiting) { c.waiting = false; note("Ready: tap Share"); } } }, () => { if (cur === c) { shareBtn.textContent = "Share"; shareBtn.classList.remove("loading"); } });
    return c.ready;
  };
  // J175: a video or audio file plays in the viewer, streamed in ranges; it isn't also downloaded whole for
  // Share until that's wanted (the first Share tap, or once it has played a few seconds), so just looking
  // at a big video doesn't fetch it twice.
  if (MEDIA.test(p)) return showMedia(body, url, c, my);
  c.fetch();

  if (IMG.test(p)) return showImage(body, url, my);
  if (MDX.test(p) || PDF.test(p)) {
    body.className = "frame";
    body.innerHTML = `<iframe src="${esc(url)}" title="${esc(name)}"></iframe>`;
    c.ready.catch((e) => { if (my === gen) fail(e.message); });
    return;
  }
  let b; try { b = await c.ready; } catch (e) { if (my === gen) fail(e.message); return; }
  if (my !== gen) return;
  if (b && b.size < 3e6) {
    const head = new Uint8Array(await b.slice(0, 4096).arrayBuffer());
    if (!head.includes(0)) { body.className = "text"; body.innerHTML = `<pre>${esc(await b.text())}</pre>`; return; }
  }
  body.innerHTML = `<div class="fvmsg">No preview for this kind of file.<br><br><a class="fvbtn" href="${esc(url)}&dl=1" download="${esc(name)}" target="_blank" rel="noopener">Download</a> <button class="fvbtn" type="button">Share</button></div>`;
  body.querySelector("button").addEventListener("click", share);
}
function showMedia(body, url, c, my) {
  const audio = AUDIO.test(c.path);
  body.className = "fvmedia" + (audio ? " audio" : "");
  body.innerHTML = audio ? `<div class="fvaudio"><div class="fvaicon">🎵</div><audio controls preload="metadata"></audio></div>` : `<video controls playsinline preload="metadata"></video>`;
  const m = body.querySelector(audio ? "audio" : "video");
  m.addEventListener("error", () => { if (my === gen && m.error) fail("can't play this file here; Share or Send… still work"); });
  // Share's whole-file fetch starts once he has watched a little (he may well share it), not at open.
  m.addEventListener("timeupdate", () => { if (m.currentTime > 3 && !c.ready && my === gen) c.fetch(); });
  m.src = url; // after the listeners
}
function fail(msg) { el.querySelector("#fvbody").innerHTML = `<div class="fvmsg err">✗ ${esc(msg)}</div>`; }

// An image: fitted to the screen; two fingers zoom (the page itself doesn't), a double tap zooms in
// and out; panning is the box's own scrolling. Single touches are left alone, so a long press
// still gets iOS's Save / Copy menu on the <img>.
function showImage(body, url, my) {
  body.className = "fvimg";
  body.innerHTML = `<img alt="">`;
  const img = body.querySelector("img");
  img.onerror = () => { if (my === gen) fail("not found, or not allowed"); };
  img.src = url;
  let z = 1, start = null, lastTap = 0;
  const fit = () => { const r = body.getBoundingClientRect(); return Math.min(1, r.width / (img.naturalWidth || 1), r.height / (img.naturalHeight || 1)); };
  const zoom = (nz, cx, cy) => {
    nz = Math.max(1, Math.min(8, nz));
    const r = body.getBoundingClientRect(), ox = (body.scrollLeft + cx - r.left) / z, oy = (body.scrollTop + cy - r.top) / z;
    z = nz; body.classList.toggle("zoomed", z > 1.01);
    if (z > 1.01) { const f = fit(); img.style.width = img.naturalWidth * f * z + "px"; img.style.height = img.naturalHeight * f * z + "px"; }
    else { img.style.width = img.style.height = ""; }
    body.scrollLeft = ox * z - (cx - r.left); body.scrollTop = oy * z - (cy - r.top);
  };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  body.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) { start = { d: dist(e.touches), z }; e.preventDefault(); }
    else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { const t = e.touches[0]; zoom(z > 1.01 ? 1 : 2.5, t.clientX, t.clientY); e.preventDefault(); lastTap = 0; } else lastTap = now;
    }
  }, { passive: false });
  body.addEventListener("touchmove", (e) => { if (e.touches.length === 2 && start) { e.preventDefault(); const [x, y] = mid(e.touches); zoom(start.z * dist(e.touches) / start.d, x, y); } }, { passive: false });
  body.addEventListener("touchend", (e) => { if (e.touches.length < 2) start = null; });
  for (const ev of ["gesturestart", "gesturechange"]) body.addEventListener(ev, (e) => e.preventDefault());
  body.addEventListener("dblclick", (e) => zoom(z > 1.01 ? 1 : 2.5, e.clientX, e.clientY)); // a mouse
}

// Share (J173): the file itself, as a File with its real type, so iOS offers AirDrop, Messages, Save
// Video / Save Image… If it isn't here yet: say so (the tap can't wait for it). Too big to hold, or iOS
// won't take that kind of file: download it instead, and say so. No share sheet at all (a desktop
// browser): download.
async function share() {
  const c = cur; if (!c) return;
  if (!navigator.share) return download(c.path, c.name);
  if (c.tooBig) { download(c.path, c.name); return note(`Over ${mb(MAX_BLOB)}: too big to hand to the share sheet, so it's downloading instead`); }
  if (!c.ready) c.fetch(); // J175: media start their Share fetch on the first tap
  if (!c.blob) { c.waiting = true; return note(c.total ? `Preparing the file (${Math.floor(c.loaded / c.total * 100)}% of ${mb(c.total)})… tap Share again when it's ready` : "Preparing the file… tap Share again in a moment"); }
  try {
    const r = await shareFiles([asFile(c.blob, c.name)], c.name);
    if (r === "refused") { download(c.path, c.name); note("iOS won't share this kind of file from a web app, so it's downloading instead"); }
  } catch (e) { note(e.name === "NotAllowedError" ? "Tap Share again" : "✗ " + e.message); }
}
