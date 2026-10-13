// J530 (Angus: "no local Thoughts or any other local TUIs on remote worlds"): is world LETTER bound to a remote machine
// (~/.config/hyprpi/remote/<letter>.json, or the J469 name world-<letter>.json)? Then its Thoughts, room, board and panels live on
// that machine (omnistation/world X panel …), and the laptop runs none of its own for it.
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const dir = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "hyprpi", "remote");
let memo = { at: 0, set: new Set(), env: null };
// -> Set of letters bound to a remote machine (re-read at most every 5 s)
export function remoteWorlds(env = process.env) {
  if (Date.now() - memo.at < 5000 && memo.env === env) return memo.set;
  const set = new Set();
  try { for (const f of fs.readdirSync(dir(env))) { const m = /^(?:world-)?([a-i])\.json$/.exec(f); if (m) set.add(m[1].toUpperCase()); } } catch { /* none */ }
  memo = { at: Date.now(), set, env };
  return set;
}
export const isRemoteWorld = (letter, env = process.env) => remoteWorlds(env).has(String(letter || "").toUpperCase());
export const remoteBindingFile = (letter, env = process.env) => {
  const l = String(letter || "").toLowerCase(); if (!/^[a-i]$/.test(l)) return "";
  for (const f of [`${l}.json`, `world-${l}.json`]) { const p = path.join(dir(env), f); if (fs.existsSync(p)) return p; }
  return "";
};
// CLI: exit 0 when the letter is a remote world (for the panel launchers), 1 otherwise. No letter (review): the world the panel
// would open on, the daemon's current room (the active workspace's world)
const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url)); } catch { return false; } };
if (isMain()) {
  let l = String(process.argv[2] || "");
  if (!l) { try { const { request } = await import("./client.mjs"); l = (await request("room.current", {}, { timeout: 2000, timeoutMs: 2000 }))?.room || ""; } catch { /* no daemon: not remote */ } }
  process.exit(isRemoteWorld(l) ? 0 : 1);
}
