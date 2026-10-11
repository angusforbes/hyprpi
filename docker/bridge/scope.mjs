// scope.mjs: what a host job may touch (J428, Angus: "the host has access to all the files, and the sandbox has access to many
// folders, why do they need to be specified in the request? … 1 yes").
//
// The baseline is the sandbox's own shares, with the same rights: what shares.mjs plan mounts for its world (read-write where
// the sandbox may write, read-only where it may only read: protected projects, inboxes, other workspaces), and its hidden
// gitignored paths stay unreadable. A draft names folders only when it needs something BEYOND those shares (or write access
// where the sandbox has read); those are checked (inside the home folder, never the home folder itself, no hidden or
// credential folders, never write to a protected path or a folder holding one, at most MAX_EXTRA) and shown to the owner
// prominently. Tools come from ALLOWED_TOOLS (none named: Read, Glob, Grep, Write, Edit); Bash only when named, and the
// held item says it isn't limited to the folders.
//
// checkScope({ folders, tools }, { home, shares }) → { ok, folders: [{ path, access, share }], hidden: [paths], tools, beyond, text }
//   shares: { mounts: [{ host, ro }], hidden: [{ path }] } (shares.mjs plan WORLD --json), or null when unknown (fail closed:
//   no baseline and no write access anywhere).
// The relay calls it at draft time (a refusal goes straight back to the Doorman) and again at approval (the shares and the
// folders as they are then). The runner enforces the result: --add-dir for each folder, Write/Edit denied in the read-only
// ones, Read denied for the hidden paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_EXTRA = 4;
export const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];
const WRITERS = new Set(["Write", "Edit"]);
const CRED = /^(\.?ssh|\.?gnupg|\.?gpg|keys?|secrets?|credentials?|\.?password-store|\.?aws|\.?azure|\.?kube|\.?docker|tokens?|keyrings?|\.?pki|vault)$/i;
// (J428Review HIGH) characters Claude Code's permission-rule parser or its globs treat specially: a path holding one can't be put in a
// deny rule safely, so such a folder is refused here and dropped by the runner (with whatever share it would weaken)
export const UNSAFE = /[()[\]{}*?,\\"'`]/;
const under = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function checkScope(raw = {}, { home = os.homedir(), shares = null } = {}) {
  const no = (text) => ({ ok: false, text });
  const H = fs.realpathSync(home);
  const inF = raw.folders == null ? [] : raw.folders, inT = raw.tools == null ? [] : raw.tools;
  if (!Array.isArray(inF) || !Array.isArray(inT)) return no("folders and tools must be lists");
  if (inF.length > MAX_EXTRA) return no(`at most ${MAX_EXTRA} folders beyond the sandbox's shares per job`);
  // the baseline: the sandbox's shares with its rights; unknown shares → none, and every path counts as protected
  const known = !!(shares && Array.isArray(shares.mounts));
  const mounts = known ? shares.mounts.filter((m) => m && typeof m.host === "string" && path.isAbsolute(m.host)).map((m) => ({ path: realOr(m.host), ro: !!m.ro })) : [];
  // read-only for host jobs: the sandbox's read-only mounts AND every protected path, also one no share covers (hyprpi's own
  // checkout, agent-config, projects the host runs: a host job never writes there)
  const roPaths = known ? [...new Set([...mounts.filter((m) => m.ro).map((m) => m.path), ...(Array.isArray(shares.protected) ? shares.protected : []).filter((p) => typeof p === "string" && path.isAbsolute(p)).map(realOr)])] : [H];
  const hidden = known ? [...new Set((shares.hidden || []).map((h) => String(h?.path || "")).filter((p) => path.isAbsolute(p)).map(realOr))] : []; // (J428Check: canonical, like the mounts)
  const readable = (r) => mounts.some((m) => under(r, m.path));
  const writable = (r) => mounts.some((m) => !m.ro && under(r, m.path)) && !roPaths.some((q) => under(r, q) || under(q, r));
  const folders = mounts.map((m) => ({ path: m.path, access: m.ro ? "read" : "write", share: true }));
  const beyond = [];
  for (const f of inF) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return no("each folder is { path, access }");
    const access = f.access === "write" ? "write" : f.access === "read" ? "read" : null;
    if (!access) return no(`folder access must be "read" or "write" (${JSON.stringify(String(f.access ?? "")).slice(0, 40)})`);
    let p = String(f.path ?? "");
    if (!p || p.length > 300 || /[\x00-\x1f\x7f]/.test(p)) return no("a folder path is empty, too long or has control characters");
    if (UNSAFE.test(p)) return no(`${p.slice(0, 120)}: has a character the agent's permission rules can't hold safely ( ) [ ] { } * ? , \\ or quotes: rename the folder, or use its parent`);
    if (p === "~" || p.startsWith("~/")) p = path.join(H, p.slice(1));
    if (!path.isAbsolute(p)) return no(`${p.slice(0, 120)}: not an absolute host path`);
    let r; try { r = fs.realpathSync(p); } catch { return no(`${p.slice(0, 120)}: no such folder on the host`); }
    if (!fs.statSync(r).isDirectory()) return no(`${p.slice(0, 120)}: not a folder`);
    if (UNSAFE.test(r)) return no(`${r.slice(0, 120)}: its real path has a character the agent's permission rules can't hold safely`);
    if (r !== path.resolve(p)) { /* a symlink (or ..) on the way: judged by where it really leads (r); the owner is shown r */ }
    if (!under(r, H) || r === H) return no(`${p.slice(0, 120)}: only folders inside the home folder, never the home folder itself or above it`);
    const parts = path.relative(H, r).split(path.sep);
    if (parts.some((c) => c.startsWith("."))) return no(`${p.slice(0, 120)}: hidden (dot) folders aren't allowed (settings, keys, caches)`);
    if (parts.some((c) => CRED.test(c))) return no(`${p.slice(0, 120)}: looks like a credentials folder`);
    if (access === "write") {
      const hit = roPaths.find((q) => under(r, q) || under(q, r));
      if (hit) return no(`${p.slice(0, 120)}: write access refused: ${under(r, hit) ? "the sandbox has it read-only (protected)" : `it holds ${hit}, which the sandbox has read-only (protected)`}; read is fine`);
    }
    if (access === "read" ? readable(r) : writable(r)) continue; // already within the shares with those rights
    // J442 (Angus "1b yes"): write access beyond the shares is never granted to a whole top-level folder (~/Documents, ~/Work…):
    // it would cover everything in it. Refused, so the proposal names the subfolder (read stays possible).
    if (access === "write" && parts.length === 1) return no(`${r}: write access to a whole top-level folder isn't granted; name the subfolder the job writes in (read is fine)`);
    const seen = beyond.find((x) => x.path === r);
    if (seen) { if (access === "write") seen.access = "write"; continue; }
    const st = fs.statSync(r); beyond.push({ path: r, access, share: false, id: `${st.dev}:${st.ino}` }); // (J428Review) its identity: what Angus approves is THIS folder
  }
  // a beyond folder inside a hidden path would un-hide it: refused (the sandbox can't see it either)
  for (const b of beyond) { const h = hidden.find((x) => under(b.path, x) || under(x, b.path)); if (h) return no(`${b.path}: it is or holds a hidden (gitignored) path the sandbox can't see (${h})`); }
  const all = [...folders, ...beyond];
  const anyWrite = all.some((x) => x.access === "write");
  let tools = [];
  for (const t of inT) {
    const s = String(t);
    if (!ALLOWED_TOOLS.includes(s)) return no(`tool ${JSON.stringify(s).slice(0, 40)} isn't allowed (${ALLOWED_TOOLS.join(", ")})`);
    if (!tools.includes(s)) tools.push(s);
  }
  if (!inT.length) tools = all.length ? ["Read", "Glob", "Grep", ...(anyWrite ? ["Write", "Edit"] : [])] : []; // (no folders at all: no file tools)
  if (tools.some((t) => WRITERS.has(t)) && !anyWrite && !raw.pending) return no("Write or Edit needs a folder with write access"); // (pending: a folder beyond the shares is still to be found)
  if (tools.some((t) => t !== "Bash") && !all.length) return no("file tools need at least one folder");
  return { ok: true, folders: all, hidden, tools, beyond, bash: tools.includes("Bash"), text: describe({ shares: folders, beyond, tools, world: raw.world, known }) };
}

