#!/usr/bin/env node
// Sandbox folder sharing from config, and the host card (J307; design: agent-config docs/sandbox/
// sandbox-shares-design.md and doorman-design.md).
//
//   shares.mjs plan  [WORLD]   print what would be mounted (and what's hidden), change nothing
//   shares.mjs apply [WORLD]   mount what's missing (sbx mount works on a running sandbox), write the host card
//   shares.mjs card  [WORLD]   only (re)write the host card
//   shares.mjs watch [WORLD]   apply now, then again whenever the config or a project folder's contents change
//
// Config. Global, in ~/.config/hyprpi/config.json:
//   "projectFolders": ["~/Work"]                 where projects live (default: none)
//   "protected": ["~/Harness/agent-config"]         always read-only (hyprpi's own checkout is added anyway)
//   "roleFolders": { "screenshots": "~/Screenshots", "jot": "~/Obsidian", "downloads": "~/Downloads" }
//                                                (defaults: screenshotsDir, the jot root, ~/Downloads)
// Per sandbox, in ~/.config/hyprpi/worlds/<world>.json:
//   "roles": { "screenshots": true, "jot": true, "downloads": { "at": "/elsewhere" } }   (default: all OFF)
//   "projects": "all" | ["vibezAI", "kev"]       "all" = every projectFolder, writable, incl. later projects
//   "shares": [ { "path": "~/Music", "mode": "ro", "at": "/data/music" } ]
//   "gitignored": { "hide": true, "show": ["kids-mazes", "nim-demos/.env.example"] }   (default: hide)
//   "doorman": { "mode": "doorman-safe" }        J325 research mode: doorman-strict, doorman-safe (default) or doorman-open (docker/research/mode.mjs)
//
// Rules: every share is mounted at its host path unless "at" says otherwise; protected projects (and every
// relay inbox, and other sandboxes' workspaces) are mounted read-only on top of a writable parent; sbx enforces
// read-only per shared path on the host side, so that holds even against guest root (J278, J304 tests).
// Gitignored files in shared git projects are covered by an empty read-only placeholder. LIMIT: that hides them
// from ordinary reads only. Guest root can unmount a placeholder, and the parent's /mnt/host/home alias still
// shows them; ignored files created after the last apply stay visible until the next one (watch re-applies).
// Build output (node_modules, dist, .venv, …) is not hidden: it isn't secret and builds need it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { modeForSandbox, MODE_TEXT } from "../research/mode.mjs"; // J325: the Doorman mode in the host card


const HOME = os.homedir();
const CFG = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi");
const STATE = path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "hyprpi", "sandboxes");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");   // this hyprpi checkout
const RUNTIMES = path.join(HOME, ".local", "state", "sandboxes", "sandboxes", "sandboxd", "runtimes");
const BUILD = /(^|\/)(node_modules|dist|build|target|\.?venv[\w.-]*|env|__pycache__|\.next|\.nuxt|\.cache|coverage|\.pytest_cache|\.mypy_cache|\.ruff_cache|out|\.turbo|\.gradle|\.parcel-cache|\.svelte-kit|\.tox|\.eggs|[^/]+\.egg-info)\/?$/;
const MAX_HIDE = 400;

const [cmd = "plan", WORLD = "world-g"] = process.argv.slice(2);
if (!/^[a-z0-9-]{1,32}$/.test(WORLD)) die("bad world name");
const exp = (p) => path.resolve(String(p).replace(/^~(?=\/|$)/, HOME));
const readJson = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function die(m) { console.error(`shares: ${m}`); process.exit(2); }
const log = (m) => console.log(`shares ${WORLD}: ${m}`);

// ASR (docker-sandbox.html): home subfolders are allowed; home itself, /tmp, system and root folders are not.
function allowedPath(p) {
  return p.startsWith(HOME + "/") && !p.startsWith(HOME + "/.ssh") && !p.startsWith(HOME + "/.gnupg");
}

