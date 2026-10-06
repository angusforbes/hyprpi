// J165 (Angus: 'maybe a "Sent message to" ... and then list the names of agents it got sent to'): the one
// confirmation line every panel box shows after a send, built from the daemon's delivery result (who it
// was actually delivered to, and who is mid-turn and gets it when that turn ends). Pure, no imports.
//
// r.recipients: [{ name, owner?, thoughts?, busy? }] (board.request, agent.prompt, room.post)
//   project: "@intro-video" for an @project send
export function sentLine(r = {}, { project = "", max = 4 } = {}) {
  const rs = Array.isArray(r.recipients) ? r.recipients : [];
  if (!rs.length) return r.persistence === "saved" ? "✓ Saved · no agent here to send it to yet" : "✗ not delivered to anyone (nobody live)";
  const label = (x) => x.owner && project ? `${x.name} (owner of ${project})` : x.thoughts ? `${x.name} (it routes room messages)` : x.name;
  const shown = rs.slice(0, max).map(label), more = rs.length - shown.length;
  let s = `✓ Sent to ${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`;
  const busy = rs.filter((x) => x.busy).map((x) => x.name);
  if (busy.length === 1) s += ` · ${busy[0]} is working: gets it when its turn ends`;
  else if (busy.length > 1) s += ` · ${busy.length <= 3 ? busy.join(", ") : busy.length + " of them"} working: they get it when their turns end`;
  if (r.fallback) s += ` · ${r.fallback}`;
  return s;
}

// How long a "✓ Sent …" line stays even while Angus types (ms).
export const SENT_STICKY_MS = 10000;
