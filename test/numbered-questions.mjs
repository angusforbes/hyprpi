// J551/J552: Thoughts and agent prompt guidelines agree on full question/option labels. Renders the real Thoughts
// preamble with the live skill, then its fallback, and checks the agent's actual AGREEMENT literal and board_read wiring
// without loading the live extension or connecting to its daemon. Run: node test/numbered-questions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let fail = 0;
const check = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) fail++; };
const agentSource = fs.readFileSync(new URL("../pi-extension/index.ts", import.meta.url), "utf8");
const agreement = agentSource.match(/const AGREEMENT = \[([\s\S]*?)\n  \];/)?.[1] || "";
const agentJ252 = JSON.parse(agreement.match(/^\s*("Number what Angus answers \(J252.*"),\s*$/m)?.[1] || '""');
const boardRead = agentSource.match(/pi\.registerTool\(\{\n\s*name: "board_read",([\s\S]*?)\n  \}\);/)?.[1] || "";
check("agent: J252 guideline is present in AGREEMENT", agentJ252.startsWith("Number what Angus answers (J252"));
check("agent: board_read attaches AGREEMENT to promptGuidelines", /promptGuidelines:\s*AGREEMENT\b/.test(boardRead));
check("agent: full option labels and inline recommendation", agentJ252.includes("(8a, 8b;") && agentJ252.includes('"8b. Ship it now (recommended)"'));
check("agent: no old bare-letter or numbered-option example", !/lettered a, b, c|"2\. Ship it now/.test(agentJ252));
const render = async (home) => {
  const old = process.env.HOME; if (home) process.env.HOME = home;
  try { const m = await import(`../lib/thoughts.mjs?${Math.random()}`); return m.thoughtsSystemPrompt("A"); } finally { process.env.HOME = old; }
};
for (const [label, home] of [["live skill", null], ["no skill (fallback)", fs.mkdtempSync(path.join(os.tmpdir(), "nq-"))]]) {
  const p = await render(home);
  check(`${label}: agent J252 matches the rendered Thoughts guideline exactly`, agentJ252 === p.split("\n").find((line) => line.startsWith("Number what Angus answers (J252")));
  check(`${label}: options carry the question's number (8a)`, /8a\. …|"8a\. …"|\\"8a\. …\\"|8a/.test(p) && /never a bare/i.test(p));
  check(`${label}: a single question too`, /single question/i.test(p));
  check(`${label}: reminders write the options out again`, /remind/i.test(p) && /(options out again|write the options out|write its options out|options in full)/i.test(p));
  check(`${label}: an ambiguous reply → ask first`, /more than one open question/i.test(p) && /ask/i.test(p));
  check(`${label}: the 'which?' line names both`, /naming both/i.test(p));
  check(`${label}: no cap on open questions`, /(no limit on how many questions|any number of questions may be open)/i.test(p));
  check(`${label}: J568 lists that aren't questions get C1/F1/S1 labels, never bare numbers`, /aren't questions/i.test(p) && /C1/.test(p) && /bare numbers/i.test(p));
  check(`${label}: J568 a clarifying either/or is a numbered question with full labels`, /clarifying either\/or/i.test(p) && /16a/.test(p) && /did you mean X or Y/i.test(p));
  check(`${label}: no old bare-letter / "2. Ship it" rule left`, !/lettered a, b, c/.test(p) && !/"2\. Ship it now/.test(p) && !/options 1, 2, 3"? style\)?\s*$/m.test(p.replace(/there is no separate "options 1, 2, 3" style/, "")));
}
{ const skill = fs.readFileSync(path.join(os.homedir(), ".pi/agent/skills/numbered-questions/SKILL.md"), "utf8").split(/^## Rules\s*$/m)[1].replace(/^## (.*)$/gm, "$1:").trim();
  const p = await render(null); check("live skill: the preamble carries the skill's Rules section verbatim (J568)", p.includes(skill)); }
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