function config() {
  const g = readJson(path.join(CFG, "config.json"));
  const w = readJson(path.join(CFG, "worlds", `${WORLD}.json`), null);
  if (!w) die(`no ${CFG}/worlds/${WORLD}.json`);
  const jotRoot = readJson(path.join(HOME, ".pi", "agent", "jot.json")).root || "~/Obsidian";
  const roleDirs = { screenshots: g.screenshotsDir || "~/Screenshots", jot: jotRoot, downloads: "~/Downloads", ...(g.roleFolders || {}) };
  const relay = readJson(path.join(CFG, "sbx-relay.json"), { sandboxes: [] });
  return { g, w, roleDirs, relay, sandbox: w.sandbox || WORLD };
}

const isGit = (d) => fs.existsSync(path.join(d, ".git"));
const subdirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => path.join(d, e.name)); } catch { return []; } };
const under = (p, base) => p === base || p.startsWith(base + "/");

// J316: projects the HOST runs or loads (a sandbox editing them would change what the laptop runs), found in the
// usual places: pi packages and agent symlinks, ~/.local/bin (links and scripts), systemd --user units, Hyprland /
// Omarchy plugin links, desktop entries, MCP server configs, shell rc. Each hit is the projectFolder child it points
// into. These are protected automatically; the `protected` list in config.json can add more.
function hostRun(pf) {
  const hits = new Map(), add = (p, how) => {
    const abs = exp(p);
    for (const f of pf) if (abs.startsWith(f + "/")) { const proj = path.join(f, abs.slice(f.length + 1).split("/")[0]); if (!hits.has(proj)) hits.set(proj, how); }
  };
  const text = (f) => { try { const st = fs.statSync(f); if (!st.isFile() || st.size > 2e6) return ""; const b = fs.readFileSync(f); return b.includes(0) ? "" : b.toString("utf8"); } catch { return ""; } };
  const scan = (f, how) => { for (const m of text(f).matchAll(/(?:\/home\/[^/\s"']+|~|\$HOME)\/[^\s"'`)<>;:]+/g)) add(m[0].replace(/^\$HOME/, HOME), how); };
  const links = (d, how, depth = 1) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); try { if (fs.lstatSync(p).isSymbolicLink()) add(fs.realpathSync(p), `${how}: ${p.replace(HOME, "~")}`); else if (e.isDirectory() && depth > 1) links(p, how, depth - 1); } catch { /* dangling */ } } };
  const piAgent = path.join(HOME, ".pi", "agent");
  for (const s of JSON.stringify(readJson(path.join(piAgent, "settings.json"))).match(/"[^"]*Work\/[^"]*"/g) || []) add(path.resolve(piAgent, s.slice(1, -1).replace(/^~/, HOME)), "pi settings (package or extension)");
  for (const d of ["extensions", "skills", "agents", "prompts", "themes"]) links(path.join(piAgent, d), `pi ${d} link`, 2);
  for (const f of fs.existsSync(path.join(piAgent, "extensions")) ? fs.readdirSync(path.join(piAgent, "extensions"), { recursive: true }) : []) if (/\.(ts|js|mjs)$/.test(f) && !String(f).includes("node_modules")) scan(path.join(piAgent, "extensions", f), "pi extension imports it");
  scan(path.join(piAgent, "mcp.json"), "MCP server (pi)");
  for (const f of fs.existsSync(path.join(CFG, "..", "mcp-gateway")) ? fs.readdirSync(path.join(CFG, "..", "mcp-gateway")) : []) scan(path.join(CFG, "..", "mcp-gateway", f), "MCP server (gateway)");
  const bin = path.join(HOME, ".local", "bin");
  links(bin, "on PATH");
  for (const f of fs.existsSync(bin) ? fs.readdirSync(bin) : []) { const p = path.join(bin, f); try { if (!fs.lstatSync(p).isSymbolicLink()) scan(p, `~/.local/bin/${f}`); } catch { /* */ } }
  const units = path.join(HOME, ".config", "systemd", "user");
  for (const f of fs.existsSync(units) ? fs.readdirSync(units, { recursive: true }) : []) if (/\.(service|timer|conf|path)$/.test(f)) scan(path.join(units, f), `systemd unit ${f}`);
  links(path.join(HOME, ".config", "omarchy", "plugins"), "Omarchy plugin link"); links(path.join(HOME, ".config", "hypr"), "Hyprland config link");
  for (const f of fs.existsSync(path.join(HOME, ".config", "hypr")) ? fs.readdirSync(path.join(HOME, ".config", "hypr")) : []) if (/\.(lua|conf)$/.test(f)) scan(path.join(HOME, ".config", "hypr", f), `Hyprland ${f}`);
  const apps = path.join(HOME, ".local", "share", "applications");
  for (const f of fs.existsSync(apps) ? fs.readdirSync(apps) : []) if (f.endsWith(".desktop")) { const ex = (text(path.join(apps, f)).match(/^Exec=.*$/m) || [""])[0]; for (const m of ex.matchAll(/\/home\/[^\s"']+/g)) add(m[0], `desktop entry ${f}`); }
  for (const f of [".bashrc", ".zshrc", ".profile", ".bash_profile"]) { for (const l of text(path.join(HOME, f)).split("\n")) if (!/^\s*#/.test(l)) for (const m of l.matchAll(/(?:\/home\/[^/\s"']+|~|\$HOME)\/[^\s"'`)<>;:]+/g)) add(m[0].replace(/^\$HOME/, HOME), `~/${f}`); }
  return hits;
}

// What should be mounted: [{ host, at, ro, why }], and the hidden gitignored paths.
function plan() {
  const { g, w, roleDirs, relay, sandbox } = config();
  const mounts = [], skipped = [], hidden = [];
  const add = (host, opts) => {
    const h = exp(host), at = opts.at ? exp(opts.at) : h;
    if (!allowedPath(h)) { skipped.push(`${h} (not allowed by the sandbox policy: home subfolders only)`); return; }
    if (!fs.existsSync(h)) { skipped.push(`${h} (missing on the host)`); return; }
    const old = mounts.find((m) => m.at === at);
    if (old) { old.ro = old.ro || !!opts.ro; return; }
    mounts.push({ host: h, at, ro: !!opts.ro, why: opts.why });
  };
  // 1. role folders (default off)
  for (const [role, on] of Object.entries(w.roles || {})) {
    if (!on || !roleDirs[role]) continue;
    add(roleDirs[role], { at: on.at, why: role });
  }
  // 2. projects
  const pf = (g.projectFolders || []).map(exp);
  const shared = [];
  if (w.projects === "all") for (const f of pf) { add(f, { why: "projects (all)" }); shared.push(f); }
  else for (const name of Array.isArray(w.projects) ? w.projects : []) {
    if (!/^[\w.-]+$/.test(name)) { skipped.push(`${name} (bad project name)`); continue; }
    const hit = pf.map((f) => path.join(f, name)).find((d) => fs.existsSync(d));
    if (hit) { add(hit, { why: "project" }); shared.push(hit); } else skipped.push(`${name} (no such project)`);
  }
  // 3. general shares
  for (const s of w.shares || []) add(s.path, { ro: s.mode !== "rw", at: s.at, why: "share" });
  // 4. read-only on top, wherever a writable share would cover them: protected projects, every relay inbox,
  // the other sandboxes' workspaces (this one's own workspace is sbx's own rw mount).
  const own = exp(w.workspace || "~/Work/" + WORLD);
  // J316: entries may be glob patterns over the project folders' children ("hyprpi*", "pi-*", "*-pi"), and every git
  // worktree of a protected repo is protected too (its edits could be merged and pushed).
  const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  const prot = new Set([ROOT, exp("~/Harness/agent-config")]);
  for (const e of g.protected || []) {
    if (!/[*?]/.test(e)) { prot.add(exp(e)); continue; }
    const base = /\//.test(e) ? [exp(path.dirname(e))] : pf, re = globRe(path.basename(e));
    for (const f of base) for (const d of subdirs(f)) if (re.test(path.basename(d))) prot.add(d);
  }
  const worktrees = (repo) => { try { return execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 10000 }).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)); } catch { return []; } };
  const auto = hostRun(pf); // J316
  for (const [proj, how] of auto) if (!prot.has(proj)) { prot.add(proj); skipped.push(`auto-protected ${proj} (the host runs it: ${how}); add it to "protected" to make that explicit`); }
  for (const p of [...prot]) if (isGit(p)) for (const w of worktrees(p)) if (pf.some((f) => under(w, f)) && w !== p) prot.add(w);
  for (const s of relay.sandboxes || []) { if (s.inbox) prot.add(exp(s.inbox)); if (s.workspace && exp(s.workspace) !== own) prot.add(exp(s.workspace)); }
  for (const f of fs.existsSync(path.join(CFG, "worlds")) ? fs.readdirSync(path.join(CFG, "worlds")) : []) {
    const o = readJson(path.join(CFG, "worlds", f)); if (o.inbox) prot.add(exp(o.inbox)); if (o.workspace && exp(o.workspace) !== own) prot.add(exp(o.workspace));
  }
  for (const p of prot) if (mounts.some((m) => !m.ro && under(p, m.host)) || [ROOT].includes(p)) add(p, { ro: true, why: "protected" });
  // 5. hide gitignored files in shared git projects (not build output), except where "show" says so
  const gi = w.gitignored || {};
  if (gi.hide !== false) {
    const show = (gi.show || []).map(String);
    const repos = new Set();
    for (const m of mounts) {
      if (m.why === "jot") continue;   // the vault is shared whole on purpose
      if (isGit(m.host)) repos.add(m.host);
      for (const d of subdirs(m.host)) if (isGit(d)) repos.add(d);
    }
    for (const r of repos) {
      if (under(own, r) || under(r, own)) continue;
      // In a read-only share sbx can place a placeholder over a FOLDER but not over a file (it opens the target for
      // writing): there, ignored folders are hidden and ignored files stay visible, read-only (listed).
      const roRepo = mounts.some((m) => m.ro && under(r, m.host));
      const name = path.relative(pf.find((f) => under(r, f)) || path.dirname(r), r);
      if (show.includes(name)) continue;
      let out = "";
      try { out = execFileSync("git", ["-C", r, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { encoding: "utf8", timeout: 20000, maxBuffer: 1 << 24 }); } catch { continue; }
      for (const rel of out.split("\0").filter(Boolean)) {
        if (rel.replace(/\/$/, "").split("/").some((c) => BUILD.test(c))) continue;   // inside build output anywhere
        if (show.includes(`${name}/${rel.replace(/\/$/, "")}`)) continue;
        const abs = path.join(r, rel);
        let st; try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (roRepo && !st.isDirectory()) { skipped.push(`visible (read-only, a file in a protected project): ${abs}`); continue; }
        hidden.push({ at: abs.replace(/\/$/, ""), dir: st.isDirectory() });
      }
    }
    if (hidden.length > MAX_HIDE) { skipped.push(`${hidden.length - MAX_HIDE} more gitignored paths not hidden (limit ${MAX_HIDE})`); hidden.length = MAX_HIDE; }
  }
  return { sandbox, mounts, hidden, skipped, own };
}

// The placeholders: an empty dir and an empty file, host-side, never written to.
function placeholders() {
  const d = path.join(STATE, WORLD, "empty");
  fs.mkdirSync(path.join(d, "dir"), { recursive: true, mode: 0o755 });
  const f = path.join(d, "file"); if (!fs.existsSync(f)) fs.writeFileSync(f, "", { mode: 0o444 });
  try { fs.chmodSync(path.join(d, "dir"), 0o555); } catch { /* */ }
  return { dir: path.join(d, "dir"), file: f };
}
const cardDir = () => path.join(STATE, WORLD, "card");

function current(sandbox) {
  const r = readJson(path.join(RUNTIMES, `${sandbox}.json`), {});
  return (r.State?.runtime_mounts || []).map((m) => ({ host: m.host_path, at: m.container_target, ro: !!m.read_only }));
}

// What the guest really has mounted right now (a guest root can unmount; sbx's saved list wouldn't show that).
// null when the sandbox isn't running (then sbx restores its saved mounts at start anyway).
function live(sandbox) {
  const st = spawnSync("sbx", ["ls"], { encoding: "utf8", timeout: 20000 });
  if (!new RegExp(`^${sandbox}\\s+\\S+\\s+\\S+\\s+running`, "m").test(st.stdout || "")) return null;
  const r = spawnSync("sbx", ["exec", sandbox, "cat", "/proc/self/mountinfo"], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return null;
  return new Set((r.stdout || "").split("\n").map((l) => l.split(" ")[4]).filter(Boolean).map((t) => t.replace(/\\040/g, " ")));
}

function sbx(args) {
  const r = spawnSync("sbx", args, { encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim().split("\n").pop() };
}

function apply() {
  const p = plan(), ph = placeholders();
  const want = [...p.mounts.map((m) => ({ host: m.host, at: m.at, ro: m.ro, why: m.why })),
    ...p.hidden.map((h) => ({ host: h.dir ? ph.dir : ph.file, at: h.at, ro: true, why: "hidden" })),
    { host: cardDir(), at: "/home/agent/.sandbox", ro: true, why: "host card" }];
  writeCard(p);
  const have = current(p.sandbox), key = (m) => `${m.host}\0${m.at}\0${m.ro}`;
  // (ShareTest) a mount sbx still lists but the guest no longer has (e.g. guest root unmounted a placeholder) counts
  // as missing, so it's mounted again; sbx keeps the host-side read-only rule meanwhile either way.
  const inGuest = live(p.sandbox);
  const haveKeys = new Set(have.filter((m) => !inGuest || inGuest.has(m.at)).map(key));
  // Order matters only for display (sbx enforces ro per shared path on the host): writable parents first.
  const todo = want.filter((m) => !haveKeys.has(key(m))).sort((a, b) => (a.ro - b.ro) || a.at.length - b.at.length);
  let done = 0, failed = 0;
  for (const m of todo) {
    // a mount at the same target with another mode or source: replace it
    const old = have.find((h) => h.at === m.at);
    if (old) sbx(["umount", p.sandbox, `${old.host}:${old.at}`]);
    const r = sbx(["mount", p.sandbox, `${m.host}:${m.at}:${m.ro ? "ro" : "rw"}`]);
    if (r.ok) done++; else { failed++; log(`couldn't mount ${m.at} (${m.why}): ${r.out}`); }
  }
  // mounts this tool made earlier that the config no longer wants
  const managed = readJson(path.join(STATE, WORLD, "managed.json"), []);
  const wantKeys = new Set(want.map(key));
  for (const m of managed) if (!wantKeys.has(key(m)) && haveKeys.has(key(m))) { const r = sbx(["umount", p.sandbox, `${m.host}:${m.at}`]); log(`${r.ok ? "removed" : "couldn't remove"} ${m.at}`); }
  fs.writeFileSync(path.join(STATE, WORLD, "managed.json"), JSON.stringify(want), { mode: 0o600 });
  log(`${p.mounts.length} shares, ${p.hidden.length} gitignored paths hidden; mounted ${done} new${failed ? `, ${failed} failed` : ""}`);
  for (const s of p.skipped) log(`skipped: ${s}`);
  return failed ? 1 : 0;
}

// --- the host card (format: doorman-design.md, card: host-card/1) ---------------------------------------
function network(sandbox) {
  let pol; try { pol = JSON.parse(execFileSync("sbx", ["policy", "ls", "--include-inactive", "--json"], { encoding: "utf8", timeout: 30000, maxBuffer: 1 << 26 })); } catch { return null; }
  const rules = (pol.rules || []).filter((r) => String(r.applies_to || "").split(/,\s*/).includes(`sandbox:${sandbox}`) && r.status === "active" && r.decision === "allow");
  const tcp = new Set(), http = new Set();
  for (const r of rules) for (const x of r.resources || []) ((r.actions || []).some((a) => a.startsWith("http:")) ? http : tcp).add(String(x));
  return { profile: [...new Set(rules.map((r) => r.policy_name))].join(", "), tcp: [...tcp].sort(), http: [...http].sort() };
}

function writeCard(p = plan()) {
  const dir = cardDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const net = network(p.sandbox);
  const rows = p.mounts.map((m) => `| ${m.ro ? "ro" : "rw"} | ${m.at} | ${m.why} |`);
  const card = [
    "# Host card", "",
    "card: host-card/1",
    `host: ${os.hostname()} (${process.platform}), owner ${os.userInfo().username}`,
    `written: ${new Date().toISOString().slice(0, 16)} by hyprpi (docker/world/shares.mjs)`,
    `sandbox: ${p.sandbox}`, "",
    "## Shared folders", "",
    "Paths as seen in here (same as on the host unless noted). Everything else on the host is not shared.", "",
    "| mode | path | what |", "|------|------|------|",
    `| rw | ${p.own} | this sandbox's workspace |`, ...rows,
    "| ro | /home/agent/.sandbox | this card |", "",
    `Hidden: ${p.hidden.length} gitignored paths in shared projects show as empty (owner's choice).`, "",
    "## Tools on the host", "",
    "The host runs the desktop (windows, notifications, the clipboard) and hyprpi. You can't run host commands; ask the Doorman to have something done there.", "",
    "## Network", "",
    net ? `Your requests go through the sandbox policy proxy, profile ${net.profile} (NVIDIA's central allowlist; the host can't change it, new domains need a request by the owner). A blocked domain answers 403 "Blocked by org policy". The full list (${net.tcp.length} host rules, ${net.http.length} path-limited web rules) is in net-allowlist.md next to this card.` : "Your requests go through the sandbox policy proxy (NVIDIA's central allowlist). The list couldn't be read on the host just now.", "",
    "## Web research", "",
    ...(() => { const { mode, note } = modeForSandbox(CFG, p.sandbox); return [`Doorman mode: ${mode}${note ? ` (${note})` : ""}`, "", `Ask Outside "Research: <what you're looking for>" (or "Research (deep): …"): ${MODE_TEXT[mode]}`, ""]; })(),
    "## How to ask", "",
    "- Talk to your Doorman (always allowed, no approval needed).",
    "- Messages to agents in other worlds wait for Angus's approval (a toast and the Thoughts panel); he can allow similar ones for a while.", "",
    "## Withheld", "",
    "Other folders in the owner's home, credentials, other worlds' conversations, and the hidden gitignored files above.", "",
  ].join("\n");
  const listing = net ? ["# Network allowlist", "", `sandbox: ${p.sandbox}, profile ${net.profile}, from sbx policy ls on the host, ${new Date().toISOString().slice(0, 16)}`, "",
    "## Whole hosts (tcp)", "", ...net.tcp.map((x) => `- ${x}`), "", "## Web, some paths only (http)", "", ...net.http.map((x) => `- ${x}`), ""].join("\n") : null;
  const put = (f, s) => { const fp = path.join(dir, f); try { if (fs.readFileSync(fp, "utf8").replace(/^written: .*$/m, "") === s.replace(/^written: .*$/m, "")) return false; } catch { /* new */ } fs.writeFileSync(fp, s, { mode: 0o644 }); return true; };
  const changed = put("host-card.md", card); if (listing) put("net-allowlist.md", listing);
  if (changed) log(`host card written (${path.join(dir, "host-card.md")})`);
  return changed;
}

// --- watch: re-apply when the config or a project folder's contents change ---------------------------
function fingerprint() {
  const { g, w } = config();
  const parts = [fs.readFileSync(path.join(CFG, "config.json"), "utf8"), JSON.stringify(w)];
  for (const f of (g.projectFolders || []).map(exp)) parts.push(subdirs(f).join("\n"));
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}
async function watch() {
  let last = "";
  for (;;) {
    try { const fp = fingerprint(); if (fp !== last) { last = fp; apply(); } else { const t = Date.now(); if (t % 600000 < 30000) apply(); } } catch (e) { log(`watch: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 30000));
  }
}

if (cmd === "plan") {
  const p = plan();
  for (const m of p.mounts) console.log(`${m.ro ? "ro" : "rw"}  ${m.at}${m.at !== m.host ? `  (from ${m.host})` : ""}  [${m.why}]`);
  console.log(`hidden gitignored: ${p.hidden.length}`); for (const h of p.hidden.slice(0, 20)) console.log(`  ${h.at}${h.dir ? "/" : ""}`);
  for (const s of p.skipped) console.log(`skipped: ${s}`);
} else if (cmd === "apply") process.exit(apply());
else if (cmd === "card") writeCard();
else if (cmd === "watch") await watch();
else die("usage: shares.mjs plan|apply|card|watch [WORLD]");
