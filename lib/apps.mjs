// App windows for summon / dismiss / pin (Angus via Thoughts-D, J28: "apply this summon logic to all
// apps … clear apps like agents"). Two things, shared by the daemon (lib/daemon.mjs) and the summon
// pop-up (mockups/finder --summon):
//
//   isAppWindow(c, { agentAt })  an app window that summon / dismiss / pin may move: on a normal
//                                workspace, tiled, floating or fullscreen (J28 v2, Angus: "include full
//                                screen apps too and floating tiled apps"; a move keeps that state), not
//                                a hyprpi window (agents, panels, pop-ups) and not an agent's terminal.
//                                Never: transient windows (dialogs, file pickers, portals, polkit, pop-ups:
//                                isTransient), special workspaces (scratchpad, Reprieve-parked), and
//                                Hyprland-pinned windows (shown on every workspace).
//   appLabel(c)                  { icon, app, tag, line2 }: a two-line label that tells two windows
//                                of the same app apart. Titles change; a window's identity is its
//                                address.
//
// Labels by app:
//   Brave / Chromium / Chrome   app + profile (when the title carries one) · the page title
//   Obsidian                    "Obsidian" + vault · the note
//   Omawrite                    "Omawrite" + the folder (from its command line) · the file (• = unsaved)
//   terminals (kitty, foot,     "Terminal" + cwd (~-shortened) · the running command, "(idle)",
//   alacritty, ghostty, …)      a tmux / zellij session, or "ssh user@host" (followed via /proc)
//   anything else               the class · the title
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const tilde = (p) => (p && (p === HOME || p.startsWith(HOME + "/")) ? "~" + p.slice(HOME.length) : p || "");
const clip = (s, n = 90) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export const HYPRPI_CLASS = /^hyprpi(\.|$)/;
const PANEL_TITLE = /^hyprpi-(router|room|search|board|thoughts) /;

export function isAppWindow(c, { agentAt } = {}) {
  if (!c || !c.address) return false;
  const ws = c.workspace?.id;
  if (!(ws > 0)) return false;                         // special / scratchpad / Reprieve-parked
  if (c.mapped === false || c.hidden) return false;
  if (isTransient(c)) return false;                     // dialogs, file pickers, pop-ups
  if (c.pinned) return false;                           // Hyprland's own "pin" (shown on every workspace)
  if (HYPRPI_CLASS.test(c.class || "") || HYPRPI_CLASS.test(c.initialClass || "")) return false;
  if (PANEL_TITLE.test(c.title || "")) return false;
  if (agentAt && agentAt(c.address)) return false;      // an agent in a plain terminal is an agent
  return true;
}

// Transient windows: a file chooser / save dialog, a desktop portal, an authentication prompt, a
// pop-up. Hyprland's client list has no "parent" or "modal" field, so this goes by class and title,
// for floating windows only (a tiled window is never treated as a dialog).
const TRANSIENT_CLASS = /^(xdg-desktop-portal(-\w+)?|org\.freedesktop\.impl\.portal\..*|hyprpolkitagent|polkit-.*|org\.kde\.polkit-kde-authentication-agent-1|lxqt-policykit-agent|gcr-prompter|pinentry(-\w+)?|zenity|kdialog|yad|org\.gnome\.Zenity)$/i;
const TRANSIENT_TITLE = /^(open( file| files| folder| folders)?|save( file| as| image| page as)?|select( a)?( file| files| folder| directory)?|choose( a)?( file| files| folder| directory)?|upload( file| files)?|export( as)?|import|print|page setup|authentication required|authenticate|unlock( keyring)?|enter password|confirm|are you sure\??|alert|warning|error|properties|preferences|settings|about( \w+)?|picture[- ]in[- ]picture)\b/i;
export function isTransient(c) {
  if (TRANSIENT_CLASS.test(c.class || "") || TRANSIENT_CLASS.test(c.initialClass || "")) return true;
  if (!c.floating) return false;
  return TRANSIENT_TITLE.test(String(c.title || "").trim()) || TRANSIENT_TITLE.test(String(c.initialTitle || "").trim());
}
// "floating" / "fullscreen" for the label's second line, so Angus sees the state a window keeps.
export const stateNote = (c) => (c.fullscreen && c.fullscreen !== 0 ? "fullscreen" : c.floating ? "floating" : "");

