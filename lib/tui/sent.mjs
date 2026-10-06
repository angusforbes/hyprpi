// J165 (Angus: 'maybe a "Sent message to" ... and then list the names of agents it got sent to'): the one
// confirmation line every panel box shows after a send, built from the daemon's delivery result (who it
// was actually delivered to, and who is mid-turn and gets it when that turn ends). Pure, no imports.
//
// r.recipients: [{ name, owner?, thoughts?, busy? }] (board.request, agent.prompt, room.post)
//   project: "@intro-video" for an @project send
//   width: the columns it has; shorter wordings are tried until it fits (Sentcheck: 80 columns cut "turn ends")
export function sentLine(r = {}, { project = "", max = 4, width = 0 } = {}) {
  const rs = Array.isArray(r.recipients) ? r.recipients : [];
  if (!rs.length) return r.persistence === "saved" ? "✓ Saved · no agent here to send it to yet" : "✗ not delivered to anyone (nobody live)";
  const busy = rs.filter((x) => x.busy).map((x) => x.name);
  const variant = (short, n) => {
    const label = (x) => x.owner && project ? `${x.name} (${short ? "owner" : "owner of " + project})` : x.thoughts && !short ? `${x.name} (it routes room messages)` : x.name;
    const shown = rs.slice(0, n).map(label), more = rs.length - shown.length;
    let s = `✓ Sent to ${shown.join(", ")}${more > 0 ? ` +${more}` : ""}`;
    if (busy.length === 1) s += short ? ` · ${busy[0]} busy: gets it after its turn` : ` · ${busy[0]} is working: gets it when its turn ends`;
    else if (busy.length > 1) s += short ? ` · ${busy.length} busy: they get it after their turns` : ` · ${busy.length <= 3 ? busy.join(", ") : busy.length + " of them"} working: they get it when their turns end`;
    if (r.fallback) s += ` · ${r.fallback}`;
    return s;
  };
  const tries = [variant(false, max), variant(true, max), variant(true, 2), variant(true, 1)];
  return (width > 0 && tries.find((t) => [...t].length <= width)) || (width > 0 ? tries[tries.length - 1] : tries[0]);
}

// How long a "✓ Sent …" line stays even while Angus types (ms).
export const SENT_STICKY_MS = 10000;
