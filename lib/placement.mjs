// Where windows go when they have to leave a workspace (one rule for the daemon and bin/hyprpi, so
// the two can't drift; Blink, J18): the emptiest workspace of ws's world (fewest windows, never ws).
// Ties: the nearest to ws when near (panels, new agents: Angus, J16/J18 "nearest, emptiest"), else
// the lowest number (agents sent to a new home). list = hyprctl clients.
export function emptiestWs(list, ws, size = 10, near = false) {
  const base = Math.floor((ws - 1) / size) * size;
  let best = null, bestN = Infinity;
  for (let w = base + 1; w <= base + size; w++) {
    if (w === ws) continue;
    const n = list.filter((c) => c.workspace?.id === w).length;
    if (n < bestN || (near && n === bestN && Math.abs(w - ws) < Math.abs(best - ws))) { best = w; bestN = n; }
  }
  return best;
}

// Where a DISMISSED window goes (Angus, 2026-10-01: "I don't want them to go too far away … fill up to
// 4 per workspace before looking for the next empty one"): the nearest workspace of ws's world (never
// ws) that still has room for `need` more windows, cap (4) tiled windows in all (floating windows
// don't crowd the screen, so they don't count); at equal distance the lower one, like emptiestWs
// (ws-1 before ws+1). No workspace has room: the emptiest (nearest). list = hyprctl clients.
export function nearbyWs(list, ws, size = 10, need = 1, cap = 4) {
  const base = Math.floor((ws - 1) / size) * size;
  const tiled = (w) => list.filter((c) => c.workspace?.id === w && !c.floating).length;
  for (let d = 1; d < size; d++) {
    for (const w of [ws - d, ws + d]) {
      if (w <= base || w > base + size) continue;
      if (tiled(w) + need <= cap) return w;
    }
  }
  return emptiestWs(list, ws, size, true);
}
