#!/usr/bin/env node
// J420: the Stream's "highlights" view (lib/stream.mjs highlight() / highlights()): what it keeps and drops.
//   node test/stream-highlights.mjs     (exit 0 = pass)
import { highlight, highlights } from "../lib/stream.mjs";
const T = (kind, text, extra = {}) => ({ kind, text, ts: 0, who: { name: "x" }, ...extra });
const B = (op, h, text) => T("board", `${op} ${h}: ${text}`, { c: { op, h, text } });
const cases = [
  // in
  [T("angus", "fix the bar"), true, "Angus's own post"],
  [T("prompt", "Angus → Knock: do x"), true, "Angus's prompt"],
  [T("error", "error: Request timed out."), true, "an error event"],
  [T("notice", "✗ Connection error."), true, "✗ notice"],
  [T("notice", "⚠ CiteD stalled: hit its token budget"), true, "⚠ notice"],
  [T("post", "🔧 done: the key works"), true, "🔧 done"],
  [T("post", "🔧 decide: which one?"), true, "🔧 decide"],
  [T("post", "(workshop D #3) 🔧 stuck: no access"), true, "relayed 🔧 stuck"],
  [T("thoughts", "✓✓ J418 verified by KeyCheck418: passed"), true, "✓✓ verified"],
  [T("thoughts", "✗ J236 failed its check by Pocket: x"), true, "✗ failed"],
  [T("thoughts", "→ Knock (@omarchy) · brief J418 v1: do it"), true, "a brief"],
  [T("thoughts", "Remote ↩ Cause: the restart"), true, "a reply summary"],
  [B("add", "D3", "decide: which model key?"), true, "decide asked"],
  [B("done", "D2", "Angus chose 1b"), true, "decide answered (done)"],
  [B("edit", "D1", "ANSWERED by Angus (J332): sketches first"), true, "decide answered (edit)"],
  [T("talk", 'to Blink: drop-off from Angus: "click ids"'), true, "quotes Angus"],
  [T("demand", "asks Blink: Angus said \"yes let's push\""), true, "Angus said"],
  [T("talk", "to X: @Agf look at this"), true, "@-mentions the display name"],
  [T("talk", "to X: Angus (his words): fix it"), true, "Angus (his words)"],
  // out
  [T("thoughts", '↩ answered Remote: Angus: "yes" → ok'), false, "routine ↩ answered, even quoting Angus"],
  [T("thoughts", "⏰ X will be woken when Y ends: Angus said yes"), false, "⏰ wake-up"],
  [T("notice", "🔧 drop-off ab12: some text"), false, "the routing label"],
  [T("notice", "🌱 Pocket spawned NumCheck"), false, "🌱 orchestration"],
  [T("notice", "📨 Shareread reported (final)"), false, "📨 report note"],
  [T("upkeep", "🧹 reloaded Remote"), false, "upkeep"],
  [T("talk", "to X: a status for Angus later"), false, "mentions Angus without quoting"],
  [B("edit", "N3", "⟦J1 v1 · verified⟧ text"), false, "board edit bookkeeping"],
  [B("update", "", "where"), false, "where / next step"],
  [B("archive", "D2 N3", "x"), false, "archive"],
  [B("done", "N5", "J1 done"), false, "a done item"],
  [T("turn", 'Angus: "x" was handled'), false, "did line"],
  [T("tool", "✗ bash failed"), false, "tool line"],
  [T("topic", "Shortcut upload"), false, "topic"],
  [T("post", "Sweep tidied @system: archived N12"), false, "tidy post"],
  [T("aborted", "stopped (Esc)"), false, "stopped"],
];
let fails = 0;
for (const [it, want, what] of cases) { const got = highlight(it, "Agf"); if (got !== want) { fails++; console.log(`FAIL ${what}: got ${got}`); } }
// A tinker prompt event that repeats Angus's own "🔧 → Agent: text" room line shows once.
const dup = highlights([T("angus", "🔧 → Knock (picked by Thoughts-D): map the key", { ts: 1000 }), T("prompt", "Angus → Knock (tinker): map the key", { ts: 1500 })], "Agf");
if (dup.length !== 1 || dup[0].kind !== "angus") { fails++; console.log("FAIL tinker prompt dedupe:", dup.map((x) => x.kind)); }
console.log(fails ? `${fails} FAILED` : `all ${cases.length + 1} passed`);
process.exit(fails ? 1 : 0);
