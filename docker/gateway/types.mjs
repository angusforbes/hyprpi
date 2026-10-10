// J368 (Angus: "build the agent free gateway"; design: ~/Obsidian/Papers/Doorman/agent-free-gateway.md): the fixed request
// types a sandbox's Doorman can draft for Angus. Each type has fixed parameters, code checks (validate), a plain text for
// Angus's decision (show) and a host-code handler (run) that carries it out after HIS approval in the Doorman window. No
// host agent is involved anywhere: in an agent-free setup these, plus research, GPU leases and task changes, are all a
// sandbox can ask for.
//
//   validate(type, params, ctx) → { ok: true, params, show, summary } | { ok: false, error }     (at draft time, in the relay)
//   run(type, params, ctx)      → Promise<{ ok, outcome, detail? }>                               (after approval, in the relay)
//
// ctx (from docker/sbx-relay.mjs): { served: { name, cfg }, cfgDir, now, openUrl(url) → { ok, text }, putInbox(name, buf) → path,
//   policyAllow(host) → { ok, text }, sharesApply() → { ok, text }, addProject(project, mode) → { ok, text } }
// Every text a sandbox gave (why, note) is shown to Angus as the sandbox's words; nothing here runs a model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { cleanSource } from "../research/research.mjs";

const HOME = os.homedir();
const tilde = (p) => String(p || "").replace(/^~(?=\/|$)/, HOME);
const one = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim().slice(0, n);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

