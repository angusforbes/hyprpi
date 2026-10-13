// J551: the Thoughts preamble carries the numbered-questions rules (full labels like 8a, reminders that repeat the options,
// ask when a reply is ambiguous, no single-question exception) and nothing that contradicts them. Renders the real preamble
// (lib/thoughts.mjs) with the live skill, then with no skill (the built-in fallback). Run: node test/numbered-questions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let fail = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) fail++; };
const render = async (home) => {
  const old = process.env.HOME; if (home) process.env.HOME = home;
  try { const m = await import(`../lib/thoughts.mjs?${Math.random()}`); return m.thoughtsSystemPrompt("A"); } finally { process.env.HOME = old; }
};
for (const [label, home] of [["live skill", null], ["no skill (fallback)", fs.mkdtempSync(path.join(os.tmpdir(), "nq-"))]]) {
  const p = await render(home);
  check(`${label}: options carry the question's number (8a)`, /8a\. …|"8a\. …"|\\"8a\. …\\"|8a/.test(p) && /never a bare/i.test(p));
  check(`${label}: a single question too`, /single question/i.test(p));
  check(`${label}: reminders write the options out again`, /remind/i.test(p) && /(options out again|write the options out|write its options out|options in full)/i.test(p));
  check(`${label}: an ambiguous reply → ask first`, /more than one open question/i.test(p) && /ask/i.test(p));
  check(`${label}: no old bare-letter / "2. Ship it" rule left`, !/lettered a, b, c/.test(p) && !/"2\. Ship it now/.test(p) && !/options 1, 2, 3"? style\)?\s*$/m.test(p.replace(/there is no separate "options 1, 2, 3" style/, "")));
}
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
