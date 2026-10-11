#!/usr/bin/env node
// J468 proof (Angus: "when i scroll up i see some of teh commands i typed into Thoughts-B. arent' the prompt
// histories meant to eb per window?"). node test/input-history-per-world.mjs (exit 0 = pass). Temp state dir only.
// A) every panel using the shared input box (thoughts, stream, projects, agents) passes its world to createHistory.
// B) per panel: two worlds' boxes (B and C), each sends prompts; ↑ in each shows only its own, newest first.
// C) one window switching worlds (Ctrl+Tab): ↑ follows the world now shown, and browsing restarts there.
// D) the old shared <panel>.json is left byte-for-byte as it was and no longer read.
// E) Thoughts seeding: a world's own thread messages go in front of that world's list once, never another's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "j468-"));
process.env.HYPRPI_STATE = STATE;
const { createInputBox, createHistory, seedHistory } = await import("../lib/tui/input-box.mjs");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const UP = "\x1b[A", DOWN = "\x1b[B";
const send = (box, t) => { box.set(t); box.remember(t); box.clear(); };
const ups = (box, n) => { const seen = []; for (let i = 0; i < n; i++) { box.key(UP); seen.push(box.text); } return seen; };

// A
for (const [f, panel] of [["search", "thoughts"], ["room", "stream"], ["board", "projects"], ["agents", "agents"]]) {
  const src = fs.readFileSync(path.join(ROOT, "mockups", `${f}-tui.mjs`), "utf8");
  ok(`A ${f}-tui passes its world`, src.includes(`createHistory("${panel}", { world: () => room })`));
}

// D setup: a legacy shared file per panel, as Angus's machine has it
const dir = path.join(STATE, "input-history"); fs.mkdirSync(dir, { recursive: true });
const legacy = {};
for (const p of ["thoughts", "stream", "projects", "agents"]) { legacy[p] = JSON.stringify([`old ${p} 1`, `old ${p} 2`]); fs.writeFileSync(path.join(dir, `${p}.json`), legacy[p]); }

// B
for (const p of ["thoughts", "stream", "projects", "agents"]) {
  const boxB = createInputBox({ history: createHistory(p, { world: () => "B" }) });
  const boxC = createInputBox({ history: createHistory(p, { world: () => "C" }) });
  send(boxB, `${p} B one`); send(boxC, `${p} C one`); send(boxB, `${p} B last`); send(boxC, `${p} C two`);
  const seenC = ups(boxC, 3), seenB = ups(boxB, 3);
  console.log(`   ${p}: ↑↑↑ in world C shows ${JSON.stringify(seenC)} · in world B ${JSON.stringify(seenB)}`);
  ok(`B ${p} world C shows only C's prompts`, seenC[0] === `${p} C two` && seenC[1] === `${p} C one` && !seenC.some((t) => t.includes(" B ") || t.startsWith("old")), boxC.note);
  ok(`B ${p} world B shows only B's prompts`, seenB[0] === `${p} B last` && seenB[1] === `${p} B one` && !seenB.some((t) => t.includes(" C ") || t.startsWith("old")));
  ok(`B ${p} files`, fs.existsSync(path.join(dir, `${p}-B.json`)) && fs.existsSync(path.join(dir, `${p}-C.json`)));
}

// C
let room = "C";
const sw = createInputBox({ history: createHistory("stream", { world: () => room }) });
sw.key(UP); const inC = sw.text;
// (the box keeps the shown text across the switch; its first ↑ moves the cursor to the start, as ever)
room = "B"; sw.key(UP); sw.key(UP); const inB = sw.text; sw.key(UP); const inB2 = sw.text;
console.log(`   one window: ↑ in C "${inC}", Ctrl+Tab to B, ↑↑ "${inB}", ↑ "${inB2}"`);
ok("C switching worlds follows the world", inC === "stream C two" && inB === "stream B last" && inB2 === "stream B one");

// D
for (const p of ["thoughts", "stream", "projects", "agents"]) ok(`D legacy ${p}.json untouched`, fs.readFileSync(path.join(dir, `${p}.json`), "utf8") === legacy[p]);

// D2: a panel whose world isn't known yet (room "" before the daemon answers) neither reads nor writes the legacy file
let early = "";
const eb = createInputBox({ history: createHistory("stream", { world: () => early }) });
send(eb, "sent before the world was known"); eb.key(UP);
ok("D2 no world yet: nothing shown, nothing written", eb.text === "" && fs.readFileSync(path.join(dir, "stream.json"), "utf8") === legacy.stream && !fs.readdirSync(dir).some((f) => /^stream-\.json$|^stream\.json\.tmp/.test(f)));

// E
const th = createHistory("thoughts", { world: () => "D" });
send(createInputBox({ history: th }), "typed in D before its thread loaded");
const seeded = seedHistory(th, "D", ["D thread 1", "D thread 2"]), again = seedHistory(th, "D", ["D thread 3"]);
const listD = th.list();
console.log(`   thoughts-D after seeding: ${JSON.stringify(listD)}`);
ok("E seeds a world once, its own thread in front", seeded && !again && JSON.stringify(listD) === JSON.stringify(["D thread 1", "D thread 2", "typed in D before its thread loaded"]));
ok("E another world's list is untouched by D's seeding", !createHistory("thoughts", { world: () => "C" }).list().some((t) => t.startsWith("D ")));

fs.rmSync(STATE, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
