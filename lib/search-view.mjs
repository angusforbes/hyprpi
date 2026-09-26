// Search / ask view for the terminal room (mockups/room-tui.mjs): state plus
// one-line result rendering. The daemon does the work ("search", "ask"); this
// only keeps the query, results and selection, and draws them.
//
// Rendering needs the TUI's text helpers (grapheme widths, clipping, colours),
// passed in as `t` so every width is measured the same way as the rest of
// the screen: { width, clip, dim, bold, italic, hexFg, rgb, theme }.

// Slash commands of the room TUI's input line (for the hint line, Tab and /help).
export const COMMANDS = [
  ["/room", "room messages + agent-to-agent (back to the stream)"],
  ["/stream", "the stream; /stream WORDS shows only rows with those words, /stream alone clears"],
  ["/search", "search this room's conversations; /search WORDS runs it (Alt+S toggles)"],
  ["/ai", "/ai DESCRIPTION: search by meaning (a small model picks matches)"],
  ["/ask", "/ask QUESTION: a one-shot short answer with cited lines"],
  ["/new", "/new [DIR]: open a new agent"],
  ["/help", "this list"],
];
export const commandNames = COMMANDS.map(([c]) => c);
// Commands that start with the typed prefix ("/s" -> /stream, /search).
export const completions = (prefix) => commandNames.filter((c) => c.startsWith(prefix.toLowerCase()));

