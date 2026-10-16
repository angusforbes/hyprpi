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
    const ws = Number(r.workspace) || Number(r.opened?.ws); // (no windows there: its own workspace number, else the one it was opened for)
    out.push({ id: a.id, launch: a.launch, ws: Number.isInteger(ws) && ws >= lo && ws <= hi ? ws : lo });
  }
  return out;
}

// J543 (parity: a remote world's bonks, dings and chimes never reached the laptop): the remote daemon's list carries its recent
// "notices" ({ ts, kind: bonk|ding|chime|request, id, name, icon, text }). Which ones to play now: not played already (st.played, by kind+id+ts; a first look
// only marks what is there, so nothing old replays when world-status starts), not older than 2 min, at most 4 at once (the rest next time). Updates st in place.
export function pickNotices(notices, st, now) {
  const list = (Array.isArray(notices) ? notices : []).filter((n) => n && Number.isFinite(Number(n.ts)) && /^(bonk|ding|chime|request|closed)$/.test(String(n.kind)));
  st.played ||= {};
  const key = (n) => `${n.kind}|${n.id}|${n.ts}`;
  // (ParityCheck) no high-water mark: a backlog after an outage is played 4 at a time over the next looks, none lost
  if (!st.seeded) { st.seeded = true; for (const n of list) st.played[key(n)] = now; return []; }
  // J722 (nss5): a bonk/ding that is too old is counted (st.tooOld, reported by noticeSpell), not dropped silently; chimes, requests and
  // "closed" are routine and never counted.
  for (const n of list) if (now - Number(n.ts) >= 120e3 && !st.played[key(n)]) { st.played[key(n)] = now; if (n.kind === "bonk" || n.kind === "ding") st.tooOld = (st.tooOld || 0) + 1; }
  const out = list.filter((n) => now - Number(n.ts) < 120e3 && !st.played[key(n)]).sort((a, b) => a.ts - b.ts).slice(0, 4);
  for (const n of out) st.played[key(n)] = now;
  for (const [k, t] of Object.entries(st.played)) if (now - t > 600e3) delete st.played[k];
  return out.map((n) => ({ kind: String(n.kind), id: /^[a-i]-[a-z][a-z0-9-]{0,30}$/.test(String(n.id)) ? String(n.id) : "", name: String(n.name || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 60), icon: String(n.icon || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 16), text: String(n.text || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200) }));
}

// J722 (nss5, Angus's answer "a"): a remote world's bonks/dings that were skipped (too old) or whose play failed give ONE desktop
// toast per world per spell ("N bonks/dings from world X weren't played (...)") plus a log line; no more for that world until a
// bonk/ding plays fine again (the spell ends). ev: { played: n } | { failed: n, why } | (flush) {}; st.tooOld comes from pickNotices.
// ctx: { world, toast(title, body), log(line) }. Returns the toast text or "".
export function noticeSpell(st, ev, ctx) {
  const tooOld = st.tooOld || 0; st.tooOld = 0;
  if (ev?.played) st.warned = false;
  const failed = Number(ev?.failed) || 0;
  st.lost = (st.lost || 0) + tooOld + failed;
  const whys = new Set(st.whys || []); if (tooOld) whys.add("too old"); if (failed) whys.add(`failed: ${ev.why || "play failed"}`); st.whys = [...whys];
  if (!st.lost) return "";
  const n = st.lost, why = (st.whys || []).join("; "); st.lost = 0; st.whys = [];
  const text = `${n} bonk${n === 1 ? "" : "s"}/ding${n === 1 ? "" : "s"} from world ${ctx.world} weren't played (${why})`;
  ctx.log?.(text);
  if (st.warned) return "";
  st.warned = true; ctx.toast?.(`World ${ctx.world}: ${text}`, "");
  return text;
}