// The lines the owner sees in the held item: the shares briefly, anything beyond them prominently.
export function describe({ shares = [], beyond = [], tools = [], world = "", known = true }) {
  const w = world ? world.replace(/^world-/, "").toUpperCase() : "the sandbox";
  const nRw = shares.filter((x) => x.access === "write").length;
  const base = known ? `Folders: ${w}'s shares (${shares.length} folders, ${nRw} writable; the same rights as the sandbox, its hidden files stay hidden)` : `Folders: ${w}'s shares are unknown right now, so none (and no write access)`;
  const extra = beyond.length ? `\n⚠ BEYOND ${w}'s SHARES: ${beyond.map((x) => `${x.path} (${x.access === "write" ? "read and WRITE" : "read only"})`).join("; ")}` : "";
  const t = `\nTools: ${tools.length ? tools.join(", ") : "none besides the bridge"}${tools.includes("Bash") ? " (⚠ Bash runs any command as you and isn't limited to these folders)" : ""}`;
  return base + extra + t;
}

// The sandbox's shares for a world (shares.mjs plan WORLD --json); null when they can't be read.
export function sharesFor(world, { sharesCli, run }) {
  try { const j = JSON.parse(run(process.execPath, [sharesCli, "plan", world, "--json"])); return Array.isArray(j.mounts) ? j : null; } catch { return null; }
}