export function when(ts) {
  const d = new Date(ts), now = new Date(), p = (x) => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleString("en", { month: "short" })} ${d.getDate()} ${hm}`;
}
const ROLE = { angus: "Angus", agent: "agent", room: "room", talk: "talk" };
const flat = (s) => String(s || "").replace(/\s+/g, " ");

// ---- state ------------------------------------------------------------------
// onChange() is called whenever something visible changed (the TUI re-renders).
// only(): agent ids to restrict search / ask to (the agent list's marked agents; empty = whole room).
export function createSearch({ api, room, onChange, only = () => [] }) {
  const s = {
    mode: "keyword", query: "", results: [], status: "", busy: false, selected: -1, top: 0, gen: 0, ranFor: null,
    ask: { question: "", answer: "", citations: [], model: "", status: "", busy: false, gen: 0 },

    run(query, mode = s.mode) {
      const q = String(query || "").trim(), g = ++s.gen;
      s.mode = mode; s.query = q;
      if (!q) { s.results = []; s.selected = -1; s.busy = false; s.status = mode === "ai" ? "describe what you're looking for, then Enter" : "type words, then Enter"; return onChange(); }
      const a = api(); if (!a) { s.status = "✗ daemon offline"; return onChange(); }
      const ids = only();
      s.busy = true; s.ranFor = { q, mode, room: room(), only: ids.join(",") };
      s.status = mode === "ai" ? "thinking… (reading the room's recent conversations)" : "searching…";
      onChange();
      a.call("search", { room: room(), query: q, mode, agents: ids.length ? ids : undefined }, { timeoutMs: 180000 }).then((r) => {
        if (g !== s.gen) return;
        s.busy = false; s.results = r.results || []; s.selected = s.results.length ? 0 : -1; s.top = 0;
        const ms = r.ms >= 1000 ? (r.ms / 1000).toFixed(1) + " s" : (r.ms ?? "?") + " ms";
        s.status = `${s.results.length} hit${s.results.length === 1 ? "" : "s"} · ${r.sources} sources${r.scanned ? " · " + r.scanned + " entries read" : ""} · ${ms}`;
        onChange();
      }).catch((e) => { if (g !== s.gen) return; s.busy = false; s.results = []; s.selected = -1; s.status = "✗ " + e.message; onChange(); });
    },
    // Room changed (Tab): old results no longer apply.
    reset() { s.gen++; s.busy = false; s.results = []; s.selected = -1; s.top = 0; s.ranFor = null; s.status = s.query ? `Enter to search room ${room()}` : ""; s.ask.gen++; s.ask.busy = false; },
    toggleMode() { s.mode = s.mode === "ai" ? "keyword" : "ai"; s.gen++; s.busy = false; s.results = []; s.selected = -1; s.ranFor = null; s.status = s.query ? "Enter to search " + (s.mode === "ai" ? "by meaning" : "exact words") : ""; onChange(); },
    move(d) { if (!s.results.length) return; s.selected = Math.max(0, Math.min(s.results.length - 1, s.selected + d)); onChange(); },
    current() { return s.results[s.selected]; },

    askQuestion(question) {
      const q = String(question || "").trim(), A = s.ask, g = ++A.gen;
      A.question = q; A.answer = ""; A.citations = []; A.model = "";
      if (!q) { A.busy = false; A.status = "type a question, then Enter"; return onChange(); }
      const a = api(); if (!a) { A.status = "✗ daemon offline"; return onChange(); }
      A.busy = true; A.status = "asking…"; onChange();
      const ids = only();
      a.call("ask", { room: room(), question: q, agents: ids.length ? ids : undefined }, { timeoutMs: 120000 }).then((r) => {
        if (g !== A.gen) return;
        A.busy = false; A.answer = String(r.answer || ""); A.citations = Array.isArray(r.citations) ? r.citations : []; A.model = r.model || "";
        A.status = A.answer ? "" : "no answer"; onChange();
      }).catch((e) => {
        if (g !== A.gen) return;
        A.busy = false;
        A.status = /unknown method|no such method|not a method/i.test(e.message) ? "✗ the daemon has no \"ask\" yet (Quartermaster is adding it)" : "✗ " + e.message;
        onChange();
      });
    },
  };
  return s;
}

// ---- rendering ----------------------------------------------------------------
// Heading label for the pane's rule.
export function searchLabel(s) {
  const kind = s.mode === "ai" ? "✦ ai" : "keyword";
  const q = s.ranFor?.q || s.query;
  const n = s.results.length;
  return `search · ${kind}${q ? ` · '${q}'` : ""}${s.ranFor && !s.busy ? ` · ${n} hit${n === 1 ? "" : "s"}` : ""} (Alt+S stream · ^/ ${s.mode === "ai" ? "keyword" : "ai"})`;
}

// One hit as one line (AI hits get a second, dim "↳ why" line):
//   <icon name> · when · role  …snippet with the MATCH in the world colour…
export function resultRows(r, selected, W, worldFg, t) {
  const nameBg = t.theme.muted || t.theme.selection;
  let nm = t.hexFg(r.color, t.bold(r.name || "?"));
  if (selected) nm = nameBg ? `\x1b[48;2;${t.rgb(nameBg)}m${nm}\x1b[49m` : `\x1b[4m${nm}\x1b[24m`;
  const head = `   ${r.icon ? r.icon + " " : ""}${nm}${r.live ? "" : t.dim(" (closed)")}` +
    t.dim(` · ${when(r.ts)} · ${ROLE[r.role] || r.role}${r.count > 1 ? " ×" + r.count : ""}`) + "  ";
  const room = Math.max(10, W - t.width(head));
  let pre = flat(r.pre).replace(/^\s+/, ""), match = flat(r.match), post = flat(r.post);
  // Keep the match in view: trim the text before it to about a third of the space.
  const maxPre = Math.floor(room / 3);
  if (t.width(pre) > maxPre) { const cs = [...pre]; while (cs.length && t.width(cs.join("")) > maxPre - 1) cs.shift(); pre = "…" + cs.join(""); }
  const hl = match ? `\x1b[1;${worldFg}m${match}\x1b[22;39m` : "";
  const rows = [t.clip(head + pre + hl + post, W)];
  if (r.why) rows.push(t.clip("     " + t.dim(t.italic("↳ " + flat(r.why))), W));
  return rows;
}

// Rows for the search pane: { line, i } (i = result index, for clicks).
export function searchRows(s, W, worldFg, t) {
  const rows = [];
  rows.push({ line: " " + (s.status.startsWith("✗") ? `\x1b[31m${s.status}\x1b[39m` : t.dim((s.busy ? "… " : "") + (s.status || (s.mode === "ai" ? "describe what you're looking for, then Enter" : "type words, then Enter · exact words, case-insensitive")))) });
  rows.push({ line: "" });
  s.results.forEach((r, i) => { for (const line of resultRows(r, i === s.selected, W, worldFg, t)) rows.push({ line, i }); });
  if (s.ranFor && !s.busy && !s.results.length && !s.status.startsWith("✗")) rows.push({ line: t.dim(s.mode === "ai" ? "   nothing matched that idea" : "   no exact matches") });
  return rows;
}

// Rows for the ask pane: the question, "asking…" or the answer, then the cited lines.
export function askRows(s, W, worldFg, t, wrap) {
  const A = s.ask, rows = [], textW = Math.max(10, W - 4);
  if (A.question) { for (const l of wrap("? " + A.question, textW)) rows.push("   " + `\x1b[${worldFg}m` + t.bold(l) + "\x1b[39m"); rows.push(""); }
  if (A.busy || A.status) rows.push("   " + (A.status.startsWith("✗") ? `\x1b[31m${A.status}\x1b[39m` : t.dim(A.status)));
  if (A.answer) for (const l of wrap(A.answer, textW)) rows.push("   " + l);
  if (A.citations.length) {
    rows.push(""); rows.push("   " + t.dim(`cited${A.model ? " · " + A.model : ""}`));
    for (const c of A.citations) {
      const head = `   ${t.dim("[" + (c.kind || "?") + "]")} ${t.bold(c.who || "?")}${c.ts ? t.dim(" · " + when(c.ts)) : ""}  `;
      rows.push(t.clip(head + flat(c.text), W));
    }
  }
  if (!rows.length) rows.push("   " + t.dim("ask a question about this room, then Enter · one-shot, no memory"));
  return rows;
}

export function helpRows(t) {
  const w = Math.max(...COMMANDS.map(([c]) => c.length));
  return [
    ...COMMANDS.map(([c, d]) => `   ${t.bold(c.padEnd(w))}  ${d}`),
    "",
    `   ${t.bold("//text".padEnd(w))}  posts "/text" to the room`,
    `   ${t.dim("keys: Alt+S stream ⇄ search · Ctrl+/ keyword ⇄ ai · ↑↓ result · ⏎ (empty) jump · Esc back · Tab room · ^F stream filter")}`,
  ];
}
