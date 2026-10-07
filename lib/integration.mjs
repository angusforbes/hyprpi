// J190 (Angus: "not hardcode paths … have ways to config things"; the herdr-style shape from Pocket's
// note): hyprpi's home-folder wiring as opt-in, reversible pieces.
//
//   hyprpi integration status [NAME…]
//   hyprpi integration install NAME…     (or "recommended": hypr path bar kitty)
//   hyprpi integration uninstall NAME…
//
// Every install records exactly what it did in ~/.local/state/hyprpi/integrations.json (links made,
// lines added, units written, backups taken) and uninstall undoes only that: a link only if it still
// points into this checkout, a line only if it still carries hyprpi's marker, a unit only if hyprpi
// wrote it. What was already there before (e.g. your own require line) is left alone. Shell rc files are
// never edited: when ~/.local/bin isn't on PATH, you're told how to add it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, stateDir } from "./paths.mjs";

const HOME = os.homedir();
const CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
const STATE_FILE = () => path.join(stateDir(), "integrations.json");
// The dir a piece's files sit in may be shared with another piece (two units in systemd/user): a folder
// hyprpi created is removed by whichever uninstall empties it last.
const BACKUPS = () => path.join(stateDir(), "backups");
const MARK = "-- hyprpi integration";        // Lua
const KMARK = "# hyprpi integration";         // kitty
const tilde = (p) => p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) || {}; } catch { return {}; } }
function saveState(s) { fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true }); fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 1)); }
function backup(file) {
  if (!fs.existsSync(file)) return "";
  fs.mkdirSync(BACKUPS(), { recursive: true });
  const b = path.join(BACKUPS(), `${path.basename(file)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.copyFileSync(file, b);
  return b;
}
const linkTarget = (p) => { try { return fs.lstatSync(p).isSymbolicLink() ? path.resolve(path.dirname(p), fs.readlinkSync(p)) : null; } catch { return undefined; } };
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// A link at `at` pointing to `to` (inside this checkout). Refuses a different file or a foreign link.
function ensureLink(at, to, done) {
  const t = linkTarget(at);
  if (t === undefined) {
    const made = fs.mkdirSync(path.dirname(at), { recursive: true }); // the first folder it created, if any
    if (made) done.dirs.push(made);
    fs.symlinkSync(to, at); done.links.push(at); return `linked ${tilde(at)} -> ${tilde(to)}`;
  }
  if (t !== null && realOf(at) === realOf(to)) return `${tilde(at)} already links here`;
  throw new Error(`${tilde(at)} is already there and isn't hyprpi's link; move it away first (nothing was changed)`);
}
function removeLinks(links, out) {
  for (const l of links || []) {
    const t = linkTarget(l);
    if (t && (t.startsWith(ROOT + "/") || realOf(t)?.startsWith(realOf(ROOT) + "/"))) { fs.rmSync(l); out.push(`removed ${tilde(l)}`); }
    else if (t !== undefined) out.push(`left ${tilde(l)} (no longer hyprpi's link)`);
  }
}
// Add `line` (tagged with `mark`) after the line matching `after` (else at the end). Returns false if
// an equivalent untagged line is already there (yours: left alone and not recorded).
function addLine(file, line, mark, { after = null, present } = {}, done) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text.split("\n");
  if (lines.some((l) => l.includes(mark))) return `${tilde(file)} already has hyprpi's line`;
  if (present && lines.some((l) => present.test(l) && !/^\s*(--|#)/.test(l))) return `${tilde(file)} already has it (your own line; left as is)`;
  const b = backup(file); if (b) done.backups.push(b);
  const tagged = `${line}  ${mark}`;
  const i = after ? lines.findIndex((l) => after.test(l)) : -1;
  if (i >= 0) lines.splice(i + 1, 0, tagged); else { if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, tagged); else lines.push(tagged); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
  done.lines.push({ file, mark });
  return `added to ${tilde(file)}: ${line}${b ? ` (backup: ${tilde(b)})` : ""}`;
}
function removeLines(list, out) {
  for (const { file, mark } of list || []) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const keep = lines.filter((l) => !l.includes(mark));
    if (keep.length !== lines.length) { backup(file); fs.writeFileSync(file, keep.join("\n")); out.push(`removed hyprpi's line from ${tilde(file)}`); }
  }
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const onPath = (cmd) => String(process.env.PATH || "").split(":").some((d) => d && fs.existsSync(path.join(d, cmd)));
const hasSystemd = () => { const r = run("systemctl", ["--user", "show-environment"]); return !r.error && r.status === 0; };

// ---- the pieces --------------------------------------------------------------------------------
const P = {};

P.hypr = {
  what: "Hyprland: link hypr/hyprpi.lua into ~/.config/hypr and require it from hyprland.lua (hyprpi's keys and window rules)",
  status() {
    const at = path.join(CONFIG, "hypr", "hyprpi.lua"), t = linkTarget(at);
    const req = fs.existsSync(path.join(CONFIG, "hypr", "hyprland.lua")) && /^\s*require\("hypr\.hyprpi"\)/m.test(fs.readFileSync(path.join(CONFIG, "hypr", "hyprland.lua"), "utf8"));
    return t && realOf(at) === realOf(path.join(ROOT, "hypr", "hyprpi.lua")) && req ? "installed" : t === undefined && !req ? "not installed" : `partly (${t ? "link ok" : "no link"}, ${req ? "required" : "not required"})`;
  },
  install(done) {
    const dir = path.join(CONFIG, "hypr");
    if (!fs.existsSync(path.join(dir, "hyprland.lua"))) throw new Error(`${tilde(dir)}/hyprland.lua not found: hyprpi needs Hyprland 0.56+ with its Lua config`);
    const out = [ensureLink(path.join(dir, "hyprpi.lua"), path.join(ROOT, "hypr", "hyprpi.lua"), done)];
    out.push(addLine(path.join(dir, "hyprland.lua"), 'require("hypr.hyprpi")', MARK, { after: /^\s*require\("hypr\.bindings"\)/, present: /require\("hypr\.hyprpi"\)/ }, done));
    out.push("Hyprland reloads on its own; check `hyprctl configerrors`");
    return out;
  },
};

P.path = {
  what: "PATH: link bin/hyprpi as ~/.local/bin/hyprpi (no shell rc edits)",
  status() { const t = realOf(path.join(HOME, ".local", "bin", "hyprpi")); return t === realOf(path.join(ROOT, "bin", "hyprpi")) ? "installed" : t ? "another hyprpi is linked" : "not installed"; },
  install(done) {
    const bin = path.join(HOME, ".local", "bin");
    const out = [ensureLink(path.join(bin, "hyprpi"), path.join(ROOT, "bin", "hyprpi"), done)];
    if (!String(process.env.PATH || "").split(":").includes(bin)) out.push(`note: ${tilde(bin)} isn't on your PATH; add it in your shell's rc file, e.g. export PATH="$HOME/.local/bin:$PATH"`);
    return out;
  },
};

P.bar = {
  what: "Omarchy bar: hyprpi's shell plugins (the SUPER+SHIFT+SPACE finder, the lapsed-login mark)",
  ids: () => fs.readdirSync(path.join(ROOT, "shell-plugin"), { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, "shell-plugin", d.name, "manifest.json"))).map((d) => d.name),
  status() { const pl = path.join(CONFIG, "omarchy", "plugins"); const ids = this.ids(); const n = ids.filter((id) => realOf(path.join(pl, id)) === realOf(path.join(ROOT, "shell-plugin", id))).length; return n === ids.length ? "installed" : n ? `partly (${n}/${ids.length})` : "not installed"; },
  install(done) {
    if (!onPath("omarchy-shell")) throw new Error("omarchy-shell not found: the bar plugins need Omarchy's Quickshell shell (skip this piece on plain Hyprland)");
    const pl = path.join(CONFIG, "omarchy", "plugins"), out = [];
    for (const id of this.ids()) out.push(ensureLink(path.join(pl, id), path.join(ROOT, "shell-plugin", id), done));
    const sh = (...a) => { const r = run("omarchy-shell", ["shell", ...a]); if (r.error || r.status !== 0) throw new Error(`omarchy-shell shell ${a[0]} failed (is the Omarchy shell running?): ${(r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 200)}`); return r.stdout || ""; };
    sh("rescanPlugins"); run("sleep", ["2"]);
    for (const id of this.ids()) { sh("setPluginEnabled", id, "true"); done.plugins.push(id); out.push(`enabled ${id}`); }
    const cfg = sh("listShellConfig") || "{}";
    let placed = false; try { placed = JSON.stringify(JSON.parse(cfg).bar?.layout || {}).includes('"agf.hyprpi-login"'); } catch { /* unknown */ }
    if (!placed) {
      const hasReprieve = cfg.includes('"tech.greyforge.reprieve"');
      sh("putBarWidget", "agf.hyprpi-login", JSON.stringify(hasReprieve ? { section: "left", after: "tech.greyforge.reprieve" } : { section: "left" }));
      out.push(`placed agf.hyprpi-login on the bar (left${hasReprieve ? ", after Reprieve" : ""})`);
    }
    return out;
  },
  uninstall(rec, out) { for (const id of rec.plugins || []) { if (onPath("omarchy-shell")) run("omarchy-shell", ["shell", "setPluginEnabled", id, "false"]); out.push(`disabled ${id}`); } },
};

P.kitty = {
  what: "kitty: one include line in your kitty.conf for Ctrl+click links (terminal-helpers/kitty/links.conf); agent windows load pi.conf on their own",
  file: () => path.join(process.env.KITTY_CONFIG_DIRECTORY || path.join(CONFIG, "kitty"), "kitty.conf"),
  status() { const f = this.file(); const t = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""; return /^\s*include\s+\S*terminal-helpers\/kitty\/links\.conf/m.test(t) ? "installed" : "not installed"; },
  install(done) { return [addLine(this.file(), `include ${path.join(ROOT, "terminal-helpers", "kitty", "links.conf")}`, KMARK, { present: /^\s*include\s+\S*terminal-helpers\/kitty\/links\.conf/ }, done)]; },
};

const service = (name, unitName) => ({
  what: name === "gateway" ? "MCP gateway: shared, lazily started MCP servers for all agents (systemd --user unit; see mcp-gateway/README.md)" : "Phone app: the remote-control web server (systemd --user unit; see remote-control/README.md)",
  status() { const u = path.join(CONFIG, "systemd", "user", unitName); if (!fs.existsSync(u)) return "not installed"; const a = hasSystemd() ? run("systemctl", ["--user", "is-active", unitName]).stdout.trim() : "no systemd --user"; return `installed (${a})`; },
  install(done) {
    let first = path.join(CONFIG, "systemd", "user");
    if (!fs.existsSync(first)) { while (!fs.existsSync(path.dirname(first))) first = path.dirname(first); done.dirs.push(first); }
    const r = run(process.execPath, [path.join(ROOT, "bin", "hyprpi"), name === "gateway" ? "mcp-gateway" : "remote", "install"]);
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").trim());
    done.units.push(unitName);
    return (r.stdout || "").trim().split("\n");
  },
  uninstall(rec, out) {
    for (const u of rec.units || []) {
      const f = path.join(CONFIG, "systemd", "user", u);
      if (hasSystemd()) run("systemctl", ["--user", "disable", "--now", u]);
      let ours = false; try { ours = fs.lstatSync(f).isSymbolicLink() || fs.readFileSync(f, "utf8").startsWith("# Written by `hyprpi"); } catch { /* gone */ }
      if (ours) { fs.rmSync(f); out.push(`stopped and removed ${tilde(f)}`); }
      if (hasSystemd()) run("systemctl", ["--user", "daemon-reload"]);
    }
  },
});
P.gateway = service("gateway", "mcp-gateway.service");
P.remote = service("remote", "hyprpi-remote-control.service");

const subInstall = (dir, mark) => ({
  what: dir === "hyprwrlds" ? "hyprwrlds: worlds of ten workspaces, their keys and bar widget (runs hyprwrlds/install.sh)" : "hyprwrlds-vimarchy: the ALT+SPACE overview and switcher (runs hyprwrlds-vimarchy/install.sh; needs hyprwrlds)",
  status() { const t = fs.existsSync(path.join(CONFIG, "hypr", "hyprland.lua")) ? fs.readFileSync(path.join(CONFIG, "hypr", "hyprland.lua"), "utf8") : ""; return new RegExp(`^\\s*require\\("hypr\\.${mark}"\\)`, "m").test(t) ? "installed" : "not installed"; },
  install(done) {
    const r = run("bash", [path.join(ROOT, dir, "install.sh")]);
    if (r.status !== 0) throw new Error(`${dir}/install.sh failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
    done.notes.push(`${dir}: uninstall by hand (see ${dir}/README.md, "Uninstall")`);
    return (r.stdout || "").trim().split("\n").filter(Boolean);
  },
  uninstall(_rec, out) { out.push(`${dir} has no automatic uninstall: follow ${path.join(ROOT, dir, "README.md")} ("Uninstall")`); },
});
P.hyprwrlds = subInstall("hyprwrlds", "hyprwrlds");
P["hyprwrlds-vimarchy"] = subInstall("hyprwrlds-vimarchy", "hyprwrlds-vimarchy");

export const RECOMMENDED = ["hypr", "path", "bar", "kitty"];
export const NAMES = Object.keys(P);

export function status(names = NAMES) {
  return names.map((n) => { if (!P[n]) throw new Error(`unknown piece "${n}" (pieces: ${NAMES.join(", ")})`); return { name: n, state: P[n].status(), what: P[n].what }; });
}

export function install(names) {
  const st = loadState(), out = [];
  for (const n of names) {
    if (!P[n]) throw new Error(`unknown piece "${n}" (pieces: ${NAMES.join(", ")})`);
    const prev = st[n] || {};
    const done = { dirs: [...(prev.dirs || [])], links: [...(prev.links || [])], lines: [...(prev.lines || [])], backups: [...(prev.backups || [])], plugins: [...(prev.plugins || [])], units: [...(prev.units || [])], notes: [] };
    try {
      out.push(`${n}:`, ...P[n].install(done).map((l) => "  " + l));
      for (const k of ["dirs", "links", "plugins", "units"]) done[k] = [...new Set(done[k])];
      st[n] = { ...done, at: new Date().toISOString(), root: ROOT };
      st._dirs = [...new Set([...(st._dirs || []), ...done.dirs])]; // folders hyprpi created (any piece)
    } catch (e) { out.push(`${n}: ✗ ${e.message}`); if (done.links.length || done.lines.length || done.dirs.length) st[n] = { ...done, at: new Date().toISOString(), root: ROOT, partial: true }; saveState(st); throw Object.assign(new Error(out.join("\n")), { partialOutput: true }); }
    saveState(st);
  }
  return out;
}

export function uninstall(names) {
  const st = loadState(), out = [];
  for (const n of names) {
    if (!P[n]) throw new Error(`unknown piece "${n}" (pieces: ${NAMES.join(", ")})`);
    const rec = st[n];
    if (!rec) { out.push(`${n}: nothing recorded (not installed by hyprpi integration); left as is`); continue; }
    const o = [];
    P[n].uninstall?.(rec, o);
    removeLines(rec.lines, o);
    removeLinks(rec.links, o);
    // folders install created, if they're empty again (deepest first)
    for (const l of [...(rec.links || []), ...(rec.units || []).map((u) => path.join(CONFIG, "systemd", "user", u))]) {
      const top = (st._dirs || []).find((d) => l.startsWith(d + "/"));
      if (!top) continue;
      for (let x = path.dirname(l); x === top || x.startsWith(top + "/"); x = path.dirname(x)) { try { fs.rmdirSync(x); if (x === top) st._dirs = st._dirs.filter((d) => d !== top); } catch { break; } }
    }
    if (rec.backups?.length) o.push(`backups kept: ${rec.backups.map(tilde).join(", ")}`);
    out.push(`${n}:`, ...(o.length ? o : ["nothing to undo"]).map((l) => "  " + l));
    delete st[n]; saveState(st);
  }
  return out;
}
