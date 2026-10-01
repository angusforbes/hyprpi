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
