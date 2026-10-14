// J555 W6 (Angus 20a: "every world's Projects panel Decisions view (^F) shows ALL worlds' open decisions, H and I (remote worlds)
// over their links, marked 📡, and answerable there"): the OTHER worlds' boards for the projects panel's Decisions view
// (lib/tui/decisions-view.mjs). This world's own board stays the panel's (board-tui's board.get on its own connection).
//
//   local worlds (the laptop daemon's rooms, A…G): board.get { room } on the laptop daemon. A local panel's own connection IS
//     the laptop daemon; a link panel of a remote world (HYPRPI_REMOTE_LINK=H, running on the laptop) opens one more connection to
//     it (lib/paths.mjs socketPath(), which ignores HYPRPI_REMOTE_LINK). A sandboxed world (G: the daemon's list marks its Thoughts
//     "sandboxed") is left out: its host board is history, its real decisions are inside the sandbox, in G's own panels.
//   remote worlds (H, I: ~/.config/hyprpi/remote/<x>.json, or the daemon's list marks the room remote): board.get { room } through
//     the world's panel link (lib/paths.mjs linkSocket(X)), which only accepts connections while the link is up. It is never
//     started from here (no rlink, no ssh): a link that is down makes the world one "📡 H offline (link down)" line.
//   inside a sandboxed world (HYPRPI_SANDBOX_WORLD) or a panel running on a remote machine (HYPRPI_REMOTE_PANEL=1): no other
//     world can be reached, so there are none (as before).
//
// Fetched only while the Decisions view is shown (start / stop): entering it fetches at once, then every 10 s (calm: no sounds,
// no counts), and at once after a board event on a laptop-daemon connection for another world, or after an answer to one.
// stop() closes the connections this module opened, so a remote world's link isn't kept up by a panel showing its cards.
//
//   createWorldDecisions({ api: () => the panel's connection, room: () => this world, onChange })
//     .start() .stop() .refresh() .poke(room)   .worlds() → [{ world, remote, board?, api?, offline?, why? }] (letter order)
import { connect } from "../client.mjs";
import { socketPath, linkSocket, remoteLink } from "../paths.mjs";
import { remoteWorlds } from "../remote-world.mjs";

const POLL_MS = Number(process.env.HYPRPI_DECISIONS_POLL_MS) || 10000;
const LETTER = /^[A-I]$/;

export function createWorldDecisions({ api = () => null, room = () => "", onChange = () => {}, env = process.env } = {}) {
  const link = remoteLink(env), alone = !!env.HYPRPI_SANDBOX_WORLD || env.HYPRPI_REMOTE_PANEL === "1";
  let active = false, timer = null, busy = null, again = false, gen = 0;
  let laptop = null;          // a link panel's own connection to the laptop daemon (a local panel uses its api)
  const links = new Map();    // letter -> connection through that world's link
  let shown = [];             // the last result
  let sig = "";

  const laptopApi = async () => {
    if (!link) { const a = api(); return a && !a.closed ? a : null; }
    if (laptop && !laptop.closed) return laptop;
    laptop = null;
    try {
      const c = await connect({ path: socketPath(env), timeout: 1500, scrub: true, onEvent: (ev, data) => { if (ev === "board" && data?.room) poke(data.room); }, onClose: () => { if (laptop === c) laptop = null; } });
      if (!active) { c.close(); return null; }
      laptop = c;
      await c.call("ui.subscribe", { windows: false }, { timeoutMs: 4000 }).catch(() => null); // its board events: other worlds at once
      return c;
    } catch { return null; }
  };
  const linkApi = async (W) => {
    const old = links.get(W); if (old && !old.closed) return old;
    links.delete(W);
    // connecting never starts the link: its socket only listens while it is up (omnistation/rlink.mjs)
    const c = await connect({ path: linkSocket(W, env), timeout: 1500, scrub: true, onClose: () => { if (links.get(W) === c) links.delete(W); } });
    if (!active) { c.close(); throw new Error("stopped"); }
    links.set(W, c);
    return c;
  };

  async function fetchAll() {
    const me = String(room() || "").toUpperCase();
    if (alone || !me) return [];
    const out = [];
    const remote = new Set([...remoteWorlds(env)].filter((x) => LETTER.test(x)));
    if (link) remote.add(link);
    const lap = await laptopApi();
    let rooms = [];
    if (lap) {
      const l = await lap.call("list", {}, { timeoutMs: 5000 }).catch(() => null);
      const sbx = new Set((l?.thoughts || []).filter((t) => t.sandboxed).map((t) => t.room));
      for (const r of l?.rooms || []) { if (r.remote) remote.add(r.id); else if (LETTER.test(r.id) && !sbx.has(r.id)) rooms.push(r.id); }
      rooms = rooms.filter((r) => !remote.has(r) && r !== me);
      const got = await Promise.all(rooms.map((r) => lap.call("board.get", { room: r }, { timeoutMs: 5000 }).catch(() => null)));
      rooms.forEach((r, i) => { if (got[i]) out.push({ world: r, remote: false, board: got[i], api: lap }); });
    }
    const rs = [...remote].filter((r) => r !== me).sort();
    const got = await Promise.all(rs.map(async (W) => {
      let c = null;
      try { c = await linkApi(W); } catch { return { world: W, remote: true, offline: true, why: "link down" }; }
      try { return { world: W, remote: true, board: await c.call("board.get", { room: W }, { timeoutMs: 5000 }), api: c }; }
      catch (e) { if (/timed out/.test(e.message)) { try { c.close(); } catch { /* gone */ } } return { world: W, remote: true, offline: true, why: /closed/.test(e.message) ? "link down" : "no answer" }; }
    }));
    out.push(...got);
    return out.sort((a, b) => a.world.localeCompare(b.world));
  }

  async function refresh() {
    if (!active) return;
    if (busy) { again = true; return busy; }
    const g = gen;
    busy = (async () => {
      try {
        const w = await fetchAll();
        if (!active || g !== gen) return;
        shown = w;
        const s = JSON.stringify(w.map((x) => [x.world, x.offline ? x.why : x.board]));
        if (s !== sig) { sig = s; onChange(); }
      } catch { /* the next poll */ }
    })();
    try { await busy; } finally { busy = null; }
    if (again && active) { again = false; return refresh(); }
  }
  let pokeT = null;
  function poke(r) { if (!active || String(r || "").toUpperCase() === String(room() || "").toUpperCase()) return; clearTimeout(pokeT); pokeT = setTimeout(refresh, 150); }
  function start() {
    if (active) return refresh();
    active = true;
    timer = setInterval(refresh, POLL_MS); timer.unref?.();
    return refresh();
  }
  function stop() {
    if (!active) return;
    active = false; gen++; clearInterval(timer); timer = null; clearTimeout(pokeT);
    for (const c of links.values()) { try { c.close(); } catch { /* gone */ } }
    links.clear();
    if (laptop) { try { laptop.close(); } catch { /* gone */ } laptop = null; }
    shown = []; sig = "";
  }
  // a world switch (Ctrl+Tab): what was "other" changes
  function reset() { shown = []; sig = ""; if (active) { gen++; busy = null; refresh(); } }
  return { start, stop, refresh, poke, reset, worlds: () => shown, get active() { return active; } };
}
