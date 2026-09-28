// Shared locations and config for hyprpi (daemon, CLI, Pi extension).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// One daemon per Hyprland instance, so a nested test Hyprland gets its own.
export function instanceKey(env = process.env) {
  const his = env.HYPRLAND_INSTANCE_SIGNATURE || "nohypr";
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
  // cwdFromFocused).
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
  // Model for the search window's AI mode (pi --model).
  searchModel: "claude-haiku-4-5",

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
};

export function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { /* defaults */ }
  const cfg = { ...DEFAULT_CONFIG, ...user };
  cfg.cwd = String(cfg.cwd || "~").replace(/^~(?=$|\/)/, HOME);
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
