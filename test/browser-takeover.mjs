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
  check(`${label}: v2 Angus's words`, t.includes("just toast me before you take over"));
  check(`${label}: W3 toast before taking focus/windows, naming who and how long, then ~10 s wait`, /notify-send -a "<your name>" "<your name> is taking over your browser" "for about <N> min/.test(t.replace(/\\"/g, '"')) && /wait ~10 s/.test(t) && /focus/.test(t));
  check(`${label}: W3 toast again when handing back`, /hand control back, toast again/.test(t) && /is done with your browser/.test(t));
  check(`${label}: J667 Angus's words, marked very important`, t.includes("you have to tell them you're done.Very important.") && /VERY IMPORTANT/.test(t));
  check(`${label}: J667 every exit path`, ["success", "failure", "giving up", "an error", "interrupted or stopped", "pausing to wait"].every((w) => t.includes(w)));
  check(`${label}: J667 a done toast (done or stopped) AND a line to Thoughts`, t.includes("is done with your browser") && t.includes("your browser is yours again") && /AND a line in its reply to you|a line in your reply to Thoughts/.test(t));
  check(`${label}: J667 the done toast always runs (try/finally)`, /try\/finally/.test(t));
  check(`${label}: J667 an overrun toast`, t.includes("still needs your browser"));
  check(`${label}: J668 Angus's words`, t.includes("please narrate what you're doing"));
  check(`${label}: J668 narrates each step at least every ~30 s`, /each step briefly as (it|you) go/.test(t) && /every ~30 s/.test(t));
  check(`${label}: J668 one replaced step toast, not spammy, no sound`, /ONE step toast/.test(t) && /step_id=\$\(notify-send -p -r \\?"\$step_id\\?"/.test(t) && /few and short/i.test(t) && /no sound|never a sound/.test(t));
  check(`${label}: J668 the J667 done signal still ends it`, /done toast and (the )?line to/.test(t));
  check(`${label}: J668 one-line status outside computer use`, /one-line status/.test(t));
  check(`${label}: never on the phone`, /phone/.test(t));
  check(`${label}: never types passwords, MFA codes or payment details`, /never type a password, MFA code or payment details/i.test(t));
  check(`${label}: sending on his behalf still needs his OK`, /exact text/.test(t));
  check(`${label}: restores his windows`, /restore/i.test(t));
}
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
