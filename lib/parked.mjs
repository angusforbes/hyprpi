// J645 (P11 step 69a; Angus D8: "a project with no live agent shows as parked", D9: "grayed out instead of the world color …
// along with the parked indicator", 65a, 70a: board, agents panel and finder). Display only, from today's data: no record changes.
//
// The rule: a project is PARKED when it isn't archived and its writer (owner) is not a live agent, i.e. there is no writer, or
// the writer's pi isn't connected to the daemon now. A live agent parked in Reprieve still counts as live (it is running; P11's
// park closes the agent instead, 63a). Cards written by Thoughts (writer "thoughts:X": the inbox cards) are never parked:
// Thoughts starts when talked to. Only in PARKED_WORLDS for now (69a: world D first, then all worlds, H and I last).
export const PARKED_MARK = "⏸";
export const PARKED_WORLDS = new Set(["D"]);

export function projectParked(p, room, isLive, worlds = PARKED_WORLDS) {
  if (!p || !worlds.has(String(room || "").toUpperCase()) || p.status === "archived") return false;
  const w = String(p.writer || "");
  if (/^thoughts:/.test(w)) return false;
  return !w || !isLive(w);
}

// The panels mark their own copy of the board from their live agent list (so a writer closing or coming back shows at once,
// without waiting for a board event; the daemon's board.get also sends `parked` from the same rule). liveIds: the ids of the
// agents the daemon lists as live now. Returns the board.
export function markParked(board, liveIds, worlds = PARKED_WORLDS) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  for (const p of board?.projects || []) p.parked = projectParked(p, board.room, (id) => live.has(id), worlds);
  return board;
}
