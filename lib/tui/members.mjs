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
  // (J457check) unnamed agents ("pi·xxxx") and Thoughts members are keyed by their id: never merged with another
  const keyOf = (id) => { const n = memberName(id, board, agents).replace(/^@/, ""); return !n ? "" : /^thoughts:/.test(id) || /^pi·/.test(n) ? "id:" + id : "name:" + n.toLowerCase(); };
  const order = [], pick = new Map(); // a name's first position keeps it (the writer stays first); a live id wins it
  for (const id of ids || []) {
    const k = keyOf(id); if (!k) continue;
    if (!pick.has(k)) { order.push(k); pick.set(k, id); }
    else if (!live(pick.get(k)) && live(id)) pick.set(k, id);
  }
  return order.map((k) => pick.get(k));
}
