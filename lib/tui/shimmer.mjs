// The "thinking" shimmer, shared by the search panel (while a search runs) and the board
// view (while a project's agents work on a request): a bright band sweeps across the text
// in the world's colour, the rest dim. createAnim() redraws every ANIM_MS, and only while
// something is busy: sync(false) stops the timer, so an idle panel uses no CPU.
import { ESC } from "./term.mjs";

export const ANIM_MS = 90;

// text: plain text · c: an SGR colour (worldFg(room)) · startedAt: when the band starts (ms).
export function shimmer(text, c, startedAt = 0) {
  const cs = [...text], span = cs.length + 8, p = Math.floor((Date.now() - (startedAt || 0)) / ANIM_MS) % span - 4;
  return cs.map((ch, i) => { const d = Math.abs(i - p); return d === 0 ? `${ESC}1;${c}m${ch}` : d <= 2 ? `${ESC}22;${c}m${ch}` : `${ESC}2;${c}m${ch}`; }).join("") + `${ESC}22;39m`;
}

// const anim = createAnim(render); … anim.sync(isBusy) on every frame / state change.
export function createAnim(render, ms = ANIM_MS) {
  let timer = null;
  return {
    sync(busy) {
      if (busy && !timer) timer = setInterval(render, ms);
      else if (!busy && timer) { clearInterval(timer); timer = null; }
    },
    get running() { return !!timer; },
  };
}
