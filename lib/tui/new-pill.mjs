// The "↓ N new" pill (J247, Angus: "just like in the phone app, when i'm scrolled up reading something
// … and new info comes in, i don't want it to jump me to the bottom automatically. Rather, leave me
// where i am but provide an indicator that there's new messages/info below"; the phone's π app, J67/J230).
//
// A panel whose scrolling view keeps its place while scrolled up draws this pill over the right end of
// that view's LAST row, counting the new entries (messages, not lines) that arrived below since the
// reader left the bottom. A click on it (pillHit) or End / Ctrl+End goes back to the bottom, which
// clears it; so does sending a message. Shared by the Thoughts panel (search-tui) and the Stream
// panel (room-tui).
//
//   withPill(line, n, W, room)  -> { line, x0, x1 }  the row with the pill drawn at its right end
//                                  (x0..x1: the 1-based columns it covers, for clicks); n <= 0: as is
//   pillHit(pill, x, y)         -> true when a click at column x, row y lands on it
//                                  (pill: { y, x0, x1 }, y = the 1-based screen row it was drawn on)
import { ESC, width, clip, worldBg } from "./term.mjs";

export const pillLabel = (n) => ` ↓ ${n} new `;

export function withPill(line, n, W, room) {
  if (!(n > 0) || !(W > 12)) return { line, x0: 0, x1: 0 };
  const p = pillLabel(n), pw = width(p), at = Math.max(0, W - pw - 1); // one column of margin on the right
  const left = clip(String(line || ""), at);
  const gap = " ".repeat(Math.max(0, at - width(left)));
  // The world's colour, like the world tab in the footer (black text on it).
  return { line: `${left}${ESC}0m${gap}${ESC}${worldBg(room)};30;1m${p}${ESC}0m `, x0: at + 1, x1: at + pw };
}

export const pillHit = (pill, x, y) => !!pill && pill.x1 > 0 && y === pill.y && x >= pill.x0 && x <= pill.x1;
