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

// Tab: complete the @word ending at cursor position `at` (graphemes as a string index is
// fine: names are what we insert). -> { text, cursor, options } or null (not an @word).
export function completeAt(text, at, agents, cycleFrom = null) {
  const before = text.slice(0, at), m = /(^|\s)@([^\s,@]*)$/.exec(before);
  if (!m) return null;
  const part = norm(m[2]);
  const pool = [...agents.map((a) => a.display || a.name), "all", "nobody"];
  const options = [...new Set(pool)].filter((n) => norm(n).startsWith(part));
  if (!options.length) return { text, cursor: at, options };
  let pick = options[0];
  if (cycleFrom != null) pick = options[(options.indexOf(cycleFrom) + 1) % options.length];
  else if (options.length > 1) { // common prefix first
    let p = options[0];
    for (const o of options) while (!norm(o).startsWith(norm(p))) p = p.slice(0, -1);
    if (p.length > part.length) pick = p;
  }
  const start = before.length - m[2].length, after = text.slice(at);
  const full = options.includes(pick) && options.length === 1;
  const ins = pick + (full && !after.startsWith(" ") ? " " : "");
  return { text: text.slice(0, start) + ins + after, cursor: start + ins.length, options, pick };
}
