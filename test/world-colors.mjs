#!/usr/bin/env node
// J535 proof (Angus: "let's use lime for I and pink for J"): one world palette everywhere.
//   node test/world-colors.mjs   (exit 0 = pass)
// - lib/tui/world-colors.toml holds world_i = #a6b83c (lime) and world_j = #e06c9f (pink)
// - lib/tui/term.mjs PALETTE == the hyprwrlds bar's and the vimarchy overview's paletteKeys (repo copies, and the live
//   copies in ~/.config/omarchy/plugins when present); ui/shell.qml's worldKeys name the same first keys
// - with a fixture theme: A–H are the theme's 8 colours as before, I is lime, J is pink; I without hyprpi's file falls back
//   to the foreground, as it did before J535
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };

const toml = fs.readFileSync(path.join(ROOT, "lib/tui/world-colors.toml"), "utf8");
ok("world-colors.toml: world_i is lime #a6b83c", /^world_i\s*=\s*"#a6b83c"/m.test(toml));
ok("world-colors.toml: world_j is pink #e06c9f", /^world_j\s*=\s*"#e06c9f"/m.test(toml));

const { PALETTE } = await import(path.join(ROOT, "lib/tui/term.mjs"));
const qmlKeys = (file) => { const s = fs.readFileSync(file, "utf8"); const m = /paletteKeys:\s*\[([\s\S]*?)\n\s*\]/.exec(s); return m ? JSON.parse(`[${m[1]}]`) : null; };
const want = JSON.stringify(PALETTE);
ok("term.mjs PALETTE has 10 worlds, I = world_i, J = world_j", PALETTE.length === 10 && PALETTE[8][0] === "world_i" && PALETTE[9][0] === "world_j");
const qmls = [["the bar (repo)", "hyprwrlds/omarchy-plugin/agf.hyprwrlds/BarWidget.qml"], ["the overview (repo)", "hyprwrlds-vimarchy/Overview.qml"]];
const live = [["the bar (live)", path.join(os.homedir(), ".config/omarchy/plugins/agf.hyprwrlds/BarWidget.qml")], ["the overview (live)", path.join(os.homedir(), ".config/omarchy/plugins/agf.hyprwrlds-vimarchy/Overview.qml")]];
for (const [n, f] of qmls) ok(`${n} paletteKeys == term.mjs PALETTE`, JSON.stringify(qmlKeys(path.join(ROOT, f))) === want, JSON.stringify(qmlKeys(path.join(ROOT, f))));
for (const [n, f] of live) if (fs.existsSync(f)) ok(`${n} paletteKeys == term.mjs PALETTE`, JSON.stringify(qmlKeys(f)) === want);
for (const f of [...qmls.map((x) => path.join(ROOT, x[1])), path.join(ROOT, "ui/shell.qml")]) ok(`${path.basename(f)} reads world-colors.toml`, fs.readFileSync(f, "utf8").includes("/Harness/hyprpi/lib/tui/world-colors.toml"));
// the world-coloured window border (hyprwrlds/hypr/hyprwrlds.lua; live copy ~/.config/hypr/hyprwrlds.lua)
const luaKeys = (file) => { const m = /local PALETTE_KEYS = \{([\s\S]*?)\n\}/.exec(fs.readFileSync(file, "utf8")); return m ? JSON.parse(`[${m[1].replace(/\{/g, "[").replace(/\}/g, "]").replace(/,\s*$/, "")}]`) : null; };
ok("hyprwrlds.lua PALETTE_KEYS (window border) == term.mjs PALETTE", JSON.stringify(luaKeys(path.join(ROOT, "hyprwrlds/hypr/hyprwrlds.lua"))) === want, JSON.stringify(luaKeys(path.join(ROOT, "hyprwrlds/hypr/hyprwrlds.lua"))));
ok("hyprwrlds.lua reads world-colors.toml", fs.readFileSync(path.join(ROOT, "hyprwrlds/hypr/hyprwrlds.lua"), "utf8").includes("/Harness/hyprpi/lib/tui/world-colors.toml"));
{ const f = path.join(os.homedir(), ".config/hypr/hyprwrlds.lua"); if (fs.existsSync(f)) ok("live ~/.config/hypr/hyprwrlds.lua PALETTE_KEYS == term.mjs PALETTE", JSON.stringify(luaKeys(f)) === want); }
const sk = /worldKeys:\s*(\[[^\]]*\])/.exec(fs.readFileSync(path.join(ROOT, "ui/shell.qml"), "utf8"));
ok("ui/shell.qml worldKeys = the palette's first keys", sk && JSON.stringify(JSON.parse(sk[1])) === JSON.stringify(PALETTE.map((k) => k[0])), sk?.[1]);
ok("search-tui uses term.mjs's palette (no copy of its own)", !/const PALETTE\s*=/.test(fs.readFileSync(path.join(ROOT, "mockups/search-tui.mjs"), "utf8")));

// colours with a fixture theme (a fresh process per case: term.mjs reads its files at import)
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j535-"));
const theme = { blue: "111111", red: "222222", cyan: "333333", yellow: "444444", magenta: "555555", green: "666666", orange: "777777", brown: "888888", foreground: "575279" };
fs.writeFileSync(path.join(T, "colors.toml"), Object.entries(theme).map(([k, v]) => `${k} = "#${v}"`).join("\n") + "\n");
const hexes = (extra = {}) => JSON.parse(spawnSync(process.execPath, ["-e", `import(${JSON.stringify(path.join(ROOT, "lib/tui/term.mjs"))}).then((m) => console.log(JSON.stringify([..."ABCDEFGHIJ"].map((w) => m.worldHex(w)))))`], { env: { ...process.env, HYPRPI_THEME_COLORS: path.join(T, "colors.toml"), ...extra }, encoding: "utf8" }).stdout);
const h = hexes();
ok("A–H are the theme's 8 colours, unchanged", JSON.stringify(h.slice(0, 8)) === JSON.stringify(Object.values(theme).slice(0, 8)), JSON.stringify(h));
ok("I is lime a6b83c", h[8] === "a6b83c", h[8]);
ok("J is pink e06c9f", h[9] === "e06c9f", h[9]);
const h0 = hexes({ HYPRPI_WORLD_COLORS: path.join(T, "none.toml") });
ok("without hyprpi's file, I falls back to the foreground (the old colour)", h0[8] === "575279" && JSON.stringify(h0.slice(0, 8)) === JSON.stringify(h.slice(0, 8)), JSON.stringify(h0));
fs.writeFileSync(path.join(T, "colors2.toml"), fs.readFileSync(path.join(T, "colors.toml"), "utf8") + 'world_i = "#000000"\n');
ok("a theme that sets world_i itself wins (a deliberate override)", hexes({ HYPRPI_THEME_COLORS: path.join(T, "colors2.toml") })[8] === "000000");
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
