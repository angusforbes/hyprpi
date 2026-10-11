// J457 (Angus: "yes", to world G's panel showing "@gtest · @Beta @Beta @Alpha" and "@cube · @Alpha @hp-mv0nhs2cupk"):
// a project's members are stored as agent ids. An agent reopened under a NEW id with the same name (G's Alpha and Beta
// after restores) leaves its old id on the card, and an id the daemon has no record of comes back as the raw id. The
// panels show each member once, by name: shownMembers(ids, board, agents) drops ids whose name is unknown (the daemon
// returns the id itself) and keeps one id per name, a live one before a closed one, in the original order otherwise.
// The board data is untouched (the members list stays as written; a closed member still shows ✗ by its last name).
export function memberName(id, board, agents = []) {
  if (/^thoughts:/.test(id || "")) return board?.names?.[id] || id;
  const a = (agents || []).find((x) => x.id === id), n = board?.names?.[id];
  if (a) return a.display || a.name || n || "";
  return n && n !== id ? n : "";
}
export function shownMembers(ids, board, agents = []) {
  const live = (id) => (agents || []).some((x) => x.id === id) || (board?.live?.[id] && board.live[id] !== "closed");
  const byName = new Map();
  for (const id of ids || []) {
    const n = memberName(id, board, agents).replace(/^@/, "").toLowerCase();
    if (!n) continue;
    const had = byName.get(n);
    if (!had || (!live(had) && live(id))) byName.set(n, id);
  }
  const keep = new Set(byName.values());
  return (ids || []).filter((id, i, all) => keep.has(id) && all.indexOf(id) === i);
}