export const TYPES = {
  open_for_owner: "open a link or file for Angus",
  note_to_owner: "a note for Angus",
  share_project: "share a project",
  send_file: "send a host file into the inbox",
  allow_host: "allow a web host",
};
export const LIMITS = { whyBytes: 1500, noteBytes: 1500, openFileBytes: 20 << 20, sendFileBytes: 10 << 20, perHour: { open_for_owner: 6, note_to_owner: 10, share_project: 3, send_file: 6, allow_host: 3 } };
export const OPEN_EXT = new Set([".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".txt", ".md"]);
export const SEND_EXT = new Set([".txt", ".md", ".csv", ".json", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".html", ".htm", ".xml", ".yaml", ".yml", ".tex", ".bib", ".log"]);
// names that look like secrets are never sent, whatever folder they are in
const SECRET_RE = /(^|[._-])(id_(rsa|ed25519|ecdsa|dsa)|secret|secrets|token|tokens|credential|credentials|passwd|password|private|apikey|api[_-]?key|\.env|netrc|npmrc|pypirc|htpasswd|keystore|keychain|wallet)([._-]|$)|\.(pem|key|p12|pfx|kdbx|gpg|asc|ovpn)$/i;

// The unsupported answer (relay and Doorman prompt say the same).
export const UNSUPPORTED = "That isn't something this host can do: it has no agent to carry it out, only these request types: open a link or file for Angus, a note for Angus, share a project, send a host file into the inbox, allow a web host, change the research task, or a GPU lease. If one of those fits, the Doorman can draft it; otherwise send Angus a note.";

// Per-Doorman hourly counts (in memory: a relay restart resets them; the relay's circuit breaker also applies).
const counts = new Map();
function takeRate(key, type, now) {
  const k = `${key}:${type}`, l = (counts.get(k) || []).filter((t) => now - t < 3600e3);
  if (l.length >= LIMITS.perHour[type]) return false;
  l.push(now); counts.set(k, l); return true;
}

// A host path (absolute, no "..", no hidden component, no symlink anywhere) → its real stat, or an error.
function plainPath(p) {
  const s = String(p || "");
  if (!s.startsWith("/") || s.length > 1024 || /[\u0000-\u001f\u007f]/.test(s)) return { error: "an absolute host path is needed" };
  const parts = s.split("/").filter(Boolean);
  if (parts.some((x) => x === ".." || x === "." || x.startsWith("."))) return { error: "no hidden or relative path components" };
  let cur = "";
  for (const x of parts) { cur += "/" + x; let st; try { st = fs.lstatSync(cur); } catch { return { error: "no such file" }; } if (st.isSymbolicLink()) return { error: "a symlink is in the path" }; }
  return { path: "/" + parts.join("/"), stat: fs.statSync("/" + parts.join("/")) };
}
const under = (p, root) => { const r = path.resolve(root); return p === r || p.startsWith(r + "/"); };
function projectRoots(cfgDir) { return (readJson(path.join(cfgDir, "config.json"), {}).projectFolders || []).map((x) => path.resolve(tilde(x))); }
function roleRoots(cfgDir) { const r = readJson(path.join(cfgDir, "config.json"), {}).roleFolders || {}; return Object.values(r).filter((x) => typeof x === "string").map((x) => path.resolve(tilde(x))); }

const V = {
  // 1. open a link or file for Angus: an https link (cleaned like research sources), or a file:// / absolute path to a file of an
  //    allowed type inside a project folder. The handler opens it in the sandbox world's OWN Brave profile (no logins, no focus)
  //    through docker/world/g_open_url.py --agent, which checks again that the file is shared with the sandbox and opens a snapshot.
  open_for_owner(p, ctx) {
    const what = String(p.what ?? "").trim();
    if (!what || what.length > 2048) return { error: "what: a link or a file path" };
    if (/^https?:\/\//i.test(what)) {
      const url = cleanSource(what);
      if (!url) return { error: "not a plain https link (plain host, ordinary path; no IP, port or login)" };
      return { params: { what: url, kind: "link" }, show: `Open in ${ctx.served.name}'s own Brave window: ${url}${url !== what ? ` (cleaned from the link given: its query or fragment was dropped)` : ""}` };
    }
    let fp = what.startsWith("file://") ? (() => { try { return decodeURIComponent(new URL(what).pathname); } catch { return ""; } })() : what;
    const pp = plainPath(fp);
    if (pp.error) return { error: `file: ${pp.error}` };
    if (!pp.stat.isFile()) return { error: "file: not a regular file" };
    const ext = path.extname(pp.path).toLowerCase();
    if (!OPEN_EXT.has(ext)) return { error: `file: ${ext || "no extension"} isn't a type that is opened (${[...OPEN_EXT].join(" ")})` };
    if (pp.stat.size > LIMITS.openFileBytes) return { error: "file: over 20 MB" };
    if (!projectRoots(ctx.cfgDir).some((r) => under(pp.path, r))) return { error: "file: not inside a project folder" };
    const html = ext === ".html" || ext === ".htm";
    return { params: { what: pp.path, kind: "file" }, show: `Open in ${ctx.served.name}'s own Brave window: ${pp.path} (${Math.ceil(pp.stat.size / 1024)} KB${html ? "; a page the sandbox can write: its scripts run in that browser profile, which has none of your logins" : ""}; it opens only if the file is shared with the sandbox, which the link gate checks again)` }; // (review J368 LOW: the draft check is project folders; the run-time gate checks the actual shares)
  },
  // 2. a note for Angus: shown, nothing runs.
  note_to_owner(p) {
    const text = String(p.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, "").trim();
    if (!text || Buffer.byteLength(text) > LIMITS.noteBytes) return { error: `text: 1 to ${LIMITS.noteBytes} bytes` };
    return { params: { text }, show: `A note for you (approve = "read it"; nothing runs):\n${text}` };
  },
  // 3. share a project, at a share level the host config allows (the handler calls the share module; J366 owns the levels).
  share_project(p, ctx) {
    const project = String(p.project ?? "").trim(), mode = String(p.mode || "ro");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project)) return { error: "project: a folder name" };
    if (!["ro", "rw"].includes(mode)) return { error: "mode: ro or rw" };
    const hit = projectRoots(ctx.cfgDir).map((r) => path.join(r, project)).find((d) => { try { const st = fs.lstatSync(d); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } });
    if (!hit) return { error: `project: no folder ${project} in the project folders` };
    return { params: { project, mode, path: hit }, show: `Share ${hit} with ${ctx.served.name}, ${mode === "rw" ? "WRITABLE" : "read-only"}` };
  },
  // 4. send a host file into the sandbox's inbox (a read-only copy).
  send_file(p, ctx) {
    const pp = plainPath(String(p.path ?? "").trim());
    if (pp.error) return { error: `path: ${pp.error}` };
    if (!pp.stat.isFile()) return { error: "path: not a regular file" };
    const ext = path.extname(pp.path).toLowerCase(), base = path.basename(pp.path);
    if (SECRET_RE.test(base) || pp.path.split("/").some((x) => SECRET_RE.test(x))) return { error: "path: looks like a secret (keys, tokens, credentials, .env …)" };
    if (!SEND_EXT.has(ext)) return { error: `path: ${ext || "no extension"} isn't a type that is sent (${[...SEND_EXT].join(" ")})` };
    if (pp.stat.size > LIMITS.sendFileBytes) return { error: "path: over 10 MB" };
    if (![...projectRoots(ctx.cfgDir), ...roleRoots(ctx.cfgDir)].some((r) => under(pp.path, r))) return { error: "path: not inside a project or role folder" };
    const buf = fs.readFileSync(pp.path), sha = crypto.createHash("sha256").update(buf).digest("hex");
    const text = /^\.(txt|md|csv|json|xml|yaml|yml|tex|bib|log)$/.test(ext) ? buf.toString("utf8") : "";
    const preview = text ? `\nFirst lines:\n${text.split("\n").slice(0, 8).map((l) => "  " + l.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, "").slice(0, 160)).join("\n")}` : "";
    return { params: { path: pp.path, sha256: sha, size: pp.stat.size }, show: `Send a read-only copy of ${pp.path} (${Math.ceil(pp.stat.size / 1024)} KB, sha256 ${sha.slice(0, 16)}…) into ${ctx.served.name}'s inbox${preview}` };
  },
  // 5. allow a web host for the sandbox (sbx policy, scoped to that one sandbox).
  allow_host(p) {
    const host = String(p.host ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (host.length > 100 || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) || /^[\d.]+$/.test(host) || !/[a-z]/.test(host.split(".").pop())) return { error: "host: a plain public domain name (no IP, port, path or wildcard)" };
    if (/(^|\.)(nvidia\.com|nvidia\.net|nvidiangn\.net|nvda\.ai|local|internal|lan|corp|localhost|home\.arpa)$/.test(host)) return { error: "host: internal hosts are never allowed this way" };
    return { params: { host }, show: `Allow ${"the sandbox"} to reach https://${host} (an sbx network rule for this sandbox only)` };
  },
};