// ----------------------------------------------------------------------------- terminals
const TERMINALS = /^(kitty|foot|footclient|alacritty|com\.mitchellh\.ghostty|ghostty|org\.wezfurlong\.wezterm|wezterm|xterm|konsole|org\.gnome\.console|gnome-terminal-server|st|urxvt)$/i;
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "nu", "elvish", "xonsh", "tcsh", "ksh"]);
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const comm = (pid) => read(`/proc/${pid}/comm`).trim();
const argv = (pid) => read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean);
const cwdOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return ""; } };
// /proc/<pid>/stat: "pid (comm) state ppid pgrp session tty_nr tpgid …" (comm may hold spaces / parens).
function stat(pid) {
  const s = read(`/proc/${pid}/stat`), i = s.lastIndexOf(")");
  if (i < 0) return null;
  const f = s.slice(i + 2).split(" ");
  return { ppid: +f[1], pgrp: +f[2], tpgid: +f[5], start: +f[19] };
}
let kidsCache = null, kidsAt = 0;
function children() { // ppid -> [pid], refreshed at most every 500 ms
  if (kidsCache && Date.now() - kidsAt < 500) return kidsCache;
  const m = new Map();
  for (const p of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    const st = stat(p); if (!st) continue;
    if (!m.has(st.ppid)) m.set(st.ppid, []);
    m.get(st.ppid).push(+p);
  }
  kidsCache = m; kidsAt = Date.now();
  return m;
}
const kidsOf = (pid) => (children().get(+pid) || []).slice().sort((a, b) => (stat(a)?.start || 0) - (stat(b)?.start || 0));
// The shell a terminal runs: the first shell found below the terminal's process (breadth first).
function shellUnder(pid) {
  const q = [...kidsOf(pid)];
  for (let n = 0; q.length && n < 200; n++) {
    const p = q.shift();
    if (SHELLS.has(comm(p))) return p;
    q.push(...kidsOf(p));
  }
  return null;
}
// What runs in front of the shell: the terminal's foreground process group (tpgid) if it isn't the
// shell itself; without a tty (tests), the shell's newest child. null = the shell is idle.
function foreground(sh) {
  const st = stat(sh);
  if (st && st.tpgid > 0 && st.tpgid !== st.pgrp && fs.existsSync(`/proc/${st.tpgid}`)) return st.tpgid;
  if (st && st.tpgid > 0 && st.tpgid === st.pgrp) return null;
  const k = kidsOf(sh);
  return k.length ? k[k.length - 1] : null;
}
function describeCommand(pid) {
  const a = argv(pid), name = path.basename(a[0] || comm(pid));
  if (name === "ssh") { // ssh [opts] [user@]host [cmd]: the first non-option argument that isn't an option's value
    const withVal = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
    let user = "", host = "";
    for (let i = 1; i < a.length; i++) {
      if (withVal.has(a[i])) { if (a[i] === "-l") user = a[i + 1] || ""; i++; continue; }
      if (a[i].startsWith("-")) continue;
      host = a[i]; break;
    }
    return host ? `ssh ${user && !host.includes("@") ? user + "@" : ""}${host}` : "ssh";
  }
  if (name === "tmux") { const i = a.findIndex((x) => x === "-t" || x === "-s"); return `tmux${i > 0 && a[i + 1] ? " " + a[i + 1] : ""}`; }
  if (name === "zellij") { const i = a.findIndex((x) => x === "-s" || x === "--session" || x === "attach" || x === "a"); return `zellij${i > 0 && a[i + 1] ? " " + a[i + 1] : ""}`; }
  return clip([name, ...a.slice(1)].join(" "), 70);
}
export function terminalLabel(c) {
  const sh = c.pid ? shellUnder(c.pid) : null;
  if (!sh) return { cwd: "", line2: clip(c.title) || "(idle)" };
  const fg = foreground(sh);
  return { cwd: tilde(cwdOf(fg || sh) || cwdOf(sh)), line2: fg ? describeCommand(fg) : "(idle)" };
}

