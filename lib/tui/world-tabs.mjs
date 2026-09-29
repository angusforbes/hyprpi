// The world tabs in each panel's bottom status bar (" A  B  C …", 3 cells each, right after the
// bar's left label): a click on one switches THIS panel to that world, the same as Ctrl+Tab
// stepping there (Angus: only this panel, the others stay where they are).
//
// bar: { y, x0 } from the last draw: y = the bar's screen row (1-based), x0 = the width of the
// left label (the tabs start in the next column). ids: the world ids in tab order.
export function worldTabAt(bar, x, y, ids) {
  if (!bar || y !== bar.y || !Array.isArray(ids)) return null;
  const i = Math.floor((x - 1 - bar.x0) / 3);
  return x - 1 >= bar.x0 && i >= 0 && i < ids.length ? ids[i] : null;
}
// The step Ctrl+Tab would need to go from `cur` to `want` (the panels' cycle(d) takes a step).
export function stepTo(ids, cur, want) {
  const i = ids.indexOf(cur), j = ids.indexOf(want);
  return j < 0 || i === j ? 0 : j - Math.max(0, i);
}
