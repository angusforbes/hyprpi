// Shared locations and config for hyprpi (daemon, CLI, Pi extension).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Live Hyprland instances of this user: $XDG_RUNTIME_DIR/hypr/<signature>/hyprland.lock holds
// the compositor's pid (first line); live = that pid runs Hyprland.
export function liveHyprlandSignatures(env = process.env) {
  const base = path.join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, "hypr");
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return []; }
  return dirs.filter((sig) => {
    try {
      const pid = Number(fs.readFileSync(path.join(base, sig, "hyprland.lock"), "utf8").split("\n")[0]) || 0;
      return pid > 0 && /^hyprland/i.test(fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim());
    } catch { return false; }
  });
}

// J80 (2026-10-05): a client started outside the Hyprland session (an ssh login, a herdr pane
// restored from the phone, a systemd service from an older login) has no or a stale
// HYPRLAND_INSTANCE_SIGNATURE. It used to get its own "nohypr" daemon, which shared the state
// dir with the live one and overwrote it (10/3: herdr resumed 15 Pis that way). Instead it
// adopts the one live Hyprland instance, so every client joins the same daemon. Skipped for
// isolated tests (HYPRPI_SOCKET) and with HYPRPI_NO_ADOPT=1; with 0 or 2+ live instances nothing
// is adopted (the daemon then refuses a nohypr start while any Hyprland is live, see daemon.mjs).
export function adoptedSignature(env = process.env) {
  if (env.HYPRPI_SOCKET || env.HYPRPI_NO_ADOPT === "1") return env.HYPRLAND_INSTANCE_SIGNATURE || "";
  const live = liveHyprlandSignatures(env);
  const his = env.HYPRLAND_INSTANCE_SIGNATURE || "";
  if (his && (live.includes(his) || !live.length)) return his;
  return live.length === 1 ? live[0] : his;
}
if (!process.env.HYPRPI_SOCKET && process.env.HYPRPI_NO_ADOPT !== "1") {
  const sig = adoptedSignature(process.env);
  if (sig && sig !== process.env.HYPRLAND_INSTANCE_SIGNATURE) process.env.HYPRLAND_INSTANCE_SIGNATURE = sig; // hyprctl and child processes too
}

// One daemon per Hyprland instance, so a nested test Hyprland gets its own.
export function instanceKey(env = process.env) {
  const his = adoptedSignature(env) || "nohypr";
  return createHash("sha1").update(his).digest("hex").slice(0, 12);
}

export function runtimeDir(env = process.env) {
  return path.join(env.XDG_RUNTIME_DIR || `/tmp/hyprpi-${process.getuid?.() ?? 0}`, "hyprpi");
}

export function socketPath(env = process.env) {
  return env.HYPRPI_SOCKET || path.join(runtimeDir(env), `${instanceKey(env)}.sock`);
}

export function stateDir(env = process.env) {
  return env.HYPRPI_STATE || path.join(env.XDG_STATE_HOME || path.join(HOME, ".local/state"), "hyprpi");
}

// J333 (Angus: "i haven't dragged anyone to world G"): a test daemon with its own socket and state
// still inherited HYPRLAND_INSTANCE_SIGNATURE / WAYLAND_DISPLAY and moved a real agent window to ws 61.
// A hyprpi process whose socket or state isn't the real one (HYPRPI_SOCKET / HYPRPI_STATE /
// XDG_RUNTIME_DIR / XDG_STATE_HOME pointing elsewhere), or that has HYPRPI_TEST set, is ISOLATED: it
// may read Hyprland but never change it (lib/hypr.mjs refuses every non-query hyprctl call, and
// `hyprpi new` / the panel openers open no windows). HYPRPI_ALLOW_HYPR=1 lifts this explicitly
// (world G's inner daemon sets it: its hyprctl is the world helper's stand-in). -> reason, or "".
// A missing XDG_RUNTIME_DIR counts as isolated on purpose (fail closed): its socket would be
// /tmp/hyprpi-UID/..., a different daemon from the real one (GuardReview).
export function isolatedReason(env = process.env) {
  if (env.HYPRPI_ALLOW_HYPR === "1") return "";
  if (env.HYPRPI_TEST && env.HYPRPI_TEST !== "0") return "HYPRPI_TEST is set";
  const real = { ...env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}`, XDG_STATE_HOME: path.join(HOME, ".local/state") };
  delete real.HYPRPI_SOCKET; delete real.HYPRPI_STATE;
  const sock = path.resolve(socketPath(env)), wantSock = path.resolve(socketPath(real));
  if (sock !== wantSock) return `socket ${sock} isn't the real one (${wantSock})`;
  const st = path.resolve(stateDir(env)), wantSt = path.resolve(stateDir(real));
  if (st !== wantSt) return `state dir ${st} isn't the real one (${wantSt})`;
  return "";
}

export const CONFIG_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi", "config.json");

