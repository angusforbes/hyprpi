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
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
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
// (review J368 #1) a file read without following any symlink and without blocking on a FIFO: every directory component opened with
// O_NOFOLLOW|O_DIRECTORY (pinned by fd), the file itself with O_NOFOLLOW|O_NONBLOCK, fstat'ed as a regular file, read up to max.
// → { buf, size } or { error }. What it read is what is shown (hash) and what is delivered (a host-only snapshot): no second lookup.
export function pinnedRead(abs, max) {
  const parts = String(abs).split("/").filter(Boolean), C = fs.constants;
  let fd = fs.openSync("/", C.O_RDONLY | C.O_DIRECTORY), ffd = -1;
  try {
    for (const name of parts.slice(0, -1)) { const n = fs.openSync(`/proc/self/fd/${fd}/${name}`, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); fs.closeSync(fd); fd = n; }
    ffd = fs.openSync(`/proc/self/fd/${fd}/${parts.at(-1)}`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const st = fs.fstatSync(ffd);
    if (!st.isFile()) return { error: "not a regular file" };
    if (st.nlink > 1) return { error: "a hard-linked file isn't sent (it may be another file under a harmless name)" }; // (recheck: on the pinned descriptor)
    if (st.size > max) return { error: `over ${Math.round(max / (1 << 20))} MB` };
    const buf = Buffer.alloc(st.size); let off = 0;
    while (off < st.size) { const n = fs.readSync(ffd, buf, off, st.size - off, off); if (!n) break; off += n; }
    return { buf: buf.subarray(0, off), size: off };
  } catch (e) { return { error: e.code === "ELOOP" ? "a symlink is in the path" : e.code === "ENOENT" ? "no such file" : `can't read it (${e.code || e.message})` }; }
  finally { try { fs.closeSync(fd); } catch { /* */ } if (ffd >= 0) try { fs.closeSync(ffd); } catch { /* */ } }
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
    const html = ext === ".html" || ext === ".htm" || ext === ".svg"; // (red team J379 #5: SVG can carry scripts too)
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
    const hits = projectRoots(ctx.cfgDir).map((r) => path.join(r, project)).filter((d) => { try { const st = fs.lstatSync(d); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } });
    if (!hits.length) return { error: `project: no folder ${project} in the project folders` };
    if (hits.length > 1) return { error: `project: ${project} exists in more than one project folder; ambiguous` }; // (review J368 #4: the shown path is the one shared)
    const hit = hits[0], ino = fs.lstatSync(hit).ino;
    // (red team J379 #1) protected projects (config "protected", hyprpi's own checkout) and other sandboxes' workspaces are only ever read-only
    const conf = readJson(path.join(ctx.cfgDir, "config.json"), {}), relay = readJson(path.join(ctx.cfgDir, "sbx-relay.json"), {});
    const prot = [...(conf.protected || []).map((x) => path.resolve(tilde(x))), path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".."), ...(relay.sandboxes || []).filter((x) => x?.name !== ctx.served.name).map((x) => path.resolve(tilde(x.workspace || "/nonexistent")))];
    const isProt = prot.some((r) => under(hit, r) || under(r, hit));
    const eff = isProt ? "ro" : mode;
    return { params: { project, mode: eff, path: hit, ino }, show: `Share ${hit} with ${ctx.served.name}, ${eff === "rw" ? "WRITABLE" : "read-only"}${isProt && mode === "rw" ? " (asked writable; it's protected, so read-only is all that can be granted)" : ""}` };
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
    if (pp.stat.nlink > 1) return { error: "path: a hard-linked file isn't sent (it may be another file under a harmless name)" }; // (red team J379 #3)
    const rd = pinnedRead(pp.path, LIMITS.sendFileBytes);
    if (rd.error) return { error: `path: ${rd.error}` };
    const head = rd.buf.toString("latin1"); // (recheck: the whole file, at most 10 MB)
    if (/-----BEGIN [A-Z ]*(PRIVATE KEY|OPENSSH|PGP PRIVATE)|\b(sk-[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_|gho_[A-Za-z0-9]{20,}|xox[abprs]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)/.test(head)) return { error: "path: the file's content looks like a key or token" }; // (red team J379 #3: content, not just the name)
    const buf = rd.buf, sha = crypto.createHash("sha256").update(buf).digest("hex");
    // the bytes Angus is shown the hash of are the bytes delivered: a host-only snapshot (never re-read from the folder)
    if (!ctx.snapshotDir) return { error: "no snapshot folder" };
    fs.mkdirSync(ctx.snapshotDir, { recursive: true, mode: 0o700 });
    for (const n of fs.readdirSync(ctx.snapshotDir)) { try { if (Date.now() - fs.statSync(path.join(ctx.snapshotDir, n)).mtimeMs > 3 * 86400e3) fs.unlinkSync(path.join(ctx.snapshotDir, n)); } catch { /* */ } } // (held requests expire long before)
    const snap = path.join(ctx.snapshotDir, `${sha.slice(0, 16)}-${crypto.randomBytes(6).toString("hex")}.bin`); fs.writeFileSync(snap, buf, { mode: 0o600, flag: "wx" }); // one per request (recheck: identical requests never share one)
    const text = /^\.(txt|md|csv|json|xml|yaml|yml|tex|bib|log)$/.test(ext) ? buf.toString("utf8") : "";
    const nl = text ? text.split("\n").length : 0;
    const preview = text ? `\nFirst ${Math.min(8, nl)} of ${nl} lines${nl > 8 ? " (the rest isn't shown here)" : ""}, each cut at 160 characters:\n${text.split("\n").slice(0, 8).map((l) => "  " + l.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, "").slice(0, 160)).join("\n")}` : "";
    return { params: { path: pp.path, sha256: sha, size: buf.length, snapshot: snap }, show: `Send a read-only copy of ${pp.path} (${Math.ceil(pp.stat.size / 1024)} KB, sha256 ${sha.slice(0, 16)}…) into ${ctx.served.name}'s inbox${preview}` };
  },
  // 5. allow a web host for the sandbox (sbx policy, scoped to that one sandbox).
  allow_host(p) {
    const host = String(p.host ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (host.length > 100 || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) || /^[\d.]+$/.test(host) || !/[a-z]/.test(host.split(".").pop())) return { error: "host: a plain public domain name (no IP, port, path or wildcard)" };
    if (/(^|\.)(nvidia\.com|nvidia\.net|nvidiangn\.net|nvda\.ai|local|internal|lan|corp|localhost|home\.arpa)$/.test(host)) return { error: "host: internal hosts are never allowed this way" };
    // (red team J379 #4) a public name that resolves to a private, loopback or link-local address (127.0.0.1.sslip.io) is refused
    const ga = spawnSync("getent", ["ahosts", host], { encoding: "utf8", timeout: 5000 });
    const addrs = [...new Set(String(ga.stdout || "").split("\n").map((l) => l.split(/\s+/)[0]).filter(Boolean))];
    const v4bad = (a) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.|22[4-9]\.|2[3-5]\d\.)/.test(a);
    const v6bad = (a) => { const x = a.toLowerCase(); if (x.startsWith("::ffff:")) return v4bad(x.slice(7)); return x === "::" || x === "::1" || /^fe[89ab][0-9a-f]:/.test(x) || /^f[cd][0-9a-f]{2}:/.test(x) || /^ff[0-9a-f]{2}:/.test(x); }; // (recheck: fe80::/10, fc00::/7, multicast, mapped IPv4)
    if (addrs.some((a) => (a.includes(":") ? v6bad(a) : v4bad(a)))) return { error: `host: ${host} resolves to a private or local address (${addrs.slice(0, 2).join(", ")})` };
    return { params: { host }, show: `Allow ${"the sandbox"} to reach https://${host} (an sbx network rule for this sandbox only)` };
  },
};

