// pi-jot's kinds as hyprpi sees them (J229, Angus: "i sent this exactly the first time and you didn't get
// it: /idea An idea for a comparison, a film, …"). The Thoughts panel knew no jot commands, so "/idea …"
// was an unknown command and nothing was sent. pi-jot's config (~/.pi/agent/jot.json, or PI_JOT_CONFIG)
// names each kind and its command (here: note → /jot-note, idea → /jot-idea, …); the bare kind name
// (/idea, /note) is accepted too when it isn't another command. Re-read on every call, like pi-jot does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pi-jot's built-ins (core.ts DEFAULTS): only what decides how a kind behaves (J233, Angus: "Not all the jots
// are only what's typed, some ask you to interpret it"). A kind of the user's own gets pi-jot's fallback.
const DEFAULTS = {
  note: { mode: "append", title: "auto", description: "Save a note exactly as typed (@Title picks the file; bare = summarise)" },
  idea: { mode: "append", title: "agent", description: "Save an idea exactly as typed; the agent picks a title (bare = from the conversation)" },
  poem: { mode: "append", title: "agent", compose: true, description: "Write a poem into its own file (optional direction: topic, subject; bare = from the conversation)" },
  todo: { mode: "list", description: "Todo lists: summary | <focus> | add <item> (kept exactly as typed) | done <item>" },
};
const FALLBACK = { mode: "append", title: "agent" };
const DEFAULT_KINDS = Object.keys(DEFAULTS);
export const jotConfigPath = () => process.env.PI_JOT_CONFIG || path.join(os.homedir(), ".pi", "agent", "jot.json");

// [{ kind, command, description }] for every enabled kind.
export function jotKinds() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(jotConfigPath(), "utf8")).kinds || {}; } catch { /* no config: the built-ins */ }
  const names = [...new Set([...DEFAULT_KINDS, ...Object.keys(user)])];
  return names.map((kind) => ({ kind, ...(DEFAULTS[kind] || FALLBACK), ...(user[kind] || {}) }))
    .filter((k) => k.enabled !== false)
    .map((k) => ({ kind: k.kind, command: String(k.command || k.kind).replace(/^\//, ""), description: k.description || `Save a ${k.kind} (pi-jot)`,
      mode: k.mode || "append", title: k.title || "agent", compose: !!k.compose, keepTyped: !!k.keepTyped }));
}

// What a /jot command will do, in a few words, the way pi-jot runs it (J233): typed text kept exactly, or
// interpreted by the model (a title picked, a poem composed, a list managed, a bare command written from
// the conversation). who = the agent that does the model part (e.g. "Thoughts-D").
export function jotWhat(k, args = "", who = "Thoughts") {
  const a = String(args || "").trim();
  if (k.mode === "list") return /^add\s/i.test(a) ? `${who} adds it to the list exactly as typed` : /^done\s/i.test(a) ? `${who} marks it done on the list` : a ? `${who} looks at the list for "${a}"` : `${who} summarises the list`;
  if (!a) return `${who} writes one from the conversation`;
  if (k.compose) return k.keepTyped ? `your words kept exactly as typed, then ${who}'s ${k.kind} after them` : `${who} writes the ${k.kind} from your direction`;
  if (/^@\S/.test(a) || k.title === "auto") return "saved exactly as typed";
  return `your text kept exactly as typed; ${who} picks the title`;
}

// "/idea text" | "/jot-idea text" | "/ idea text" → { kind, command, args } (null when it isn't a jot command).
export function parseJot(text, { taken = [], bare = true } = {}) {
  const m = /^\/\s*([\w-]+)(?:\s+([\s\S]*))?$/.exec(String(text || "").trim());
  if (!m) return null;
  const name = m[1].toLowerCase(), args = (m[2] || "").trim();
  const ks = jotKinds();
  const k = ks.find((x) => x.command.toLowerCase() === name) || (bare && !taken.includes("/" + name) && ks.find((x) => x.kind.toLowerCase() === name));
  return k ? { kind: k.kind, command: k.command, args } : null;
}
