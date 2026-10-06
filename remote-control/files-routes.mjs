// The Files app's routes (J74, Angus: "a dedicate companion app on my phone that let's me browse the
// laptop (or at least the folders we've decided are safe) and be able to copy files to the phone and
// use the iphoen share panel … send iphone files to teh laptop, and also … shaer them with the hyprpi
// Thoughts with a little message so taht an agent can act on tehm").
//
//   GET  /api/files/token            the upload token (a custom header: a cross-site page can't send it)
//   GET  /api/ls?path=               a folder under the allowed roots (or the roots), J47 rules applied
//                                    to listing as to reading: hidden and key-like names never listed,
//                                    symlinks only when their target is allowed too
//   POST /api/upload                 one file, raw body; X-File-Name (URI-encoded), X-Batch, X-Upload-Token.
//                                    THE ONLY WRITE: into ~/Phone, nowhere else; caps; never overwrites
//   POST /api/files/thoughts {world, note, paths}   a note + files to a world's Thoughts (via phone)
//   GET  /api/find?q=                a NAME search across all the allowed roots (J142): fd, read-only, clutter
//                                    skipped, every hit re-checked with fileAllowed; folders first, capped
//   GET  /api/thumb?path=&v=        a small cached WebP of an image (J151), ~320 px, made by vipsthumbnail on
//                                    first request into remote-control/.thumbs/ (gitignored; a hidden folder,
//                                    so /file and /api/ls never serve or list it); v = the image's mtime, and
//                                    the answer is cached by the phone for a year (a new mtime = a new URL)
//   POST /api/files/agent {agent, note, paths}      the same to any live agent (J141, the π app's Fils tab):
//                                    its prompt names the files, as a pasted image does on the desktop
//
// Read-side checks (fileAllowed, refusedPart, underRoot) are server.mjs's own (J47/J69), passed in.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { spawn } from "node:child_process";

const MB = 1e6;
// Caps (J74, Angus's pick on the card, D3; default a): per file, per batch (one Upload tap), free disk kept.
export const CAPS = {
  file: (Number(process.env.HYPRPI_UPLOAD_MAX_FILE_MB) || 250) * MB,
  batch: (Number(process.env.HYPRPI_UPLOAD_MAX_BATCH_MB) || 1000) * MB,
  batchFiles: Number(process.env.HYPRPI_UPLOAD_MAX_BATCH_FILES) || 50,
  keepFree: (Number(process.env.HYPRPI_UPLOAD_KEEP_FREE_GB) || 5) * 1000 * MB,
};
const IMG = /\.(png|jpe?g|gif|webp)$/i;

