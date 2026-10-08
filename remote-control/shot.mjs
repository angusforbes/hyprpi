// J250 (Angus: "take a screenshot with my phone and send it to you very easily"): a screenshot from the
// iPhone's share sheet, through an iOS Shortcut, straight to a world's Thoughts.
//
//   POST /api/shot?world=D&caption=…   the image as the raw body (png / jpeg / heic / webp / gif)
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

const MB = 1 << 20, MAX = 40 * MB;

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
  const tokenOk = (req) => {
    const t = Buffer.from(String(req.headers["x-shot-token"] || "")), k = Buffer.from(getToken());
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
  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
  function freeName(base, ext) {
    for (let i = 1; i < 1000; i++) { const f = path.join(UPLOAD_DIR, `${base}${i > 1 ? ` (${i})` : ""}.${ext}`); if (!fs.existsSync(f)) return f; }
    throw new Error("no free name");
  }
  const vips = (inp, out) => new Promise((res, rej) => execFile("vipsthumbnail", [inp, "--size", "2048x2048>", "-o", `${out}[Q=85,strip]`], { timeout: 30000 }, (e) => e ? rej(e) : res()));

  async function readBody(req) {
    const len = Number(req.headers["content-length"] || 0);
    if (len > MAX) throw Object.assign(new Error(`larger than ${MAX / MB} MB`), { status: 413 });
    const parts = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX) throw Object.assign(new Error(`larger than ${MAX / MB} MB`), { status: 413 }); parts.push(c); }
    return Buffer.concat(parts);
  }

  async function shot(req, res, url) {
    if (!tokenOk(req)) { log("shot: refused (token)", req.headers["tailscale-user-login"] || req.socket.remoteAddress); return json(res, 403, { error: "bad token" }); }
    const api = getApi(); if (!api) return json(res, 503, { error: "hyprpi daemon not reachable" });
    const asked = String(url.searchParams.get("world") || "").trim().toUpperCase();
    const r = asked && asked !== "AUTO" ? room(asked) : room(lastWorld) || room(getActive());
    if (!r) return json(res, 400, { error: `no world ${asked}` });
    const caption = String(url.searchParams.get("caption") ?? (() => { const h = String(req.headers["x-caption"] || ""); try { return decodeURIComponent(h); } catch { return h; } })()).trim().slice(0, 4000);
    let b; try { b = await readBody(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    const k = kind(b); if (!b.length || !k) return json(res, 415, { error: "not an image (png, jpeg, heic, webp or gif)" });
    try { const st = fs.lstatSync(UPLOAD_DIR); if (!st.isDirectory() || st.isSymbolicLink()) throw 0; } catch { return json(res, 500, { error: "~/Phone is not a plain folder" }); }
    const base = `screenshot-${stamp()}`;
    let file;
    if (k === "heic" || k === "avif" || b.length > 5 * MB) { // the model takes ≤ ~5 MB; Thoughts takes png/jpeg/webp/gif
      const tmp = path.join(UPLOAD_DIR, `.shot-${randomBytes(6).toString("hex")}.${k}`);
      fs.writeFileSync(tmp, b, { mode: 0o644 });
      try { file = freeName(base, "jpg"); await vips(tmp, file); } catch (e) { return json(res, 500, { error: "couldn't convert the image: " + (e.message || e) }); } finally { fs.rmSync(tmp, { force: true }); }
    } else { file = freeName(base, k); fs.writeFileSync(file, b, { flag: "wx", mode: 0o644 }); }
    const dim = imgSize(fs.readFileSync(file).subarray(0, 256 << 10));
    log("shot →", r, path.basename(file), b.length, caption ? JSON.stringify(caption.slice(0, 60)) : "");
    try { await api.call("thoughts.send", { room: r, text: caption, images: [file], via: "phone" }); }
    catch (e) { return json(res, 502, { error: "saved as " + file + " but not sent: " + e.message, path: file }); }
    return json(res, 200, { ok: true, world: r, path: file, ...(dim ? { w: dim.w, h: dim.h } : {}), message: `Sent to Thoughts-${r}` });
  }

  return {
    sawWorld(w) { if (/^[A-Z]$/.test(w || "")) lastWorld = w; },
    async handle(req, res, url) {
      if (req.method === "POST" && url.pathname === "/api/shot") { await shot(req, res, url); return true; }
      if (req.method === "GET" && url.pathname === "/api/shot/setup") {
        res.setHeader("cache-control", "no-store");
        const host = req.headers.host; // the address the phone reached us at (its tailnet name)
        json(res, 200, { url: `https://${host}/api/shot`, header: "X-Shot-Token", token: getToken(), world: lastWorld || getActive() || "" });
        return true;
      }
      return false;
    },
  };
}
