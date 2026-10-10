// J250 (Angus: "take a screenshot with my phone and send it to you very easily"): a screenshot from the
// iPhone's share sheet, through an iOS Shortcut, straight to a world's Thoughts.
// J415 (Angus: "why not media and files and pdfs and urls too? … yes why not"): the same Shortcut takes
// anything the share sheet gives it. Images go as before (an image Thoughts sees); PDFs, videos, audio
// and other files are saved in ~/Phone and Thoughts gets their path; a URL or text becomes the message
// itself (no file). What it is comes from the bytes (the Shortcut's body is "File" whatever is shared),
// helped by an optional X-File-Name header / Content-Type for the extension.
//
//   POST /api/shot?world=D&caption=…   the shared item as the raw body, at most MAX (500 MB)
//        X-Shot-Token: <token>         the Shortcut's own secret (below)
//   GET  /api/shot/setup               the URL and token for setting the Shortcut up (shown in π's help)
//
// Who may: everything this server serves already needs Angus's Tailscale login (or a local
// connection); a Shortcut sends no Origin, so this route can't use the page's same-origin proof and
// asks for a token instead: a long random secret kept in ~/.config/hyprpi/phone-shot-token (0600),
// made on first use and the same across restarts (the Shortcut keeps it). A wrong or missing token → 403.
//
// The world: ?world=X, else the world he last sent to Thoughts from the phone, else the desktop's.
// The image is saved in ~/Phone as screenshot-YYYYMMDD-HHMMSS.<ext> (never overwriting), turned into a
// JPEG of at most 2048 px when it is HEIC/AVIF or over 5 MB (vips), and sent to that world's Thoughts
// as a 📎 upload is (thoughts.send with images, via phone), with the caption as the text.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { imgSize } from "./session-read.mjs";