export function filesRoutes({ HOME, FILE_ROOTS, fileAllowed, refusedPart, underRoot, json, body, log, getApi, room }) {
  const PHONE = path.join(HOME, "Phone");
  const LOG = path.join(HOME, ".local/state/hyprpi/phone-uploads.log");
  const TOKEN = randomBytes(24).toString("hex");
  const batches = new Map(); // id -> { bytes, files, at }
  let reserved = 0, active = 0; // bytes and uploads in flight (the free-disk rule counts them all)
  const MAX_ACTIVE = 4, MAX_BATCHES = 200, IDLE_MS = 60e3;
  try { fs.mkdirSync(PHONE, { recursive: true, mode: 0o755 }); } catch (e) { log("~/Phone:", e.message); }
  if (!phoneDirOk()) log("~/Phone is not a plain folder (a link?): uploads are refused");
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); } catch { /* there */ }
  // Leftovers of uploads cut off by a restart.
  try { for (const f of fs.readdirSync(PHONE)) if (/^\.upload-[\w-]+\.part$/.test(f)) fs.unlinkSync(path.join(PHONE, f)); } catch { /* none */ }

  const tokenOk = (req) => {
    const t = Buffer.from(String(req.headers["x-upload-token"] || "")), k = Buffer.from(TOKEN);
    return t.length === k.length && timingSafeEqual(t, k);
  };
  // Stricter than the app's POST rule: the Origin must be there and be this host (or the browser
  // says same-origin), and the token must match.
  const sameOrigin = (req) => {
    const o = req.headers.origin, sfs = req.headers["sec-fetch-site"];
    if (sfs && sfs !== "same-origin") return false;
    if (!o) return sfs === "same-origin";
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  };
  const writeGate = (req, res) => {
    if (!sameOrigin(req)) { json(res, 403, { error: "bad origin" }); return false; }
    if (!tokenOk(req)) { log("refused: bad token", req.headers["tailscale-user-login"] || "local", req.url); json(res, 403, { error: "bad token" }); return false; } // J143: logged
    return true;
  };

  // A name for ~/Phone: one plain name (no folders), not hidden, not key-like, no control characters.
  function safeName(raw) {
    let n; try { n = decodeURIComponent(String(raw || "")); } catch { return null; }
    n = n.normalize("NFC").trim();
    if (!n || Buffer.byteLength(n) > 200) return null;
    if (/[/\\\0]/.test(n) || /[\x00-\x1f\x7f]/.test(n)) return null;
    if (n === "." || n === ".." || refusedPart(n)) return null;
    return n;
  }
  // ~/Phone must be a plain folder, itself and its real path (checked when a file starts AND again
  // just before it is given its name: J74 security review, a folder swapped for a link mid-upload).
  function phoneDirOk() {
    try { const st = fs.lstatSync(PHONE); return st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync(PHONE) === PHONE; } catch { return false; }
  }
  function freeBytes() { try { const s = fs.statfsSync(PHONE); return s.bavail * s.bsize; } catch { return 0; } }
  function uploadLog(rec) { try { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"); } catch { /* best effort */ } }

  function listDir(p) {
    if (!p) { // the roots
      return { path: "", parent: null, entries: FILE_ROOTS.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } })
        .map((r) => { const st = fs.statSync(r); return { name: path.basename(r), path: r, dir: true, size: 0, mtime: st.mtimeMs }; }) };
    }
    const real = fileAllowed(p);
    if (!real) return null;
    let st; try { st = fs.statSync(real); } catch { return null; }
    if (!st.isDirectory()) return null;
    const out = [];
    let ents = []; try { ents = fs.readdirSync(real, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      if (refusedPart(e.name)) continue;
      const full = path.join(real, e.name);
      let target = full;
      if (e.isSymbolicLink()) { target = fileAllowed(full); if (!target) continue; } // only links that stay allowed
      let s; try { s = fs.statSync(target); } catch { continue; }
      if (!s.isDirectory() && !s.isFile()) continue;
      out.push({ name: e.name, path: full, dir: s.isDirectory(), size: s.isFile() ? s.size : 0, mtime: s.mtimeMs });
      if (out.length >= 5000) break;
    }
    const isRoot = FILE_ROOTS.includes(real);
    return { path: real, parent: isRoot ? "" : path.dirname(real), entries: out, truncated: out.length >= 5000 };
  }

  async function upload(req, res) {
    if (!writeGate(req, res)) return;
    const name = safeName(req.headers["x-file-name"]);
    if (!name) return json(res, 400, { error: "not an allowed file name" });
    const lenH = req.headers["content-length"];
    if (lenH === undefined || !/^\d+$/.test(String(lenH))) return json(res, 411, { error: "length needed" });
    const len = Number(lenH);
    if (len > CAPS.file) return json(res, 413, { error: `larger than ${CAPS.file / MB} MB` });
    const bid = String(req.headers["x-batch"] || "");
    if (!/^[\w-]{8,64}$/.test(bid)) return json(res, 400, { error: "batch?" });
    if (active >= MAX_ACTIVE) return json(res, 429, { error: "too many uploads at once" });
    const now = Date.now();
    for (const [k, v] of batches) if (now - v.at > 3600e3 || (!v.files && now - v.at > 60e3)) batches.delete(k);
    if (!batches.has(bid) && batches.size >= MAX_BATCHES) return json(res, 429, { error: "too many upload batches; try again in a while" });
    const b = batches.get(bid) || { bytes: 0, files: 0, at: now };
    if (b.files + 1 > CAPS.batchFiles) return json(res, 413, { error: `more than ${CAPS.batchFiles} files at once` });
    if (b.bytes + len > CAPS.batch) return json(res, 413, { error: `more than ${CAPS.batch / MB} MB at once` });
    if (!phoneDirOk()) return json(res, 500, { error: "~/Phone is not a plain folder" });
    if (freeBytes() - reserved - len < CAPS.keepFree) return json(res, 507, { error: "the laptop's disk is nearly full" });
    b.bytes += len; b.files += 1; b.at = now; batches.set(bid, b); // reserved; given back on failure
    reserved += len; active += 1;
    let released = false;
    const release = (failed) => { if (released) return; released = true; reserved -= len; active -= 1; if (failed) { b.bytes -= len; b.files -= 1; } };
    req.setTimeout(IDLE_MS, () => req.destroy(Object.assign(new Error("upload stalled"), { status: 408 }))); // no data for a minute
    const tmp = path.join(PHONE, `.upload-${randomUUID()}.part`);
    let fd;
    try { fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644); }
    catch (e) { release(true); return json(res, 500, { error: e.message }); }
    let got = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(null, { fd, autoClose: true });
        let failed = false;
        const fail = (e) => { if (failed) return; failed = true; req.unpipe(out); out.destroy(); reject(e); };
        req.on("data", (c) => { got += c.length; if (got > len) { fail(Object.assign(new Error("more data than announced"), { status: 400 })); req.destroy(); } });
        req.on("aborted", () => fail(Object.assign(new Error("upload cut off"), { status: 400 })));
        req.on("error", fail);
        req.on("close", () => { if (got < len) fail(Object.assign(new Error("upload cut off"), { status: 400 })); });
        out.on("error", fail);
        out.on("finish", () => (got === len ? resolve() : fail(Object.assign(new Error("upload cut off"), { status: 400 }))));
        req.pipe(out);
      });
      if (!phoneDirOk()) throw Object.assign(new Error("~/Phone changed during the upload"), { status: 500 });
      // Never overwrite: link the finished file under a free name (link fails if the name exists).
      const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
      let final = null;
      for (let i = 1; i <= 999 && !final; i++) {
        const cand = path.join(PHONE, i === 1 ? name : `${stem} (${i})${ext}`);
        try { fs.linkSync(tmp, cand); final = cand; } catch (e) { if (e.code !== "EEXIST") throw e; }
      }
      fs.unlinkSync(tmp);
      if (!final) throw Object.assign(new Error("no free name"), { status: 409 });
      uploadLog({ name: path.basename(final), size: len, batch: bid, login: req.headers["tailscale-user-login"] || "local" });
      log("upload", path.basename(final), len);
      release(false);
      return json(res, 200, { name: path.basename(final), path: final, size: len });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* gone */ }
      release(true);
      uploadLog({ refused: name, size: len, got, error: e.message });
      if (!res.headersSent) return json(res, e.status || 500, { error: e.message });
    }
  }

  async function toThoughts(req, res) {
    if (!writeGate(req, res)) return;
    const b = await body(req), r = room(b.world);
    if (!r) return json(res, 400, { error: "world?" });
    const asked = Array.isArray(b.paths) ? b.paths.slice(0, 20) : [];
    const files = [];
    for (const p of asked) { const real = typeof p === "string" ? fileAllowed(p) : null; if (real) { try { if (fs.statSync(real).isFile()) files.push(real); } catch { /* gone */ } } }
    if (asked.length && files.length !== asked.length) return json(res, 404, { error: "a file is not found or not allowed" });
    const note = String(b.note || "").trim().slice(0, 4000);
    if (!note && !files.length) return json(res, 400, { error: "a note or files needed" });
    const api = getApi(); if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
    const list = files.map((f) => `- file://${encodeURI(f)}`).join("\n");
    const text = `${note || "(files from my phone)"}${files.length ? `\n\n📎 ${files.length === 1 ? "File" : files.length + " files"} from the Files app:\n${list}` : ""}`;
    const images = files.filter((f) => IMG.test(f));
    log("files → thoughts", r, files.length, "files");
    return json(res, 200, await api.call("thoughts.send", { room: r, text, images, via: "phone" }));
  }

  // J141: a note + files to an agent (by id). The prompt carries the paths (an agent opens them with
  // its read tool, images included), like a screenshot pasted into its window. Same checks as Thoughts.
  async function toAgent(req, res) {
    if (!writeGate(req, res)) return;
    const b = await body(req), id = String(b.agent || "").trim();
    if (!id) return json(res, 400, { error: "agent?" });
    const asked = Array.isArray(b.paths) ? b.paths.slice(0, 20) : [];
    const files = [];
    for (const p of asked) { const real = typeof p === "string" ? fileAllowed(p) : null; if (real) { try { if (fs.statSync(real).isFile()) files.push(real); } catch { /* gone */ } } }
    if (asked.length && files.length !== asked.length) return json(res, 404, { error: "a file is not found or not allowed" });
    const note = String(b.note || "").trim().slice(0, 4000);
    if (!note && !files.length) return json(res, 400, { error: "a note or files needed" });
    const api = getApi(); if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
    const text = `[Angus, from his phone (Files)]\n${note || "(files from my phone)"}${files.length ? `\n\n📎 ${files.length === 1 ? "File" : files.length + " files"} from Angus's phone (open ${files.length === 1 ? "it" : "them"} with your read tool; images too):\n${files.map((f) => `- [${f.replace(/[\r\n\]\[]+/g, " ")}](file://${encodeURI(f)})`).join("\n")}` : ""}`;
    log("files → agent", id, files.length, "files");
    try { return json(res, 200, await api.call("agent.prompt", { agent: id, text, via: "phone" })); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }

  // J142 (Angus: "if i search for "squishy" while at the "root", should it go into Work and find that
  // project?"): names only (not contents), case-insensitive, fixed string. fd skips hidden entries and what
  // .gitignore files ignore, never follows symlinks, and gets the clutter excludes below; each hit then goes
  // through fileAllowed (the J47 guard: hidden or key-like parts, symlinks resolved and kept inside the
  // roots), so search can reach nothing that browsing can't. Folders first, then exact / prefix matches,
  // shallower, newer. At most FIND_MAX shown; fd stops at 600 hits or after 4 s.
  const FIND_MAX = 60;
  const CLUTTER = ["node_modules", ".git", "__pycache__", ".venv", "venv", ".cache", "dist", "build", "target", ".next", ".nuxt", "coverage", ".turbo", ".parcel-cache", ".pytest_cache", ".mypy_cache", ".gradle", ".idea", ".browser-profile", "site-packages"];
  function find(q) {
    return new Promise((resolve) => {
      const roots = FILE_ROOTS.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
      const args = ["--fixed-strings", "--ignore-case", "--absolute-path", "--color", "never", "--max-results", "600", "--max-depth", "14", ...CLUTTER.flatMap((x) => ["--exclude", x]), "--", q, ...roots];
      let out = "", done = false;
      const t0 = Date.now();
      const p = spawn("fd", args, { stdio: ["ignore", "pipe", "ignore"] });
      const finish = (timedOut) => {
        if (done) return; done = true; clearTimeout(timer);
        const seen = new Set(), hits = [];
        const ql = q.toLowerCase();
        for (let line of out.split("\n")) {
          line = line.replace(/\/+$/, ""); if (!line) continue;
          const real = fileAllowed(line); if (!real || seen.has(real)) continue;
          let st; try { st = fs.statSync(real); } catch { continue; }
          if (!st.isDirectory() && !st.isFile()) continue;
          seen.add(real);
          const name = path.basename(real), nl = name.toLowerCase();
          hits.push({ name, path: real, dir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs,
            rank: (st.isDirectory() ? 0 : 4) + (nl === ql ? 0 : nl.startsWith(ql) ? 1 : 2), depth: real.split("/").length });
        }
        hits.sort((a, b) => a.rank - b.rank || a.depth - b.depth || b.mtime - a.mtime);
        resolve({ q, total: hits.length, truncated: hits.length > FIND_MAX || timedOut || hits.length >= 600, ms: Date.now() - t0, results: hits.slice(0, FIND_MAX).map(({ rank, depth, ...h }) => h) });
      };
      const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish(true); }, 4000);
      p.stdout.on("data", (d) => { out += d; });
      p.on("close", () => finish(false));
      p.on("error", () => finish(false));
    });
  }

  // J151 (Angus: "how come the thumbnails take so long to reload, and if i leave the folder and come back, it
  // looks like it has to reload them all again"): list rows used the full image (/file, screenshots of 0.4–1.2
  // MB, sent with "cache-control: no-cache" and no validator, so every visit downloaded them all again). Now
  // a small WebP per image, keyed by its real path + mtime + size (an edited image gets a new one), kept in
  // THUMBS (Angus: "it go under the remote-control folder there, but make sure it's gitignored"). Prune: files
  // not used for 30 days, and the oldest beyond 200 MB, once an hour.
  const THUMBS = path.join(path.dirname(new URL(import.meta.url).pathname), ".thumbs");
  const THUMB_PX = 320, THUMB_MAX_SRC = 80e6, THUMB_DAYS = 30, THUMB_CAP = 200e6;
  const making = new Map(); // key -> Promise (one vipsthumbnail per image at a time)
  let thumbJobs = 0; const thumbQueue = [];
  const runThumb = (src, out) => new Promise((resolve, reject) => {
    const go = () => {
      thumbJobs++;
      const tmp = out + "." + process.pid + "." + Date.now() + ".tmp.webp";
      const p = spawn("vipsthumbnail", [src, "--size", `${THUMB_PX}x${THUMB_PX}`, "-o", tmp + "[Q=72,strip]"], { stdio: ["ignore", "ignore", "ignore"] });
      const done = (ok) => { thumbJobs--; const n = thumbQueue.shift(); if (n) n(); if (ok) { try { fs.renameSync(tmp, out); resolve(out); } catch (e) { reject(e); } } else { try { fs.unlinkSync(tmp); } catch { /* none */ } reject(new Error("thumbnail failed")); } };
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 20000);
      p.on("close", (c) => { clearTimeout(t); done(c === 0 && fs.existsSync(tmp)); });
      p.on("error", () => { clearTimeout(t); done(false); });
    };
    thumbJobs < 3 ? go() : thumbQueue.push(go);
  });
  function pruneThumbs() {
    let ents = []; try { ents = fs.readdirSync(THUMBS).filter((f) => f.endsWith(".webp")).map((f) => { const fp = path.join(THUMBS, f); const st = fs.statSync(fp); return { fp, size: st.size, used: st.atimeMs > st.mtimeMs ? st.atimeMs : st.mtimeMs }; }); } catch { return { removed: 0 }; }
    const now = Date.now(); let removed = 0;
    for (const e of ents) if (now - e.used > THUMB_DAYS * 864e5) { try { fs.unlinkSync(e.fp); e.gone = true; removed++; } catch { /* busy */ } }
    let total = ents.filter((e) => !e.gone).reduce((n, e) => n + e.size, 0);
    for (const e of ents.filter((x) => !x.gone).sort((a, b) => a.used - b.used)) { if (total <= THUMB_CAP) break; try { fs.unlinkSync(e.fp); total -= e.size; removed++; } catch { /* busy */ } }
    return { removed, total };
  }
  setTimeout(() => pruneThumbs(), 60e3).unref?.(); setInterval(() => pruneThumbs(), 3600e3).unref?.();
  async function thumb(req, res, url) {
    const real = fileAllowed(String(url.searchParams.get("path") || ""));
    if (!real || !/\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(real)) return json(res, 404, { error: "not found or not allowed" });
    let st; try { st = fs.statSync(real); } catch { return json(res, 404, { error: "not found" }); }
    if (!st.isFile() || st.size > THUMB_MAX_SRC) return json(res, 404, { error: "no thumbnail" });
    const key = createHash("sha1").update(`${real}\0${st.mtimeMs}\0${st.size}\0${THUMB_PX}`).digest("hex");
    const out = path.join(THUMBS, key + ".webp");
    if (!fs.existsSync(out)) {
      try { fs.mkdirSync(THUMBS, { recursive: true }); if (!making.has(key)) making.set(key, runThumb(real, out).finally(() => making.delete(key))); await making.get(key); }
      catch { return json(res, 415, { error: "can't make a thumbnail" }); }
    }
    try { const t = new Date(); fs.utimesSync(out, t, fs.statSync(out).mtime); } catch { /* best effort: marks it used, for pruning */ }
    const etag = `"${key.slice(0, 20)}"`;
    // v (the mtime) makes the URL change when the image does, so the phone may keep it for good.
    const cache = url.searchParams.get("v") === String(Math.round(st.mtimeMs)) ? "private, max-age=31536000, immutable" : "private, max-age=300";
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag, "cache-control": cache }); return res.end(); }
    let size = 0; try { size = fs.statSync(out).size; } catch { return json(res, 404, { error: "gone" }); }
    res.writeHead(200, { "content-type": "image/webp", "content-length": size, "cache-control": cache, etag, "x-content-type-options": "nosniff" });
    fs.createReadStream(out).on("error", () => res.destroy()).pipe(res);
  }
  if (process.env.HYPRPI_THUMB_PRUNE_TEST) Object.assign(globalThis, { __pruneThumbs: pruneThumbs, __THUMBS: THUMBS });

  // Returns true when it handled the request.
  return async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/files/token") { res.setHeader("cache-control", "no-store"); json(res, 200, { token: TOKEN, caps: { fileMB: CAPS.file / MB, batchMB: CAPS.batch / MB, batchFiles: CAPS.batchFiles }, phone: PHONE }); return true; }
    if (req.method === "GET" && url.pathname === "/api/ls") {
      const l = listDir(String(url.searchParams.get("path") || ""));
      l ? json(res, 200, l) : json(res, 404, { error: "not found or not allowed" });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/find") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (q.length < 2 || q.length > 80 || /[\0\n\r]/.test(q)) { json(res, 400, { error: "2 to 80 characters" }); return true; }
      json(res, 200, await find(q)); return true;
    }
    if (req.method === "GET" && url.pathname === "/api/thumb") { await thumb(req, res, url); return true; }
    if (req.method === "POST" && url.pathname === "/api/upload") { await upload(req, res); return true; }
    if (req.method === "POST" && url.pathname === "/api/files/thoughts") { await toThoughts(req, res); return true; }
    if (req.method === "POST" && url.pathname === "/api/files/agent") { await toAgent(req, res); return true; }
    return false;
  };
}
