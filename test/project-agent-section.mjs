#!/usr/bin/env node
// J644: the project agent handbook's essentials reach project owners only.
//   W1 lib/project-agent.mjs sectionFor: the writer of a real project gets the section (about 10 lines, names its projects and
//      points to the full handbook note); a member who isn't the writer or the writer of only an archived project gets nothing; catch-all
//      writers count (Angus 66b). pi-extension/index.ts adds it as a system-prompt section in before_agent_start.
//   node test/run.mjs test/project-agent-section.mjs   (exit 0 = pass)
import fs from "node:fs";
import path from "node:path";
import { sectionFor, PROJECT_AGENT_SECTION, HANDBOOK } from "../lib/project-agent.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const P = [
  { name: "flow-mode", status: "active", writer: "hp-tangle", members: ["hp-tangle", "hp-helper"] },
  { name: "vibezai", status: "active", writer: "hp-groove", members: ["hp-groove"] },
  { name: "workshop", status: "active", writer: "hp-pocket", members: ["hp-pocket"] },
  { name: "inbox-d", status: "active", writer: "hp-pocket", members: [] },
  { name: "oldproj", status: "archived", writer: "hp-old", members: ["hp-old"] },
];
const t = sectionFor("hp-tangle", P);
ok("W1 a project's writer gets the section", t.startsWith(PROJECT_AGENT_SECTION) && /You own @flow-mode\.\)$/.test(t), t.slice(-40));
ok("W1 … about 10–15 lines", PROJECT_AGENT_SECTION.split("\n").length >= 8 && PROJECT_AGENT_SECTION.split("\n").length <= 16, String(PROJECT_AGENT_SECTION.split("\n").length));
ok("W1 … it points to the full handbook note", HANDBOOK === "~/Obsidian/Notes/Project agent handbook.md" && PROJECT_AGENT_SECTION.includes(HANDBOOK));
ok("W1 … and carries the handbook's headings: words, accountability, numbered questions, delegate the work, P9, the card", ["project agents, task agents, Thoughts", "Accountable", "numbered", "delegate the work", "Awareness (P9)", "The card"].every((k) => PROJECT_AGENT_SECTION.includes(k)));
ok("W1 a member who isn't the writer gets nothing", sectionFor("hp-helper", P) === "");
ok("W1 the writer of a catch-all card (@workshop) gets it too (Angus 66b: they get an agent for now)", /You own @workshop, @inbox-d\.\)$/.test(sectionFor("hp-pocket", P)));
ok("W1 … but not Thoughts, which writes the inbox cards (writer thoughts:D)", sectionFor("hp-x", [{ name: "inbox-d", status: "active", writer: "thoughts:D" }]) === "");
ok("J644b the section carries the handbook's Naming and Other-projects rules, one line each", PROJECT_AGENT_SECTION.split("\n").filter((l) => /^- Naming: you are named exactly after your project/.test(l)).length === 1 && PROJECT_AGENT_SECTION.split("\n").filter((l) => /^- Other projects and worlds: a request for something another project owns goes to that project's owner/.test(l)).length === 1);
ok("W1 the questions rule carries Angus's new one-list rule, and D4 (made with the project)", /give every open question in one list with fixed labels/.test(PROJECT_AGENT_SECTION) && /made with the project and remember it as it grows/.test(PROJECT_AGENT_SECTION));
ok("W1 the writer of only an archived project gets nothing", sectionFor("hp-old", P) === "");
ok("W1 an agent owning two projects gets both named", /@flow-mode, @vibezai/.test(sectionFor("hp-x", [{ ...P[0], writer: "hp-x" }, { ...P[1], writer: "hp-x" }])));
const src = fs.readFileSync(path.join(ROOT, "pi-extension/index.ts"), "utf8");
ok("W1 the extension adds it as a system-prompt section in before_agent_start, and removes it for non-owners", /pi\.on\("before_agent_start"[\s\S]{0,400}sec\.hyprpi_project_agent = section[\s\S]{0,80}delete sec\.hyprpi_project_agent/.test(src) && /sectionFor\(AGENT_ID, \(await call\("board\.get", \{\}\)\)\.projects \|\| \[\]\)/.test(src));
ok("J747 own and coordinate: every build to a task agent, short owner turns, one-line edits only when quicker, Angus's words", /every build or deliverable goes to a task agent, one per job \(spawn_agent\)/.test(PROJECT_AGENT_SECTION) && /keep your own turns short so he can always type to you/.test(PROJECT_AGENT_SECTION) && /small one-line edit yourself only when that's quicker than delegating/.test(PROJECT_AGENT_SECTION) && PROJECT_AGENT_SECTION.includes("he should fafm off his jobs to task agents so i'm not kept waiting") && !/Delegate by size/.test(PROJECT_AGENT_SECTION));
console.log(fails ? `project-agent-section: ${fails} FAILED` : "project-agent-section: all pass");
process.exit(fails ? 1 : 0);
