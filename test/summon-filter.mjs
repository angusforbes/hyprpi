#!/usr/bin/env node
// J447: typing in the SUPER+S summon pop-up narrows the list. The finder asks the plugin for a plain filter
// (plainFilter, no noFilter); FinderRank.rank(rows, q, plain) keeps the rows whose label or detail contains q,
// in the given order, with no world-letter / workspace-number ranking; the finder (not plain) is unchanged.
//   node test/summon-filter.mjs     (exit 0 = pass)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = fs.readFileSync(path.join(ROOT, "shell-plugin/agf.hyprpi-finder/FinderRank.js"), "utf8").replace(/^\.pragma library\s*/, "");
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
let fails = 0;
const ok = (c, what) => { console.log(`${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails++; };
const rows = [
  { label: "🧹 Sweep", detail: "D1 · workshop", worlds: "D", ws: 31, home: "D", slot: 1, name: "Sweep" },
  { label: "🚪 Knock", detail: "D2 · omarchy", worlds: "D", ws: 32, home: "D", slot: 2, name: "Knock" },
  { label: "🐳 Alpha (G1)", detail: "sandboxed", worlds: "G", ws: 61, home: "G", slot: 1, name: "Alpha" },
  { label: ">Stream", detail: "panel", worlds: "D", ws: 0, home: "", slot: 0, name: ">Stream" },
  { label: "@hyprpi", detail: "project · Blink", worlds: "C", ws: 0, home: "", slot: 0, name: "@hyprpi" },
];
const pick = (q, plain) => Array.from(ctx.rank(rows, q, plain)).map((i) => rows[i].name);
ok(JSON.stringify(pick("kno", true)) === '["Knock"]', `plain "kno" → Knock only (${pick("kno", true)})`);
ok(JSON.stringify(pick("KNO", true)) === '["Knock"]', "case-insensitive");
ok(JSON.stringify(pick("d", true)) === '["Sweep","Knock","Alpha"]', `plain "d": only rows containing d, in the given order (${pick("d", true)})`);
ok(JSON.stringify(pick("1", true)) === '["Sweep","Alpha"]', `plain "1": only rows containing 1, no workspace ranking (${pick("1", true)})`);
ok(JSON.stringify(pick("", true)) === JSON.stringify(rows.map((r) => r.name)), "plain, nothing typed: every row in the given order (summon looks as before)");
ok(pick("zzz", true).length === 0, "plain, no match: empty");
// The finder (not plain) ranks exactly as the code before J447 did (git HEAD~ copy when available, else the J195 groups).
ok(JSON.stringify(pick("d", false)) === '["Sweep","Knock",">Stream","Alpha"]', `the finder (not plain): world D first, then D's panel, then other matches (J17/J195) (${pick("d", false)})`);
ok(JSON.stringify(pick("1", false)) === '["Sweep","Alpha"]', `the finder (not plain): slot 1 first (${pick("1", false)})`);
ok(JSON.stringify(pick("kno", false)) === '["Knock"]', "the finder's ordinary query is unchanged");
// The finder's summon payload asks for plainFilter and no longer for noFilter.
const finder = fs.readFileSync(path.join(ROOT, "mockups/finder"), "utf8");
ok(/SUMMON \? \{ multi: true, plainFilter: true \}/.test(finder) && !/noFilter: true/.test(finder), "finder --summon sends { multi, plainFilter } (no noFilter)");
const qml = fs.readFileSync(path.join(ROOT, "shell-plugin/agf.hyprpi-finder/Menu.qml"), "utf8");
ok(/dmenuPlainFilter = !!payload\.plainFilter/.test(qml) && /FinderRank\.rank\(parsed, query, root\.dmenuPlainFilter\)/.test(qml), "Menu.qml reads plainFilter and passes it to the ranking");
ok(/all = root\.parseDmenuOptions\(root\.dmenuOptions\)/.test(qml), "Menu.qml returns every Tab-marked row on ⏎, also ones the filter hides");
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
