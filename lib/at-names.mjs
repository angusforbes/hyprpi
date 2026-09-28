// @Names: the one notation for "which agents" in the room panel (who a message goes to)
// and the search panel (whose history to search). Plain text on purpose, so a set can be
// copied from one panel and pasted into the other. Names are written without their icon
// (@Lippy, @pi·vkrh), case-insensitive. Special words: @all / @everyone, @nobody / @none.

const AT = /(^|\s)@([^\s,@]+)/g;
export const SPECIAL = { all: "all", everyone: "all", nobody: "none", none: "none" };

// "@Lippy @Sankey kafka fact" -> { names: ["Lippy", "Sankey"], rest: "kafka fact" }
export function parseAt(text) {
  const names = [];
  const rest = String(text || "").replace(AT, (_m, pre, n) => { names.push(n.replace(/[.:;!?]+$/, "")); return pre; })
    .replace(/\s+/g, " ").trim();
  return { names, rest };
}

// True when the text is nothing but @names (a "to:" line on its own).
export const onlyAt = (text) => { const t = String(text || "").trim(); return t.startsWith("@") && !parseAt(t).rest; };

const norm = (s) => String(s || "").toLowerCase();
// agents: [{ id, name, display }]. -> { ids, found: [agent], unknown: [name], special: "all" | "none" | null }
export function resolveAt(names, agents) {
  const ids = [], found = [], unknown = [];
  let special = null;
  for (const n of names) {
    if (SPECIAL[norm(n)]) { special = SPECIAL[norm(n)]; continue; }
    const a = agents.find((x) => norm(x.display) === norm(n) || norm(x.name) === norm(n));
    if (!a) unknown.push(n);
    else if (!ids.includes(a.id)) { ids.push(a.id); found.push(a); }
  }
  return { ids, found, unknown, special };
}

// The @names of a set of agents, for showing (and copying) it.
export const atList = (agents) => agents.map((a) => "@" + (a.display || a.name)).join(" ");

// Tab: complete the @word ending at string index `at`. Returns { text, cursor, options,
// state } or null (no @word there). Pass the returned `state` back on the next Tab: while
// the text and cursor are unchanged since then, Tab steps through the SAME matches (the
// first Tab's list), dir = -1 steps back (Shift+Tab).
// First Tab: one match = complete it (plus a space); several = fill in their common
// prefix if that adds something, else the first match; the matches are listed.
export function completeAt(text, at, agents, state = null, dir = 1) {
  if (state && state.text === text && state.at === at && state.options.length > 1) {
    const n = state.options.length;
    const i = state.i < 0 ? (dir > 0 ? 0 : n - 1) : (state.i + dir + n) % n;
    const pick = state.options[i];
    const out = text.slice(0, state.start) + pick + text.slice(at);
    const cursor = state.start + pick.length;
    return { text: out, cursor, options: state.options, pick, state: { ...state, i, text: out, at: cursor } };
  }
  const before = text.slice(0, at), m = /(^|\s)@([^\s,@]*)$/.exec(before);
  if (!m) return null;
  const part = norm(m[2]), start = before.length - m[2].length, after = text.slice(at);
  const pool = [...agents.map((a) => a.display || a.name), "all", "nobody"];
  const options = [...new Set(pool)].filter((n) => norm(n).startsWith(part));
  if (!options.length) return { text, cursor: at, options, state: null };
  if (options.length === 1) {
    const ins = options[0] + (after.startsWith(" ") ? "" : " ");
    return { text: text.slice(0, start) + ins + after, cursor: start + ins.length, options, pick: options[0], state: null };
  }
  let p = options[0];
  for (const o of options) while (!norm(o).startsWith(norm(p))) p = p.slice(0, -1);
  const usePrefix = p.length > part.length, pick = usePrefix ? p : options[0];
  const out = text.slice(0, start) + pick + after, cursor = start + pick.length;
  return { text: out, cursor, options, pick, state: { options, start, i: usePrefix ? -1 : 0, text: out, at: cursor } };
}
