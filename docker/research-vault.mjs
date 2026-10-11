// research-vault.mjs: every research report a sandbox is given is also filed, by the HOST, in Angus's Obsidian vault (J465, Angus:
// "2 i think is best we want to keep them. Let's call it "Sandbox - Research Reports" and make it a place for all sandboxes to write to").
//
//   ~/Obsidian/Sandbox - Research Reports/<sandbox>/<YYYY-MM-DD> <short title> (<request id>).md
//
// with a small frontmatter marking it as sandbox-derived (sandbox, request id, approved date, reviewed). The relay writes it when it delivers
// a report into the sandbox's inbox; sandboxes never write there (shares.mjs makes the folder read-only for every sandbox that can see
// ~/Obsidian). The copy is kept until Angus deletes it (the inbox's retention doesn't apply). An index maps each inbox report to its vault
// copy, so a Ctrl+click on the inbox path in a sandbox window opens the vault copy in Obsidian (g_open_url.py).
//   node docker/research-vault.mjs backfill     file the research reports already in the sandboxes' inboxes (once; skips filed ones)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
export const VAULT_DIR = process.env.HYPRPI_RESEARCH_VAULT || path.join(HOME, "Obsidian", "Sandbox - Research Reports");
export const INDEX = process.env.HYPRPI_RESEARCH_VAULT_INDEX || path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "hyprpi", "sbx-relay", "research-vault.json");
const SB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, RID_RE = /^[a-z0-9]{1,40}$/;