export const DEFAULT_CONFIG = {
  // How rooms are formed: "world" (hyprwrlds: A = ws 1-10, B = 11-20, ...),
  // "workspace" (one room per workspace), or "single" (one room for everything).
  rooms: "world",
  // The workshop world (a world letter such as "D", or a group name): /tinker drops
  // friction fixes off there, to one free agent (a new one opens if none is free).
  workshop: "",
  // Optional named groups that override the mode: { "Research": [1, 2, 13] }.
  groups: {},
  // true: an agent moved to another world/workspace moves to that room.
  // false: it stays in the room where it was born.
  follow: true,
  // Folder new agents start in, when the focused window gives none (see
  // cwdFromFocused). Falls back to ~ when the folder doesn't exist.
  cwd: "~/Work",
  // SUPER+A in a terminal or agent window starts the new agent in that folder.
  cwdFromFocused: true,
  // Agents on these workspaces leave their room until moved out (Reprieve).
  offLimitsWorkspaces: ["special:reprieve"],
  // Terminal + agent commands. terminal: "auto" = Omarchy's default terminal
  // (xdg-terminal-exec), or kitty/foot/alacritty/ghostty; terminalCommand
  // overrides it for anything else (see lib/terminal.mjs).
  terminal: "auto",
  terminalCommand: null,
  // Agent windows also load terminal-helpers/<terminal>/ settings (kitty: pi.conf).
  terminalHelpers: true,
  pi: "pi",
  piArgs: [],
  worldSize: 10,
  // Dismissed windows go to the nearest workspace with fewer than this many tiled windows (summon & dismiss).
  dismissCap: 4,
  // Model for the search window's AI mode (pi --model).
  searchModel: "claude-haiku-4-5",
  // chime: the daemon plays a chime (herdr's done sound) when an agent goes from working to done.
  // chimeGapSec: at most one chime per this many seconds (0 = every finish chimes, even together).
  chime: true,
  chimeGapSec: 0,
  // Add-ons (hypr/hyprpi.lua reads these two at Hyprland (re)load; the finder reads finderDetail).
  // finder: SUPER+SHIFT+SPACE finds an agent or project (Omarchy's top-bar toggle moves to
  // SUPER+ALT+B). false = off, Omarchy's keys untouched. finderDetail: a grey line under each row.
  finder: true,
  finderDetail: false,

  // ---- AI search (search panel, AI mode) ----------------------------------
  // One small-model call reads a slice of the room's history and returns a short
  // answer plus the entries it used as evidence (scrollable, jumpable). It reads
  // two kinds of text:
  //   * conversations: what was SAID (Angus's messages, agents' replies, room and
  //     agent-to-agent messages, the room log);
  //   * the activity stream: what was DONE (tool calls like "$ git commit …" or
  //     "edit Panel.qml", topics, joins/moves/renames). Needed for questions like
  //     "who changed bindings.lua?", which conversations alone can't answer.
  //
  // aiSearchChars: how much text the model reads per search, in characters
  // (~4 characters per token, so 110000 is ~28k tokens). More = wider coverage,
  // but slower and costlier. Newest entries first, spread across agents.
  aiSearchChars: 110000,
  // aiSearchActivityShare: the CAP on the activity stream's part of that reading
  // budget, 0..1. Why a cap: activity lines are many and short (every ls, read and
  // edit), so uncapped they would crowd out the conversations, where the reasons
  // and decisions are. Why 0.2: 20% of 110000 is 22000 characters, about 150
  // activity lines (each is trimmed to ~140), roughly a busy hour of tool calls in
  // a room, while 80% stays for conversation. Lines sharing words with the query
  // are picked first, then the newest. It is a cap, not a reservation: whatever
  // activity doesn't use goes to conversations. 0 = leave activity out; 1 = no cap.
  // Read on every search, so a change takes effect without restarting anything.
  aiSearchActivityShare: 0.2,

  // ---- Your folders (J190: defaults are Angus's layout; each falls back sensibly) ----
  // screenshotsDir: where panels save pasted images (pi-clipboard-*.png); /tmp when missing.
  screenshotsDir: "~/Screenshots",
  // notesDir: where /tinker agents write proposals and longer decisions. "" = ~/Obsidian/Tinker when
  // that folder exists, else ~/.local/share/hyprpi/notes.
  notesDir: "",
  // jotExtension: the pi-jot extension Thoughts loads (jot_save), if that file exists. Empty = look in
  // ~/Harness/pi-jot, then where `pi install` puts it (the pi-packages integration piece).
  jotExtension: "",
  // The phone app (remote-control/): folders it may read (the Files app and /file links), the one
  // folder it may write (uploads), and the Obsidian vault its [[wiki links]] resolve in.
  phone: {
    folders: ["~/Obsidian", "~/Work", "~/Downloads", "~/Documents", "~/Screenshots", "~/Phone"],
    uploadDir: "~/Phone",
    vault: "~/Obsidian",
  },
};

// "~/x" -> /home/you/x (and plain absolute paths unchanged).
export const expandHome = (p) => String(p || "").replace(/^~(?=$|\/)/, HOME);

// The configured folder for a key (J190), expanded; notesDir picks its default by what exists.
export function userDir(key, cfg = loadConfig()) {
  if (key === "notesDir") {
    if (cfg.notesDir) return expandHome(cfg.notesDir);
    const ob = path.join(HOME, "Obsidian", "Tinker");
    return fs.existsSync(ob) ? ob : path.join(HOME, ".local", "share", "hyprpi", "notes");
  }
  return expandHome(cfg[key] ?? DEFAULT_CONFIG[key]);
}

export function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { /* defaults */ }
  const cfg = { ...DEFAULT_CONFIG, ...user };
  cfg.phone = { ...DEFAULT_CONFIG.phone, ...(user.phone || {}) };
  cfg.cwd = String(cfg.cwd || "~").replace(/^~(?=$|\/)/, HOME);
  if (!fs.existsSync(cfg.cwd)) cfg.cwd = HOME; // J190: ~/Work isn't everyone's
  return cfg;
}

export const WORLD_LETTERS = "ABCDEFGHI";

export function worldOf(ws, size = 10) {
  if (!Number.isInteger(ws) || ws < 1) return null;
  return Math.floor((ws - 1) / size) + 1;
}

export function wsLabel(ws, size = 10) {
  const w = worldOf(ws, size);
  if (!w) return String(ws);
  const n = ((ws - 1) % size) + 1;
  return `${WORLD_LETTERS[w - 1] ?? w}${n}`;
}
