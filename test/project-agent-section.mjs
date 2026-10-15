#!/usr/bin/env node
// J644: the project agent handbook's essentials reach project owners only.
//   W1 lib/project-agent.mjs sectionFor: the writer of a real project gets the section (about 10 lines, names its projects and
//      points to the full handbook note); a member who isn't the writer, the writer of only a catch-all (@workshop, inbox-x) or of
//      an archived project gets nothing. pi-extension/index.ts adds it as a system-prompt section in before_agent_start.
//   node test/run.mjs test/project-agent-section.mjs   (exit 0 = pass)
import fs from "node:fs";
import path from "node:path";
import { sectionFor, PROJECT_AGENT_SECTION, HANDBOOK } from "../lib/project-agent.mjs";
import { isCatchAll } from "../lib/decisions.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const P = [
  { name: "flow-mode", status: "active", writer: "hp-tangle", members: ["hp-tangle", "hp-helper"] },
  { name: "vibezai", status: "active", writer: "hp-groove", members: ["hp-groove"] },
  { name: "workshop", status: "active", writer: "hp-pocket", members: ["hp-pocket"] },
  { name: "inbox-d", status: "active", writer: "hp-pocket", members: [] },
  { name: "oldproj", status: "archived", writer: "hp-old", members: ["hp-old"] },
];
const t = sectionFor("hp-tangle", P, isCatchAll);
ok("W1 a project's writer gets the section", t.startsWith(PROJECT_AGENT_SECTION) && /You own @flow-mode\.\)$/.test(t), t.slice(-40));
ok("W1 … about 10–15 lines", PROJECT_AGENT_SECTION.split("\n").length >= 8 && PROJECT_AGENT_SECTION.split("\n").length <= 15, String(PROJECT_AGENT_SECTION.split("\n").length));
ok("W1 … it points to the full handbook note", HANDBOOK === "~/Obsidian/Notes/Project agent handbook.md" && PROJECT_AGENT_SECTION.includes(HANDBOOK));
ok("W1 … and carries the handbook's headings: words, accountability, numbered questions, delegate by size, P9, the card", ["project agents, task agents, Thoughts", "Accountable", "numbered", "Delegate by size", "Awareness (P9)", "The card"].every((k) => PROJECT_AGENT_SECTION.includes(k)));
ok("W1 a member who isn't the writer gets nothing", sectionFor("hp-helper", P, isCatchAll) === "");
ok("W1 the writer of only catch-all cards (@workshop, inbox-d) gets nothing", sectionFor("hp-pocket", P, isCatchAll) === "");
ok("W1 the writer of only an archived project gets nothing", sectionFor("hp-old", P, isCatchAll) === "");
ok("W1 an agent owning two projects gets both named", /@flow-mode, @vibezai/.test(sectionFor("hp-x", [{ ...P[0], writer: "hp-x" }, { ...P[1], writer: "hp-x" }], isCatchAll)));
const src = fs.readFileSync(path.join(ROOT, "pi-extension/index.ts"), "utf8");
ok("W1 the extension adds it as a system-prompt section in before_agent_start, and removes it for non-owners", /pi\.on\("before_agent_start"[\s\S]{0,400}sec\.hyprpi_project_agent = section[\s\S]{0,80}delete sec\.hyprpi_project_agent/.test(src) && /sectionFor\(AGENT_ID, \(await call\("board\.get", \{\}\)\)\.projects \|\| \[\], isCatchAll\)/.test(src));
console.log(fails ? `project-agent-section: ${fails} FAILED` : "project-agent-section: all pass");
process.exit(fails ? 1 : 0);
