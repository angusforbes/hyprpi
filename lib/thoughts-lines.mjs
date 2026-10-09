// How a Thoughts thread entry is shown: the one rule shared by the desktop Thoughts window
// (mockups/search-tui.mjs buildThread) and the phone app (remote-control/, served to the browser
// as-is). Pure, no imports, so it runs in Node and in the browser. (J38, Remote, with Blink's OK.)
//
// Entries (lib/thoughts.mjs): { role: you | thoughts | action | reply | agent | note | evidence, text, from?, ts }
//
// threadKind(e):
//   "hidden"   incoming agent replies / messages (N53: Thoughts' own summary covers them; they stay
//              in its context and in /keyword /ask)
//   "answer"   Thoughts' answer to an agent ("answered @X: …"), shown as one short "↩ to X: …" line
//   "full"     Angus's messages and Thoughts' replies, in full
//   "action"   what Thoughts did on his behalf, a "↳ …" line (hand-offs, questions, interrupts,
//              revisions, stops, verifications, kept thoughts)
//   "error"    a failed action ("✗ …"), in red, no ↳
//   "evidence" /keyword, /ask, /digest results
//   "quiet"    hyprpi's automatic notes that need nothing from Angus (J147): not drawn (desktop or phone);
//              the daemon also writes them to the Stream's "all activity" view (kind "notice")
//   "note"     hyprpi's notes that need Angus or answer his action, dim: ⚠ alerts, 🔑 login, ✗ errors,
//              ⏹ interrupted, a room message handed back, the refresh divider
export const isAnswer = (e) => e?.role === "action" && /^answered @/.test(e.text || "");

export function threadKind(e) {
  const r = e?.role;
  if (r === "agent" || r === "reply") return "hidden";
  if (isAnswer(e)) return "answer";
  if (r === "you" || r === "thoughts") return "full";
  if (r === "action") return String(e.text || "").startsWith("✗") ? "error" : "action";
  if (r === "evidence") return "evidence";
  if (r === "note" && quietNote(e)) return "quiet";
  return "note";
}

// J147 (Angus: "if you're not commenting on it, don't include it … like you have some 'Keycheck reported'
// entries above, but you don't do anything with them"): a note is drawn only when it needs Angus or answers
// something he did; everything else hyprpi writes on its own (🧹 upkeep, ⟳ compaction nudges, ⏳ restart
// waits, 🌱 🍂 📨 ⤴ ⛽ 👶 orchestration, @project writer / stale card care, …) is quiet. An allow-list, so a
// new kind of automatic note is quiet unless it's marked as an alert.
const NEEDS_ANGUS = /^(?:⚠|🔑|✗|⏹|🔌|🐳|⏰)/u; // ⏰: a waiting agent was woken (J288) // 🔌: hyprpi restarted, Thoughts is back (J283) · 🐳: a held sandbox message was decided or sent under a rule (J284)
export function quietNote(e) {
  if (e?.role !== "note" || e.session) return false;
  const t = String(e.text || "").trimStart();
  return !NEEDS_ANGUS.test(t) && !/^room message \S+ went to the room's agents/.test(t);
}

// "answered @Blink: text" → { to: "Blink", raw: "text", said: "text" (whitespace collapsed), cutOld }.
// cutOld: answers stored before the N53 fix were cut at 140 characters at the source; mark those.
export function answerLine(e) {
  const m = /^answered @([^:]+):\s*([\s\S]*)$/.exec(e?.text || "") || [null, "?", ""];
  const said = String(m[2]).replace(/\s+/g, " ");
  return { to: m[1], raw: m[2], said, cutOld: said.length === 140 && !said.endsWith("…") };
}

// The "↳ " in front of an action line ("" for a failed one, which shows in red).
export const actionPrefix = (e) => String(e?.text || "").startsWith("✗") ? "" : "↳ ";

// Thoughts' "↩ from Name" / "↪ to Name" lead line (a direct message it is summing up): drawn light
// grey, the summary right under it. → { lead: "↩ from Blink" | "", body }
export function splitLead(e) {
  const text = String(e?.text || "");
  const lead = e?.role === "thoughts" && /^(?:↩ from|↪ to) [^\n]+/.exec(text);
  return lead ? { lead: lead[0], body: text.slice(lead[0].length).replace(/^\s*\n/, "") } : { lead: "", body: text };
}

// J146 (Angus: "remove all upkeep's from the phone Thought panel. It adds clutter"): hyprpi's own
// automatic notes the PHONE leaves out. Only the phone app uses this; the desktop Thoughts window, the
// thread file, Thoughts' own view and search are unchanged. Matched on a note's LEADING marker, so
// "🌱 X spawned 🔑 Y" is hidden while a "🔑 … login expired" alert (it needs Angus) stays.
//   hidden: 🧹 upkeep · ⟳ compaction nudges · ⏳ daemon-restart waits · 🌱 🍂 📨 ⤴ orchestration
//           (spawned / closed / reported / escalated) · "@project … no live writer" / "… stale" card upkeep
//   kept:   🔑 login alerts, ✗ errors, ⏹ interrupted, the new-session line, and every message, reply,
//           action, answer and evidence entry (Thoughts' summaries are its replies, so they show)
// The phone's own rule (J146) is now the same as the desktop's (J147): quiet notes stay off it.
export const phoneHidden = (e) => quietNote(e);
