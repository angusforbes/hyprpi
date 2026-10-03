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
//   "note"     anything else (hyprpi's own notes), dim
export const isAnswer = (e) => e?.role === "action" && /^answered @/.test(e.text || "");

export function threadKind(e) {
  const r = e?.role;
  if (r === "agent" || r === "reply") return "hidden";
  if (isAnswer(e)) return "answer";
  if (r === "you" || r === "thoughts") return "full";
  if (r === "action") return String(e.text || "").startsWith("✗") ? "error" : "action";
  if (r === "evidence") return "evidence";
  return "note";
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
