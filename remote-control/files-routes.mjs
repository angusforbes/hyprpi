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
//
// Read-side checks (fileAllowed, refusedPart, underRoot) are server.mjs's own (J47/J69), passed in.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";

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
    if (!tokenOk(req)) { json(res, 403, { error: "bad token" }); return false; }
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

  // Returns true when it handled the request.
  return async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/files/token") { res.setHeader("cache-control", "no-store"); json(res, 200, { token: TOKEN, caps: { fileMB: CAPS.file / MB, batchMB: CAPS.batch / MB, batchFiles: CAPS.batchFiles }, phone: PHONE }); return true; }
    if (req.method === "GET" && url.pathname === "/api/ls") {
      const l = listDir(String(url.searchParams.get("path") || ""));
      l ? json(res, 200, l) : json(res, 404, { error: "not found or not allowed" });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/upload") { await upload(req, res); return true; }
    if (req.method === "POST" && url.pathname === "/api/files/thoughts") { await toThoughts(req, res); return true; }
    return false;
  };
}