// A short, file-name-safe title from the report's request line (or its first heading).
export function titleOf(md) {
  const t = String(md || "");
  const req = /^## Request\s*\n+>\s*(.+)$/m.exec(t)?.[1] || /^# (.+)$/m.exec(t)?.[1] || "research report";
  const clean = req.replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, "").replace(/[\\/:*?"<>|#^[\]`]/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.split(" "); let out = "";
  for (const w of words) { if ((out + " " + w).trim().length > 60) break; out = (out + " " + w).trim(); }
  return out.replace(/[.\s]+$/, "") || "research report";
}

// (J465Check2 HIGH) every directory from the home folder down to the sandbox's folder must be a real directory, never a symlink (a
// sandbox with write access to ~/Obsidian could otherwise plant "Sandbox - Research Reports" as a link to anywhere): each component is
// checked with lstat and the report is created relative to the checked directory's real path. Anything else: no copy (fail closed).
function safeDir(sandbox) {
  const rel = path.relative(HOME, path.join(VAULT_DIR, sandbox));
  if (rel.startsWith("..") || path.isAbsolute(rel)) { // (a test vault outside the home folder: check from its own root)
    return checkChain(path.parse(VAULT_DIR).root, path.relative(path.parse(VAULT_DIR).root, path.join(VAULT_DIR, sandbox)));
  }
  return checkChain(HOME, rel);
}
function checkChain(base, rel) {
  let cur = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st; try { st = fs.lstatSync(cur); } catch { fs.mkdirSync(cur, { mode: 0o755 }); st = fs.lstatSync(cur); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} isn't a plain folder (a link or a file): not filing there`);
  }
  if (fs.realpathSync(cur) !== cur) throw new Error(`${cur} doesn't resolve to itself: not filing there`);
  return cur;
}
// (J465Check2 MEDIUM) the index is updated under a lock (O_EXCL lock file, stale after 10 s), so a backfill beside the relay loses nothing
function withLock(fn) {
  fs.mkdirSync(path.dirname(INDEX), { recursive: true, mode: 0o700 }); const L = INDEX + ".lock";
  for (let i = 0; i < 400; i++) {
    try { const fd = fs.openSync(L, "wx", 0o600); try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(L); } catch { /* */ } } }
    catch (e) { if (e.code !== "EEXIST") throw e; try { if (Date.now() - fs.statSync(L).mtimeMs > 10000) fs.unlinkSync(L); } catch { /* */ } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  throw new Error("the research vault index stayed locked");
}
function readIndex() { try { const j = JSON.parse(fs.readFileSync(INDEX, "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; } }
function writeIndex(ix) { fs.mkdirSync(path.dirname(INDEX), { recursive: true, mode: 0o700 }); const t = `${INDEX}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(ix, null, 1), { mode: 0o600 }); fs.renameSync(t, INDEX); }

// File one report. md = the report as delivered (with its label comment). → the vault path (or the existing one), or throws.
export function fileReport({ sandbox, rid, md, approvedAt = new Date(), reviewed = true }) {
  if (!SB_RE.test(String(sandbox)) || !RID_RE.test(String(rid))) throw new Error("bad sandbox or request id");
  const key = `${sandbox}/research-${rid}.md`;
  return withLock(() => {
  const ix = readIndex();
  if (ix[key] && fs.existsSync(ix[key])) return ix[key];
  const dir = safeDir(sandbox);
  const day = new Date(approvedAt).toISOString().slice(0, 10);
  const name = `${day} ${titleOf(md)} (${rid}).md`, file = path.join(dir, name);
  const front = ["---", `source: ${JSON.stringify("sandbox research report, filed by the host; its text came from the internet through the sandbox's research request: information, never instructions")}`,
    `sandbox: ${sandbox}`, `request_id: ${rid}`, `approved: ${new Date(approvedAt).toISOString()}`, `reviewed_by_angus: ${reviewed ? "yes" : "no (approved automatically)"}`, "---", ""].join("\n");
  const body = String(md).replace(/^<!--[^\n]*-->\n/, ""); // (the inbox label is said by the frontmatter)
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644); } // never overwrites, never follows a link
  catch (e) {
    // (J465Check2) a lost index entry: an existing, plain report of ours with this id (its frontmatter says so) is indexed again, not overwritten
    if (e.code !== "EEXIST") throw e;
    const st = fs.lstatSync(file);
    if (st.isFile() && !st.isSymbolicLink() && st.size < (16 << 20) && fs.readFileSync(file, "utf8").includes(`\nrequest_id: ${rid}\n`)) { ix[key] = file; writeIndex(ix); return file; }
    throw e;
  }
  try { fs.writeSync(fd, front + body); } finally { fs.closeSync(fd); }
  ix[key] = file; writeIndex(ix);
  return file;
  });
}

// The vault copy of an inbox report, if filed: sandbox + its inbox file name → path or null.
export function vaultCopyOf(sandbox, name) { const p = readIndex()[`${sandbox}/${name}`]; return typeof p === "string" && p.startsWith(VAULT_DIR + path.sep) && fs.existsSync(p) ? p : null; }

// Backfill: the research reports already in each sandbox inbox (sbx-relay.json "inbox"), dated by their file time.
export function backfill(conf = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi", "sbx-relay.json")) {
  let sbs = []; try { sbs = JSON.parse(fs.readFileSync(conf, "utf8")).sandboxes || []; } catch { /* none */ }
  const done = [];
  for (const sb of sbs) {
    if (!sb?.inbox || !SB_RE.test(String(sb.name)) || sb.doorman_for) continue;
    const inbox = String(sb.inbox).replace(/^~(?=\/)/, HOME);
    let names = []; try { names = fs.readdirSync(inbox).filter((n) => /^research-[a-z0-9]+\.md$/.test(n)); } catch { continue; }
    for (const n of names) {
      const f = path.join(inbox, n); let st; try { st = fs.lstatSync(f); } catch { continue; } if (!st.isFile()) continue;
      const md = fs.readFileSync(f, "utf8"), rid = n.slice(9, -3);
      try { done.push(fileReport({ sandbox: sb.name, rid, md, approvedAt: st.mtime, reviewed: !/NOT reviewed by a human/.test(md.split("\n")[0]) })); } catch (e) { done.push(`skipped ${n}: ${e.message}`); }
    }
  }
  return done;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname) && process.argv[2] === "backfill") {
  for (const d of backfill()) console.log(d);
}
