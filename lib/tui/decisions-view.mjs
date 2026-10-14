// The projects panel's Decisions view (@hyprpi N68): every open Decide item on THIS world's cards,
// one after another, each with its project, the agent waiting, the question, the options and the
// recommendation, answered in place. Calm by design (Angus: "If I'm not making a decision it's
// because I have other priorities"): no counts in the bar, no sounds, no reminders.
//
// The list is lib/decisions.mjs's openDecisions() (shared with a later decisions pop-up). Keys, set
// by mockups/board-tui.mjs: ^↑↓ step through · "2⏎" (or Alt+2) picks option 2 · ⏎ alone takes the
// recommendation · "L⏎" (or Alt+L) puts it off (to the end of the list, kept) · any other words + ⏎
// answer in his own words (they may start with any letter or digit) · ^F or Esc back to the cards. An answer goes to the daemon (board.item decide): the item becomes a Next item
// holding the choice, and the card's writer and the asking agent are told at once.
//
// J555 W6 (Angus 20a): every world's open decisions, this world's first, then the others in letter order (lib/tui/world-decisions.mjs
// fetches them: local worlds from the laptop daemon, remote ones over their links), each labelled with its world (a remote one with
// 📡); a remote world whose link is down is one dim "📡 H offline (link down)" line. An answer goes to THAT world's daemon (the
// connection its board came from), exactly as for this world's own.
import { ESC, dim, bold, fg, nameFg, width, wrap, strip, theme, rgb, worldFg } from "./term.mjs";
import { remoteLink } from "../paths.mjs";
import { openDecisions } from "../decisions.mjs";
import { underlineRefs, refPid } from "./board-view.mjs"; // J421: refs underlined as on the cards (board-tui makes them clickable)

