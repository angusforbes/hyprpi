// J165 (Angus: 'maybe a "Sent message to" ... and then list the names of agents it got sent to'): the one
// confirmation line every panel box shows after a send, built from the daemon's delivery result (who it
// was actually delivered to, and who is mid-turn and gets it when that turn ends).
import { width, graphemes, gw } from "./term.mjs";
//
// r.recipients: [{ name, owner?, thoughts?, busy? }] (board.request, agent.prompt, room.post)
//   project: "@intro-video" for an @project send
//   width: the columns it has; shorter wordings are tried until it fits (Sentcheck: 80 columns cut "turn ends")
//   lead: what starts the line instead of "✓ Sent to " (e.g. "✓ @vid N2 sent to "), counted in the width
export function sentLine(r = {}, { project = "", max = 4, width = 0, lead = "✓ Sent to " } = {}) {
  const rs = Array.isArray(r.recipients) ? r.recipients : [];
  if (!rs.length) return r.persistence === "saved" ? "✓ Saved · no agent here to send it to yet" : "✗ not delivered to anyone (nobody live)";
  const busy = rs.filter((x) => x.busy).map((x) => x.name);
  const variant = (short, n, anon = false) => {
    const label = (x) => anon && x.busy ? `${x.name} (${x.owner && project ? "owner, " : ""}busy: gets it after its turn)` : x.owner && project ? `${x.name} (${short ? "owner" : "owner of " + project})` : x.thoughts && !short ? `${x.name} (it routes room messages)` : x.name;
    const shown = rs.slice(0, n).map(label), more = rs.length - shown.length;
    let s = `${lead}${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`;
    if (busy.length === 1) s += anon ? (rs.slice(0, n).some((x) => x.busy) ? "" : " · 1 busy: after its turn") : short ? ` · ${busy[0]} busy: gets it after its turn` : ` · ${busy[0]} is working: gets it when its turn ends`;
    else if (busy.length > 1) s += short ? ` · ${busy.length} busy: they get it after their turns` : ` · ${busy.length <= 3 ? busy.join(", ") : busy.length + " of them"} working: they get it when their turns end`;
    if (r.fallback) s += ` · ${r.fallback}`;
    return s;
  };
  // Smallest: a count, the busy ones not named again; then a hard cut (Sentcheck: long names at 80 columns).
  const count = `${lead}${rs.length} agent${rs.length === 1 ? "" : "s"}${busy.length ? ` · ${busy.length === rs.length ? (rs.length === 1 ? "busy" : "all busy") : busy.length + " busy"}: after the turn` : ""}`;
  const tries = [variant(false, max), variant(true, max), variant(true, 2), variant(true, 1), variant(true, 1, true), count];
  if (!(width > 0)) return tries[0];
  const fit = tries.find((t) => cells(t) <= width);
  return fit || cut(count, width);
}
// Terminal cells, the panels' own rule (lib/tui/term.mjs; Sentcheck: ⚡ is 2 cells there).
const cells = (s) => width(s);
function cut(s, w) { let out = "", n = 0; for (const g of graphemes(s)) { const c = gw(g); if (n + c > w - 1) return out + "…"; out += g; n += c; } return out; }

// How long a "✓ Sent …" line stays even while Angus types (ms).
export const SENT_STICKY_MS = 10000;
