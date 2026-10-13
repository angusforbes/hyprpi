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

// J543 (parity: a remote world's bonks, dings and chimes never reached the laptop): the remote daemon's list carries its recent
// "notices" ({ ts, kind: bonk|ding|chime|request, id, name, icon, text }). Which ones to play now: not played already (st.played, by kind+id+ts; a first look
// only marks what is there, so nothing old replays when world-status starts), not older than 2 min, at most 4 at once (the rest next time). Updates st in place.
export function pickNotices(notices, st, now) {
  const list = (Array.isArray(notices) ? notices : []).filter((n) => n && Number.isFinite(Number(n.ts)) && /^(bonk|ding|chime|request)$/.test(String(n.kind)));
  st.played ||= {};
  const key = (n) => `${n.kind}|${n.id}|${n.ts}`;
  // (ParityCheck) no high-water mark: a backlog after an outage is played 4 at a time over the next looks, none lost
  if (!st.seeded) { st.seeded = true; for (const n of list) st.played[key(n)] = now; return []; }
  const out = list.filter((n) => now - Number(n.ts) < 120e3 && !st.played[key(n)]).sort((a, b) => a.ts - b.ts).slice(0, 4);
  for (const n of out) st.played[key(n)] = now;
  for (const [k, t] of Object.entries(st.played)) if (now - t > 600e3) delete st.played[k];
  return out.map((n) => ({ kind: String(n.kind), id: /^[a-i]-[a-z][a-z0-9-]{0,30}$/.test(String(n.id)) ? String(n.id) : "", name: String(n.name || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 60), icon: String(n.icon || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 16), text: String(n.text || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200) }));
}