export function validate(type, params, ctx) {
  if (!Object.hasOwn(TYPES, type)) return { ok: false, error: `unknown request type (${Object.keys(TYPES).join(", ")})` };
  const p = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const why = one(p.why, LIMITS.whyBytes);
  if (type !== "note_to_owner" && !why) return { ok: false, error: "why: say why it's needed" };
  const v = V[type](p, ctx);
  if (v.error) return { ok: false, error: v.error };
  if (!takeRate(ctx.served.name, type, ctx.now || Date.now())) return { ok: false, error: `at most ${LIMITS.perHour[type]} ${TYPES[type]} requests an hour` };
  return { ok: true, params: { ...v.params, ...(why ? { why } : {}) }, show: v.show + (why ? `\nWhy (the sandbox's words): ${why}` : ""), summary: `${TYPES[type]}` };
}

export async function run(type, p, ctx) {
  try {
    switch (type) {
      case "open_for_owner": {
        const r = await ctx.openUrl(p.kind === "file" ? "file://" + encodeURI(p.what) : p.what);
        return r.ok ? { ok: true, outcome: `opened ${p.what} in ${ctx.served.name}'s own Brave window` } : { ok: false, outcome: `not opened: ${one(r.text, 300)}` };
      }
      case "note_to_owner": return { ok: true, outcome: "Angus has read the note" };
      case "share_project": { const r = await ctx.addProject(p.project, p.mode); return { ok: !!r.ok, outcome: r.ok ? `${p.path} is shared ${p.mode === "rw" ? "writable" : "read-only"}: ${one(r.text, 300)}` : `not shared: ${one(r.text, 300)}` }; }
      case "send_file": {
        const buf = fs.readFileSync(p.path);
        if (crypto.createHash("sha256").update(buf).digest("hex") !== p.sha256) return { ok: false, outcome: "not sent: the file changed since Angus saw it" };
        const name = `file-${crypto.randomBytes(4).toString("hex")}-${path.basename(p.path).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}`;
        const where = ctx.putInbox(name, buf);
        return { ok: true, outcome: `a read-only copy of ${p.path} is in the inbox: ${where}` };
      }
      case "allow_host": { const r = await ctx.policyAllow(p.host); return { ok: !!r.ok, outcome: r.ok ? `${p.host} is allowed for ${ctx.served.name}${r.text ? ` (${one(r.text, 200)})` : ""}` : `not allowed: ${one(r.text, 300)}` }; }
      default: return { ok: false, outcome: "unknown type" };
    }
  } catch (e) { return { ok: false, outcome: `failed: ${one(e.message, 300)}` }; }
}