const MB = 1 << 20, MAX = 500 * MB, TEXT_MAX = 256 << 10, MSG_MAX = 4000;
const EXT_OK = /^[a-z0-9]{1,8}$/;
const MIME_EXT = { "application/pdf": "pdf", "video/mp4": "mp4", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav", "application/zip": "zip", "text/plain": "txt", "text/html": "html", "text/csv": "csv", "application/json": "json", "text/vcard": "vcf", "text/calendar": "ics" };
const human = (n) => n >= MB ? `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export function shotRoutes({ HOME, UPLOAD_DIR, json, log, getApi, room, getActive, tokenFile }) {
  const TOKEN_FILE = tokenFile || path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi", "phone-shot-token");
  let token = null;
  function getToken() {
    if (token) return token;
    try { const t = fs.readFileSync(TOKEN_FILE, "utf8").trim(); if (/^[0-9a-f]{40,}$/.test(t)) return (token = t); } catch { /* none yet */ }
    token = randomBytes(24).toString("hex");
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
    log("shot: made a new Shortcut token in", TOKEN_FILE);
    return token;
  }
  // J415 follow-up 3: the token may also come as ?key= in the URL, so the Shortcut needs no header at all
  // (Angus's tries died in tailscale serve's HTTP/2 server with PROTOCOL_ERROR before reaching us; a
  // header pasted with a stray space or newline, or an empty header row, does that).
  const tokenOk = (req, url) => {
    const t = Buffer.from(String(req.headers["x-shot-token"] || url?.searchParams.get("key") || "").trim()), k = Buffer.from(getToken());
    return t.length === k.length && timingSafeEqual(t, k);
  };
  let lastWorld = ""; // the world he last wrote to from the phone (server.mjs tells us)

  const kind = (b) => {
    if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return "png";
    if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
    if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
    if (b.toString("latin1", 0, 3) === "GIF") return "gif";
    if (b.length > 12 && b.toString("latin1", 4, 8) === "ftyp") { const brand = b.toString("latin1", 8, 12); return /avif|avis/.test(brand) ? "avif" : /hei|mif1|msf1|hevc/.test(brand) ? "heic" : null; }
    return null;
  };
  // J415: not an image → what kind of file, by its first bytes: [ext, label] or null
  const fileKind = (b) => {
    const at = (o, n) => b.toString("latin1", o, o + n);
    if (at(0, 5) === "%PDF-") return ["pdf", "PDF"];
    if (b.length > 12 && at(4, 4) === "ftyp") {
      const brand = at(8, 4);
      if (/^qt/.test(brand)) return ["mov", "video"];
      if (/^M4A|^M4B/.test(brand)) return ["m4a", "audio"];
      if (/^3g/.test(brand)) return ["3gp", "video"];
      return ["mp4", "video"];
    }
    if (b.length > 12 && at(0, 4) === "RIFF") return at(8, 4) === "WAVE" ? ["wav", "audio"] : at(8, 4) === "AVI " ? ["avi", "video"] : null;
    if (at(0, 4) === "\x1aE\xdf\xa3") return ["mkv", "video"];
    if (at(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return ["mp3", "audio"];
    if (at(0, 4) === "PK\x03\x04") return ["zip", "file"];
    return null;
  };
  // J415: a shared URL or text arrives as a small UTF-8 body: [text] if it is one, else null
  const asText = (b) => {
    if (!b.length || b.length > TEXT_MAX || b.includes(0)) return null;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(b).replace(/^\ufeff/, ""); } catch { return null; }
  };
  // a Safari page can come as its downloaded HTML, or as a .webloc: dig out the page's own URL
  const pageUrl = (t) => {
    const m = t.match(/<link[^>]+rel=["']?canonical["']?[^>]*>/i) || t.match(/<meta[^>]+property=["']og:url["'][^>]*>/i);
    const u = m && (m[0].match(/href=["']([^"']+)/i) || m[0].match(/content=["']([^"']+)/i));
    return u && /^https?:\/\//.test(u[1]) ? u[1] : null;
  };
  const pageTitle = (t) => { const m = t.match(/<title[^>]*>([^<]{1,300})<\/title>/i); return m ? m[1].replace(/\s+/g, " ").trim() : ""; };
  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  function freeName(base, ext) {
    for (let i = 1; i < 1000; i++) { const f = path.join(UPLOAD_DIR, `${base}${i > 1 ? ` (${i})` : ""}.${ext}`); if (!fs.existsSync(f)) return f; }
    throw new Error("no free name");
  }
  const vips = (inp, out) => new Promise((res, rej) => execFile("vipsthumbnail", [inp, "--size", "2048x2048>", "-o", `${out}[Q=85,strip]`], { timeout: 30000 }, (e) => e ? rej(e) : res()));

  const tooBig = () => Object.assign(new Error(`too big: ${MAX / MB} MB at most`), { status: 413 });
  // J415: streamed to a hidden part file in ~/Phone (videos can be hundreds of MB); returns its path and size
  async function readBody(req) {
    const len = Number(req.headers["content-length"] || 0);
    if (len > MAX) { req.resume(); throw tooBig(); }
    const tmp = path.join(UPLOAD_DIR, `.shot-${randomBytes(6).toString("hex")}.part`);
    const fd = fs.openSync(tmp, "wx", 0o600); let n = 0;
    try {
      for await (const c of req) { n += c.length; if (n > MAX) throw tooBig(); fs.writeSync(fd, c); }
    } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); req.destroy(); throw e; }
    fs.closeSync(fd);
    return { tmp, n };
  }
  const head = (f, n) => { const fd = fs.openSync(f, "r"); try { const b = Buffer.alloc(n); return b.subarray(0, fs.readSync(fd, b, 0, n, 0)); } finally { fs.closeSync(fd); } };
  // the name he shared it under, if the Shortcut sends it (X-File-Name, optional): safe, no path, no dot first
  const sharedName = (req, url) => {
    const q = url?.searchParams.get("name"); // &name= in the URL (no header needed; Pocket), already decoded
    let h = q != null ? q : String(req.headers["x-file-name"] || "");
    if (q != null) { /* as is */ } else if (/%[0-9a-f]{2}/i.test(h)) { try { h = decodeURIComponent(h); } catch { /* raw */ } }
    else { try { h = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(h, "latin1")); } catch { /* latin1 as is */ } } // iOS sends it raw UTF-8; Node reads header bytes as latin1 (Pocket)
    const n = path.basename(h).replace(/[\x00-\x1f/\\:*?"<>|]/g, "").replace(/^\.+/, "").trim().slice(0, 120);
    return n || "";
  };

  // J415 follow-up (Angus's first tries: "The network connection was lost"): an answer sent before the
  // body is read lets the connection close under iOS, which then shows "connection lost" instead of
  // our error. So a refusal reads (and drops) the body first, unless it is over the cap anyway.
  async function refuse(req, res, status, error) {
    if (Number(req.headers["content-length"] || 0) <= MAX) { let n = 0; try { for await (const c of req) { n += c.length; if (n > MAX) break; } } catch { /* gone */ } }
    return json(res, status, { error });
  }

  async function shot(req, res, url) {
    const t0 = Date.now(); // every Shortcut request is logged, with its outcome (Angus's tries left no trace)
    log("shot: request from", req.headers["tailscale-user-login"] || req.socket.remoteAddress, "length", req.headers["content-length"] ?? "(chunked)", req.headers["content-type"] || "", String(req.headers["user-agent"] || "").slice(0, 60));
    res.on("finish", () => log("shot: answered", res.statusCode, `${Date.now() - t0} ms`));
    req.on("aborted", () => log("shot: the phone dropped the connection mid-upload"));
    if (!tokenOk(req, url)) { log("shot: refused (token)", req.headers["tailscale-user-login"] || req.socket.remoteAddress); return refuse(req, res, 403, "bad key: copy the URL again from /shortcut"); }
    const api = getApi(); if (!api) return refuse(req, res, 503, "hyprpi daemon not reachable");
    const asked = String(url.searchParams.get("world") || "").trim().toUpperCase();
    const r = asked && asked !== "AUTO" ? room(asked) : room(lastWorld) || room(getActive());
    if (!r) return refuse(req, res, 400, `no world ${asked}`);
    const caption = String(url.searchParams.get("caption") ?? (() => { const h = String(req.headers["x-caption"] || ""); try { return decodeURIComponent(h); } catch { return h; } })()).trim().slice(0, 4000);
    try { const st = fs.lstatSync(UPLOAD_DIR); if (!st.isDirectory() || st.isSymbolicLink()) throw 0; } catch { return json(res, 500, { error: "~/Phone is not a plain folder" }); }
    let body; try { body = await readBody(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    const { tmp } = body;
    try { return await deliver(req, res, r, caption, body, url); } finally { fs.rmSync(tmp, { force: true }); }
  }

  const send = async (res, r, text, images, extra) => {
    try { await getApi().call("thoughts.send", { room: r, text, via: "phone", ...(images.length ? { images } : {}) }); }
    catch (e) { return json(res, 502, { error: "not sent: " + e.message, ...extra }); }
    return json(res, 200, { ok: true, world: r, ...extra, message: `Sent to Thoughts-${r}` });
  };
  const join = (caption, line) => caption ? `${caption}\n\n${line}` : line;

  async function deliver(req, res, r, caption, { tmp, n }, url) {
    if (!n) return json(res, 400, { error: "nothing was shared: run it from the Share sheet (▶ in the editor sends nothing)" });
    const b = head(tmp, Math.min(n, TEXT_MAX + 1)), named = sharedName(req, url);
    const k = kind(b);
    if (k) { // an image: as J250 (Thoughts sees it)
      const base = `screenshot-${stamp()}`;
      let file;
      if (k === "heic" || k === "avif" || n > 5 * MB) { // the model takes ≤ ~5 MB; Thoughts takes png/jpeg/webp/gif
        const src = tmp.replace(/\.part$/, "." + k); fs.renameSync(tmp, src);
        try { file = freeName(base, "jpg"); await vips(src, file); }
        catch (e) { log("shot: vips failed:", String(e.message || e).slice(0, 400)); fs.rmSync(file || "", { force: true }); return json(res, 422, { error: "couldn't read that image" }); } // short: it shows in the Shortcut's notification (Pocket)
        finally { fs.rmSync(src, { force: true }); }
      } else { file = freeName(base, k); fs.renameSync(tmp, file); fs.chmodSync(file, 0o644); }
      const dim = imgSize(head(file, 256 << 10));
      log("shot →", r, path.basename(file), n, caption ? JSON.stringify(caption.slice(0, 60)) : "");
      return send(res, r, caption, [file], { path: file, ...(dim ? { w: dim.w, h: dim.h } : {}) });
    }
    const fk = fileKind(b), text = fk ? null : asText(b);
    if (text != null) { // J415: a URL or text, or a Safari page that came as its HTML or a .webloc
      const t = text.trim();
      let url = /^https?:\/\/\S+$/i.test(t) ? t : null, title = "";
      if (!url && /^<\?xml|<plist/i.test(t) && /<key>URL<\/key>/.test(t)) url = (t.match(/<key>URL<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || null;
      const html = !url && /^(<!doctype html|<html)/i.test(t);
      if (html) { url = pageUrl(t); title = pageTitle(t); }
      if (url || (!html && t && t.length <= MSG_MAX)) {
        const line = url ? (title ? `🔗 ${title}\n${url}` : `🔗 ${url}`) : t;
        log("shot →", r, url ? "url" : "text", JSON.stringify((url || t).slice(0, 80)));
        return send(res, r, join(caption, line), [], { kind: url ? "url" : "text", ...(url ? { url } : {}) });
      }
      if (!t) return json(res, 400, { error: "nothing was shared" });
      // long text, or a web page with no URL in it: kept as a file below (.txt / .html)
    }
    const ext = (() => {
      const fromName = path.extname(named).slice(1).toLowerCase();
      if (EXT_OK.test(fromName)) return fromName;
      if (fk) return fk[0];
      const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (MIME_EXT[ct]) return MIME_EXT[ct];
      return text != null ? (/^(<!doctype html|<html)/i.test(text.trim()) ? "html" : "txt") : "bin";
    })();
    const label = fk ? fk[1] : text != null ? "text" : "file"; // only the bytes say PDF/video/audio (Pocket)
    const base = named ? path.basename(named, path.extname(named)) || `shared-${stamp()}` : `${label === "PDF" ? "pdf" : label}-${stamp()}`;
    const file = freeName(base, ext);
    fs.renameSync(tmp, file); fs.chmodSync(file, 0o644);
    const where = file.startsWith(HOME + "/") ? "~/" + path.relative(HOME, file) : file;
    const note = label === "video" ? " You can't watch videos yourself: say so if Angus wants it looked at, or hand it to a tool that can."
      : label === "audio" ? " You can't listen to audio yourself." : "";
    const line = `📎 ${label} saved: ${where} (${human(n)})${named ? `, shared as "${named}"` : ""}.${note}`;
    log("shot →", r, path.basename(file), n, label);
    return send(res, r, join(caption, line), [], { path: file, kind: label });
  }

  return {
    sawWorld(w) { if (/^[A-Z]$/.test(w || "")) lastWorld = w; },
    async handle(req, res, url) {
      if (req.method === "POST" && url.pathname === "/api/shot") { await shot(req, res, url); return true; }
      if (req.method === "GET" && url.pathname === "/api/shot/setup") {
        res.setHeader("cache-control", "no-store");
        const host = req.headers.host; // the address the phone reached us at (its tailnet name)
        json(res, 200, { url: `https://${host}/api/shot`, keyUrl: `https://${host}/api/shot?key=${getToken()}`, header: "X-Shot-Token", token: getToken(), world: lastWorld || getActive() || "" });
        return true;
      }
      return false;
    },
  };
}