export function validate(type, params, ctx) {
  if (!Object.hasOwn(TYPES, type)) return { ok: false, error: `unknown request type (${Object.keys(TYPES).join(", ")})` };
  const p = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const why0 = one(p.why, 4000); if (Buffer.byteLength(why0) > LIMITS.whyBytes) return { ok: false, error: `why: at most ${LIMITS.whyBytes} bytes` }; const why = why0; // (review J368 #8: bytes, not characters)
  if (type !== "note_to_owner" && !why) return { ok: false, error: "why: say why it's needed" };
  if (!takeRate(ctx.served.name, type, ctx.now || Date.now())) return { ok: false, error: `at most ${LIMITS.perHour[type]} ${TYPES[type]} requests an hour` }; // (re-review: admission before any snapshot is written)
  const v = V[type](p, ctx);
  if (v.error) return { ok: false, error: v.error };
  return { ok: true, params: { ...v.params, ...(why ? { why } : {}) }, show: v.show + (why ? `\nWhy (the sandbox's words): ${why}` : ""), summary: `${TYPES[type]}` };
}

export async function run(type, p, ctx) {
  try {
    switch (type) {
      case "open_for_owner": {
        const r = await ctx.openUrl(p.kind === "file" ? pathToFileURL(p.what).href : p.what); // (review J368 #3: # and ? in a file name are escaped)
        return r.ok ? { ok: true, outcome: `handed ${p.what} to ${ctx.served.name}'s own Brave window${r.text ? ` (${one(r.text, 120)})` : ""}` } : { ok: false, outcome: `not opened: ${one(r.text, 300)}` };
      }
      case "note_to_owner": return { ok: true, outcome: "Angus has read the note" };
      case "share_project": {
        // (re-review J368 #4, red team J379 #2) the approved folder or nothing: the same single path and the same inode as reviewed
        const now2 = projectRoots(ctx.cfgDir).map((r) => path.join(r, p.project)).filter((d) => { try { const st = fs.lstatSync(d); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } });
        if (now2.length !== 1 || now2[0] !== p.path || (p.ino && fs.lstatSync(p.path).ino !== p.ino)) return { ok: false, outcome: `not shared: ${p.project} is no longer exactly the folder Angus saw (${p.path})` };
        const r = await ctx.addProject(p.project, p.mode, { realpath: p.path, ino: p.ino }); // (shares.mjs J379fix checks it again under its own lock)
        return { ok: !!r.ok, outcome: r.ok ? `listed for sharing: ${one(r.text, 360)}` : `not shared: ${one(r.text, 300)}` }; } // (review J368 #4: the share module's own words: level, effective mode, when it mounts)
      case "send_file": {
        const buf = fs.readFileSync(p.snapshot); // the host-only snapshot taken when Angus was shown it
        if (crypto.createHash("sha256").update(buf).digest("hex") !== p.sha256) return { ok: false, outcome: "not sent: the snapshot doesn't match what Angus saw" };
        const name = `file-${crypto.randomBytes(4).toString("hex")}-${path.basename(p.path).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}`;
        const where = ctx.putInbox(name, buf);
        return { ok: true, outcome: `a read-only copy of ${p.path} is in the inbox: ${where}` };
      }
      case "allow_host": { const r = await ctx.policyAllow(p.host); return { ok: !!r.ok, outcome: r.ok ? `a local sbx rule allows ${p.host} for ${ctx.served.name}${r.check ? `; sbx policy check says: ${one(r.check, 160)}` : ""}` : `not allowed: ${one(r.text, 300)}` }; } // (review J368 #5)
      default: return { ok: false, outcome: "unknown type" };
    }
  } catch (e) { return { ok: false, outcome: `failed: ${one(e.message, 300)}` }; }
}
