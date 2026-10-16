// J666: the "drive his browser after the human step" rule is in the rendered Thoughts preamble and in ~/.pi/agent/AGENTS.md,
// with Angus's words, the hyprcu notes it points to, ask-before-focus, the phone exception and no secrets typed.
// Renders the preamble only (no daemon, no windows). Run: node test/browser-takeover.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let fail = 0; const check = (n, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) fail++; };
const { thoughtsSystemPrompt } = await import("../lib/thoughts.mjs");
const line = thoughtsSystemPrompt("A").split("\n").find((l) => l.includes("(J666")) || "";
const agents = fs.readFileSync(path.join(os.homedir(), ".pi/agent/AGENTS.md"), "utf8");
const sec = agents.split(/^## /m).find((s) => s.includes("(J666")) || "";
for (const [label, t] of [["preamble", line], ["AGENTS.md", sec]]) {
  check(`${label}: present`, t.length > 0);
  check(`${label}: Angus's 40a words`, t.includes("asking before it takes focus") && t.includes("click-by-click steps only if you ask"));
  check(`${label}: points at hyprcu and the browser notes`, /hyprcu/.test(t) && t.includes("notes/apps/_general.md") && t.includes("chromium.md"));
  check(`${label}: asks before taking focus or windows`, /Ask (him )?first|ask (Angus|him) first/i.test(t) && /focus/.test(t));
  check(`${label}: never on the phone`, /phone/.test(t));
  check(`${label}: never types passwords, MFA codes or payment details`, /never type a password, MFA code or payment details/i.test(t));
  check(`${label}: sending on his behalf still needs his OK`, /exact text/.test(t));
  check(`${label}: restores his windows`, /restore/i.test(t));
}
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