// ----------------------------------------------------------------------------- labels
const BROWSERS = [
  [/^brave-origin/i, "Brave Origin", / - Brave Origin$/],
  [/^brave/i, "Brave", / - Brave$/],
  [/^(chromium|chromium-browser)$/i, "Chromium", / - Chromium$/],
  [/^(google-chrome|chrome)$/i, "Chrome", / - Google Chrome$/],
];
const ICON = { browser: "🌐", obsidian: "🟣", omawrite: "📝", terminal: "🖥", other: "🪟" };
export function appLabel(c) {
  const cls = c.class || c.initialClass || "", title = String(c.title || "").trim();
  for (const [re, app, suffix] of BROWSERS) {
    if (!re.test(cls)) continue;
    let t = title.replace(suffix, "");
    // A profile shows as a trailing " - <Profile>" after the app name in some builds ("Page - Brave - Work").
    let tag = "";
    const pm = new RegExp(`^(.*) - ${app.replace(/ /g, " ")} - ([^-]{1,30})$`).exec(title);
    if (pm) { t = pm[1]; tag = pm[2].trim(); }
    return { icon: ICON.browser, app, tag, line2: clip(t) || "(new tab)" };
  }
  if (/obsidian/i.test(cls)) { // "Note - Vault - Obsidian v1.9.12"
    const m = /^(.*) - ([^-]+?) - Obsidian(?: v[\d.]+)?$/.exec(title);
    return { icon: ICON.obsidian, app: "Obsidian", tag: m ? m[2].trim() : "", line2: clip(m ? m[1] : title.replace(/ - Obsidian.*$/, "")) };
  }
  if (/omawrite/i.test(cls)) { // "* name.md - …" or "name.md - Omawrite": the file; the folder from argv
    const dirty = /^\*\s*/.test(title);
    const name = title.replace(/^\*\s*/, "").replace(/ [-—] Omawrite$/i, "").replace(/ [-—] .*$/, "");
    // The file it was opened with: the last argument that is an existing file (resolved from its cwd).
    const base = c.pid ? cwdOf(c.pid) || "/" : "/";
    const file = c.pid ? argv(c.pid).slice(1).filter((x) => !x.startsWith("-")).map((x) => path.resolve(base, x)).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }).pop() : "";
    const folder = file && (!name || path.basename(file) === name || title.includes(path.basename(file))) ? tilde(path.dirname(file)) : "";
    return { icon: ICON.omawrite, app: "Omawrite", tag: folder, line2: (dirty ? "• " : "") + (clip(name) || "(untitled)") };
  }
  if (TERMINALS.test(cls)) {
    const t = terminalLabel(c);
    return { icon: ICON.terminal, app: "Terminal", tag: t.cwd, line2: t.line2 };
  }
  // Reverse-DNS classes read better by their last part ("org.gnome.Calculator" → "Calculator").
  const app = /^[a-z][\w-]*(\.[\w-]+){2,}$/i.test(cls) ? cls.split(".").pop() : cls;
  return { icon: ICON.other, app: app || "window", tag: "", line2: clip(title) };
}
// One line, for toasts and "dismissed" lists: "Brave (GitHub - …)", "Terminal ~/Work".
export function appName(c) {
  const l = appLabel(c);
  return [l.app, l.tag].filter(Boolean).join(" ") + (l.line2 && l.app !== "Terminal" ? ` (${clip(l.line2, 40)})` : "");
}
