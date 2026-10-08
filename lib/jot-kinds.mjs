// pi-jot's kinds as hyprpi sees them (J229, Angus: "i sent this exactly the first time and you didn't get
// it: /idea An idea for a comparison, a film, …"). The Thoughts panel knew no jot commands, so "/idea …"
// was an unknown command and nothing was sent. pi-jot's config (~/.pi/agent/jot.json, or PI_JOT_CONFIG)
// names each kind and its command (here: note → /jot-note, idea → /jot-idea, …); the bare kind name
// (/idea, /note) is accepted too when it isn't another command. Re-read on every call, like pi-jot does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_KINDS = ["note", "idea", "poem", "todo"]; // pi-jot's built-ins (core.ts DEFAULTS)
export const jotConfigPath = () => process.env.PI_JOT_CONFIG || path.join(os.homedir(), ".pi", "agent", "jot.json");

// [{ kind, command, description }] for every enabled kind.
export function jotKinds() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(jotConfigPath(), "utf8")).kinds || {}; } catch { /* no config: the built-ins */ }
  const names = [...new Set([...DEFAULT_KINDS, ...Object.keys(user)])];
  return names.map((kind) => ({ kind, ...(user[kind] || {}) }))
    .filter((k) => k.enabled !== false)
    .map((k) => ({ kind: k.kind, command: String(k.command || k.kind).replace(/^\//, ""), description: k.description || `Save a ${k.kind} (pi-jot)` }));
}

// "/idea text" | "/jot-idea text" | "/ idea text" → { kind, command, args } (null when it isn't a jot command).
export function parseJot(text, { taken = [] } = {}) {
  const m = /^\/\s*([\w-]+)(?:\s+([\s\S]*))?$/.exec(String(text || "").trim());
  if (!m) return null;
  const name = m[1].toLowerCase(), args = (m[2] || "").trim();
  const ks = jotKinds();
  const k = ks.find((x) => x.command.toLowerCase() === name) || (!taken.includes("/" + name) && ks.find((x) => x.kind.toLowerCase() === name));
  return k ? { kind: k.kind, command: k.command, args } : null;
}
