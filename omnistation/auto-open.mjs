// J543 (parity: Thoughts-H's open_agent "reported Farside … as opened, but none ever came live" on the laptop): which of a remote
// world's agents get a laptop window by themselves. An agent the world's own daemon opened (open_agent / spawn_agent there; its list
// entry says "opened": { at, by }) is opened once, silently, on its own workspace, like a local open; never one that already has a
// window, one already opened once (seen: id -> when), or one started more than 15 min ago. Pure, for world-status.mjs and its test.
//   raw: the remote daemon's list entries; agents: world-status's (id, launch, address); lo/hi: the world's workspaces
export function pickAutoOpens(raw, agents, seen, now, lo, hi) {
  const out = [];
  for (const a of agents || []) {
    const r = (raw || []).find((x) => x && String(x.id) === a.id), at = Number(r?.opened?.at) || 0;
    if (!a.launch || a.address || !at || seen[a.id] || Math.abs(now - at) > 15 * 60e3) continue;
    const ws = Number(r.workspace);
    out.push({ id: a.id, launch: a.launch, ws: Number.isInteger(ws) && ws >= lo && ws <= hi ? ws : lo });
  }
  return out;
}
