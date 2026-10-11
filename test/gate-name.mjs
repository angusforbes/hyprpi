#!/usr/bin/env node
// J456: `hyprpi new --name/--icon` into a sandboxed world passes them to the inner `hyprpi new` as positional
// arguments of the sbx exec script (never spliced into it), and only the given ones (sbx refuses an empty argument).
//   node test/gate-name.mjs     (exit 0 = pass; no sandbox needed: gate() is pure, with a temp worlds config)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gate } from "../lib/sandbox-gate.mjs";

let fails = 0;
const ok = (c, what) => { console.log(`${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j456-"));
fs.writeFileSync(path.join(dir, "world-g.json"), JSON.stringify({ sandbox: "world-g", workspaces: [61, 69] }));
const g = (o) => gate({ workspace: 66, noFocus: true, dir, env: {}, ...o });
const MARK = path.join(os.tmpdir(), `j456-never-${process.pid}`);
const evil = `Odd"$(touch ${MARK})\`touch ${MARK}\`;x'y\nZ` + "L".repeat(70);

let r = g({ name: "Foo", icon: "🦊" });
ok(r.action === "sandbox" && /--name "\$1" --icon "\$2"$/.test(r.argv[4]) && JSON.stringify(r.argv.slice(5)) === '["hyprpi-gate","Foo","🦊"]', "name + icon: $1 / $2, passed as arguments");
r = g({ name: "Foo" });
ok(/--name "\$1"$/.test(r.argv[4]) && JSON.stringify(r.argv.slice(5)) === '["hyprpi-gate","Foo"]', "name only: no empty icon argument");
r = g({ icon: "🦊" });
ok(/--icon "\$1"$/.test(r.argv[4]) && !/--name/.test(r.argv[4]) && JSON.stringify(r.argv.slice(5)) === '["hyprpi-gate","🦊"]', "icon only");
r = g({});
ok(r.argv.length === 5 && !/--name|--icon/.test(r.argv[4]), "neither: the same argv as before J456");
r = g({ name: evil, icon: "x".repeat(30) });
ok(!r.argv[4].includes("touch") && !r.argv[4].includes("Odd"), "the name never appears in the script");
ok(r.argv[6] === evil.slice(0, 60) && r.argv[7] === "x".repeat(16), "passed as the host does: name ≤ 60, icon ≤ 16 characters, otherwise byte for byte");
// The script really takes them verbatim (a local sh stands in for the sandbox's).
const out = spawnSync("sh", ["-c", 'printf "%s\\0" "$1" "$2"', ...r.argv.slice(5)], { encoding: "utf8" }).stdout.split("\0");
ok(out[0] === evil.slice(0, 60) && out[1] === "x".repeat(16) && !fs.existsSync(MARK), "sh -c … \"$1\" receives the exact text, nothing runs");
ok(g({ name: "Foo", wantId: "abc" }).action === "refuse", "a host agent's resume there is still refused (unchanged)");
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
