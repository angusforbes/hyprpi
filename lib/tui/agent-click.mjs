// Ctrl+click in the hyprpi panels (agents, room, search, board): jump to an agent's window,
// wherever it is (agent.focus switches to its workspace and focuses it), or open a link.
//
// Shared so all four panels agree on what counts as "an agent under the pointer":
// the longest live agent name at the start of the clicked word, after any icon, "@" or
// punctuation in front. Longest wins, so "Sankey[e]" (a /move twin) is not read as "Sankey",
// and names with brackets or "·" survive (the old per-panel matchers stripped trailing
// punctuation and never found "Sankey[e]"). A name must end at the word's end or before a
// non-letter, so "Sankeys" is not "Sankey".
//
// Pure (no terminal, no daemon): the panels pass their screen line and agent list in.

const seg = new Intl.Segmenter();
const graphemesOf = (s) => Array.from(seg.segment(String(s)), (x) => x.segment);

// The whitespace-delimited word under column x (1-based) of a plain-text screen line.
// gw(g) = the grapheme's cell width (the panels' own, so wide emoji line up the same).
export function wordAt(line, x, gw) {
  const cells = [];
  let col = 1;
  for (const g of graphemesOf(line || "")) { cells.push([col, g]); col += gw(g); }
  const i = cells.findIndex(([c, g], k) => c <= x && (cells[k + 1]?.[0] ?? c + gw(g)) > x);
  if (i < 0 || /\s/.test(cells[i][1])) return null;
  let a = i, b = i;
  while (a > 0 && !/\s/.test(cells[a - 1][1])) a--;
  while (b < cells.length - 1 && !/\s/.test(cells[b + 1][1])) b++;
  return cells.slice(a, b + 1).map(([, g]) => g).join("");
}

// A link in the word (https:// or file://), trailing punctuation dropped; or null.
export function urlIn(word) {
  const u = /(?:https?|file):\/\/\S+/.exec(word || "")?.[0];
  return u ? u.replace(/[)\].,;:!?'"]+$/, "") : null;
}

// The agent (from `agents`: objects with display and/or name) the word names, or null.
export function agentIn(word, agents) {
  const w = String(word || "").replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase(); // icon / @ / ( in front
  if (!w) return null;
  let best = null, bestLen = 0;
  for (const a of agents || []) {
    for (const n of [a.display, a.name]) {
      const k = String(n || "").toLowerCase();
      if (!k || k.length <= bestLen || !w.startsWith(k)) continue;
      const next = w.slice(k.length, k.length + 2);
      if (next && /^[\p{L}\p{N}]/u.test(next)) continue; // "Sankeys" is not "Sankey"
      best = a; bestLen = k.length;
    }
  }
  return best;
}

// What a word would be looked up as, for a "no live agent @X" note.
export const bareName = (word) => String(word || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}\]]+$/u, "");