const mark = (s) => s === "working" ? "●" : s === "background" ? "◐" : s === "blocked" ? "×" : s === "done" ? "✓" : s === "closed" ? "✗" : "○";
const ago = (ts) => {
  if (!ts) return "";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

// others: () => [{ world, remote, board?, api?, offline?, why? }] (lib/tui/world-decisions.mjs worlds()), the other worlds
export function createDecisionsView({ others = () => [] } = {}) {
  const st = { cur: null, later: [], top: 0, moved: false, list: [], offline: [], lastAvail: 10 };
  const selfRemote = (w) => !!w && (remoteLink() === w || process.env.HYPRPI_REMOTE_PANEL === "1");
  function list(board, agents) {
    const own = openDecisions(board, { live: board?.live || {}, agents, later: st.later }).map((d) => ({ ...d, world: board?.room || "", remote: selfRemote(board?.room) }));
    const ws = (others() || []).filter((w) => w.world !== board?.room);
    st.offline = ws.filter((w) => w.offline);
    const rest = ws.filter((w) => w.board).flatMap((w) => openDecisions(w.board, { live: w.board.live || {}, agents: w.remote ? [] : agents })
      .map((d) => ({ ...d, key: `${w.world}/${d.key}`, world: w.world, remote: !!w.remote, api: w.api, board: w.board })));
    // "later" (L) puts one off to the end of the whole list, whichever world it is in
    const rank = (k) => { const i = st.later.indexOf(k); return i < 0 ? -1 : i; };
    return [...own, ...rest].sort((x, y) => rank(x.key) - rank(y.key));
  }
  const worldTag = (d) => d.world ? `${d.remote ? "📡 " : ""}${fg(worldFg(d.world), bold(d.world))} ` : "";
  const current = () => st.list.find((d) => d.key === st.cur) || st.list[0] || null;

  // The list for this board (the panel calls it before drawing the prompt, which names the current one).
  function sync(board, agents = []) {
    st.list = list(board, agents);
    if (!st.list.some((d) => d.key === st.cur)) st.cur = st.list[0]?.key || null;
  }
  function frame({ board, room, W, avail, c, agents = [] }) {
    sync(board, agents); st.lastAvail = avail;
    const rows = [], items = [];
    const push = (line, mi = null) => rows.push({ line, msg: mi });
    const refs = (l, mi) => items[mi]?.other ? l : underlineRefs(l, board, refPid(items[mi]?.key)); // J421 (another world's refs aren't this board's: not underlined)
    const para = (indent, text, mi, style = (s) => s) => { for (const l of wrap(text, Math.max(10, W - indent - 1))) push(" ".repeat(indent) + style(refs(l, mi)), mi); };
    if (!st.list.length) {
      const seen = [board?.room || room, ...(others() || []).filter((w) => w.board && w.world !== (board?.room || room)).map((w) => w.world)];
      push("");
      push("   " + dim(`nothing waiting on you in world${seen.length > 1 ? "s " + seen.join(", ") : " " + seen[0]} ✓`));
      push("   " + dim("decisions agents ask for land here (^F or Esc: the cards)"));
    }
    st.list.forEach((d, i) => {
      const { p, it, waiting } = d, on = d.key === st.cur;
      const other = !!d.api, dc = other ? worldFg(d.world) : c;
      const mi = items.push({ copy: `${other ? d.world + ": " : ""}@${p.name} ${it.h} ${it.text}${(it.options || []).map((o) => ` ${o.key}) ${o.text}`).join("")}`, key: d.key, world: d.world, other }) - 1;
      if (i) push("", null);
      const a = d.remote && other ? null : agents.find((x) => x.id === waiting.id);
      const who = `${mark(waiting.status)} ${a?.icon ? a.icon + " " : ""}${a ? nameFg(a.name, a.color, "@" + waiting.name) : bold("@" + waiting.name)}`;
      const later = st.later.includes(d.key) ? "  " + dim("· later") : "";
      push(`${on ? fg(c, bold("▸")) : " "} ${worldTag(d)}${p.icon || "📋"} ${fg(dc, bold(p.unfiled ? "unfiled" : "@" + p.name))} ${fg(dc, bold(it.h))}   ${dim("waiting:")} ${who}  ${dim(ago(it.ts))}${later}`, mi);
      para(5, it.text, mi, on ? bold : (s) => s);
      (it.options || []).forEach((o, k) => {
        const rec = o.key === it.recommend ? "  " + fg(c, "★ recommended") : "";
        const dflt = o.key === it.default ? dim(" (default)") : "";
        const lead = `     ${on && k < 9 ? fg(c, bold(String(k + 1))) : " "} ${fg(dc, bold(o.key + ")"))} `;
        const ls = wrap(o.text, Math.max(10, W - width(strip(lead)) - 1));
        ls.forEach((l, j) => push((j ? " ".repeat(width(strip(lead))) : lead) + refs(l, mi) + (j === ls.length - 1 ? dflt + rec : ""), mi));
      });
      if (!it.options?.length) push("     " + dim("no options: type your answer"), mi);
      if (on) {
        const n = Math.min(9, it.options?.length || 0);
        const rec = it.options?.find((o) => o.key === it.recommend);
        push("     " + dim([n ? `1${n > 1 ? "–" + n : ""} + ⏎ picks (Alt+1${n > 1 ? "…" + n : ""} at once)` : "", rec ? `⏎ alone takes ★ ${rec.key})` : "", "or type an answer + ⏎", "L⏎ later", "^↑↓ next"].filter(Boolean).join(" · ")), mi);
      }
    });
    // Remote worlds that can't be reached now: one calm line each.
    if (st.offline.length) { push("", null); for (const w of st.offline) push("   " + dim(`${w.remote ? "📡 " : ""}${w.world} offline (${w.why || "link down"})`), null); }
    // The current item in view and on the selection background.
    const ci = items.findIndex((x) => x.key === st.cur);
    if (ci >= 0) {
      const r0 = rows.findIndex((r) => r.msg === ci), r1 = rows.findLastIndex((r) => r.msg === ci);
      if (st.moved) { if (r0 < st.top) st.top = Math.max(0, r0 - 1); else if (r1 >= st.top + avail) st.top = r1 - avail + 1; st.moved = false; }
      for (const r of rows) if (r.msg === ci) r.line = paintBg(r.line, W);
    }
    st.top = Math.max(0, Math.min(st.top, rows.length - avail));
    const shown = rows.slice(st.top, st.top + avail);
    while (shown.length < avail) shown.push({ line: "", msg: null });
    const below = rows.length - st.top - avail;
    const n = st.list.length;
    const label = `decisions ${board?.room || room} · ${n ? `${n} waiting` : "none"} · ^F cards` + (st.top > 0 ? ` · ↑ ${st.top} above` : "") + (below > 0 ? ` · ↓ ${below} below` : "");
    return { rows: shown, items, label };
  }

  function step(dir) {
    if (!st.list.length) return false;
    const i = Math.max(0, st.list.findIndex((d) => d.key === st.cur));
    st.cur = st.list[Math.max(0, Math.min(st.list.length - 1, i + dir))].key; st.moved = true;
    return true;
  }
  // L: to the end of the list (kept, only out of the way); the cursor goes to the next one.
  function later() {
    const d = current(); if (!d) return null;
    const i = st.list.indexOf(d);
    st.later = [...st.later.filter((k) => k !== d.key), d.key];
    const next = st.list.filter((x) => x !== d)[Math.min(i, st.list.length - 2)];
    st.cur = next?.key || d.key; st.moved = true;
    return d;
  }
  // how: { option: 0-based index } | { recommend: true } | { text }. → { note } (throws on a refusal)
  // d0: the decision the answer was typed for, frozen when it was sent (LinkCheck: an upload in between could let the selection
  // move, and the text went to another decision); it must still be open
  async function answer(api, room, how, d0 = null) {
    const d = d0 ? st.list.find((x) => x.key === d0.key && x.world === d0.world) : current();
    if (!d) throw new Error(d0 ? `${d0.it?.h || "that decision"} changed while sending: not answered` : "nothing to decide here");
    const { p, it } = d;
    const conn = d.api || api, wroom = d.api ? d.world : room; // J555 W6: another world's answer goes to that world's daemon
    if (!conn) throw new Error(d.api ? `world ${d.world} can't be reached` : "daemon offline");
    let params;
    const where = p.unfiled ? { unfiled: true, project: "unfiled" } : { project: p.id };
    if (how.text != null) params = { answer: how.text, typed: true };
    else if (how.recommend) {
      const o = it.options?.find((x) => x.key === it.recommend);
      if (!o) throw new Error(`${it.h} has no recommendation: ${it.options?.length ? `1–${Math.min(9, it.options.length)} picks, or type an answer` : "type your answer"}`);
      params = { answer: o.key };
    } else {
      const o = it.options?.[how.option];
      if (!o) throw new Error(`${it.h} has ${it.options?.length || 0} option${it.options?.length === 1 ? "" : "s"}${it.options?.length ? "" : ": type your answer"}`);
      params = { answer: o.key };
    }
    const i = st.list.indexOf(d), rest = st.list.filter((x) => x !== d);
    const r = await conn.call("board.item", { room: wroom, action: "decide", h: it.h, ...where, ...params });
    st.later = st.later.filter((k) => k !== d.key);
    st.cur = rest[Math.min(i, rest.length - 1)]?.key || null; st.moved = true;
    const told = r.told?.length ? " · told " + r.told.join(", ") : "";
    const w = d.api ? `${d.remote ? "📡 " : ""}${d.world}: ` : "";
    return { world: d.api ? d.world : "", note: w + (p.unfiled ? `unfiled ${it.h} → ${r.item?.resolution || params.answer}${told}` : `@${p.name} ${it.h} → ${r.item?.resolution || params.answer} · now ${r.item?.h || it.h} in Next${told}`) };
  }
  function pick(row, items) { const k = row?.msg != null ? items[row.msg]?.key : null; if (k) { st.cur = k; return true; } return false; }
  const scroll = (n) => { st.top = Math.max(0, st.top - n); };
  const page = () => Math.max(1, st.lastAvail - 2);

  return { st, sync, frame, step, later, answer, pick, scroll, page, current };
}

function paintBg(line, W) {
  const bg = theme.muted || theme.selection;
  const on = bg ? `${ESC}48;2;${rgb(bg)}m` : `${ESC}7m`, off = bg ? `${ESC}49m` : `${ESC}27m`;
  const body = line.replace(/\x1b\[(?:0|49|27)?m/g, (m) => m + on);
  return on + body + " ".repeat(Math.max(0, W - width(strip(line)))) + off;
}
