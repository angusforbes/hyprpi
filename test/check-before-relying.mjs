// J658: the Thoughts preamble carries the check-before-relying skill (live skill verbatim, and the fallback when there is
// no skill). Run: node test/check-before-relying.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let fail = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) fail++; };
const render = async (home) => {
  const old = process.env.HOME; if (home) process.env.HOME = home;
  try { const m = await import(`../lib/thoughts.mjs?${Math.random()}`); return m.thoughtsSystemPrompt("A"); } finally { process.env.HOME = old; }
};
const skillFile = path.join(os.homedir(), ".pi/agent/skills/check-before-relying/SKILL.md");
if (fs.existsSync(skillFile)) {
  const rules = fs.readFileSync(skillFile, "utf8").split(/^## Rules\s*$/m)[1].replace(/^## (.*)$/gm, "$1:").trim();
  const p = await render(null);
  check("live skill: the preamble carries the skill's Rules section verbatim", p.includes(rules));
}
for (const [label, home] of [["live skill", null], ["no skill (fallback)", fs.mkdtempSync(path.join(os.tmpdir(), "cbr-"))]]) {
  const p = await render(home);
  check(`${label}: rule 1 (a motivating claim is checked against its source before it's a reason or goes into a brief)`, /motivates a spend, a test or a decision/.test(p) && /brief/.test(p) && /file:line/.test(p));
  check(`${label}: rule 2 (corrections claim by claim, never "partly off")`, /claim by claim/.test(p) && /partly off/.test(p));
  check(`${label}: rule 3 (say "unchecked")`, /"unchecked"/.test(p) || /\\"unchecked\\"/.test(p));
  check(`${label}: rule 4 (count or read the data, don't infer from a summary)`, /summary/.test(p) && /(Count|count)/.test(p));
}
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
