// node test/shares-levels.mjs  (J366: access levels decide which projects a sandbox gets; the card lists them)
// A test config only: temporary XDG_CONFIG_HOME / XDG_STATE_HOME, test projects under ~/.cache (shares must be home
// subfolders). Runs `shares.mjs plan` and `card`; never mounts anything.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const SH = new URL("../docker/world/shares.mjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.homedir(), ".cache", "j366-")), work = path.join(base, "Work");
const cfg = path.join(base, "cfg"), st = path.join(base, "state");
for (const d of ["alpha", "beta", "gamma", "prot-x", "world-t"]) fs.mkdirSync(path.join(work, d), { recursive: true });
fs.mkdirSync(path.join(cfg, "hyprpi", "worlds"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ projectFolders: [work], protected: [path.join(work, "prot-x")] }));
// a stub `sbx` that fails: the card's network section then says it couldn't be read, and no test sbx daemon starts
const bin = path.join(base, "bin"); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, "sbx"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const env = { ...process.env, XDG_CONFIG_HOME: cfg, XDG_STATE_HOME: st, PATH: `${bin}:${process.env.PATH}` };
const world = (w, relay = { sandboxes: [] }) => {
  fs.writeFileSync(path.join(cfg, "hyprpi", "worlds", "world-t.json"), JSON.stringify({ sandbox: "world-t", workspace: path.join(work, "world-t"), gitignored: { hide: false }, ...w }));
  fs.writeFileSync(path.join(cfg, "hyprpi", "sbx-relay.json"), JSON.stringify(relay));
  const out = execFileSync(process.execPath, [SH, "plan", "world-t"], { env, encoding: "utf8" });
  const mounts = Object.fromEntries(out.split("\n").filter((l) => /^(rw|ro)  /.test(l)).map((l) => [l.slice(4).split("  ")[0], l.slice(0, 2)]));
  return { out, level: /^access level: (\w+)/m.exec(out)?.[1], mounts, p: (n) => mounts[path.join(work, n)] };
};
const ok = (m) => console.log("ok " + m);
// open: "all" → the whole project folder rw (as today), protected ro on top
let r = world({ access: "open", projects: "all" });
assert.equal(r.level, "open"); assert.equal(r.mounts[work], "rw"); assert.equal(r.p("prot-x"), "ro");
assert.match(r.out, /projects \(4\): alpha rw, beta rw, gamma rw, prot-x ro/);
ok("open + all: all of Work rw, protected ro, every project listed by name and mode");
// safe: only the list, ro unless :rw; "all" not honoured
r = world({ access: "safe", projects: ["alpha", "beta:rw"] });
assert.equal(r.level, "safe"); assert.equal(r.mounts[work], undefined, "Work itself isn't shared");
assert.equal(r.p("alpha"), "ro"); assert.equal(r.p("beta"), "rw"); assert.equal(r.p("gamma"), undefined, "an unlisted project isn't shared");
assert.match(r.out, /projects \(2\): alpha ro, beta rw/);
r = world({ access: "safe", projects: "all" });
assert.equal(r.mounts[work], undefined); assert.match(r.out, /"projects": "all" isn't honoured at the safe level/); assert.match(r.out, /projects \(0\)/);
ok("safe: only listed projects, ro unless rw; 'all' refused");
// strict: only the list, all ro even if marked rw
r = world({ access: "strict", projects: ["alpha", { name: "beta", mode: "rw" }] });
assert.equal(r.p("alpha"), "ro"); assert.equal(r.p("beta"), "ro"); assert.equal(r.p("gamma"), undefined);
ok("strict: only listed projects, all ro");
// protected stays ro at safe even if listed rw
r = world({ access: "safe", projects: ["prot-x:rw"] });
assert.equal(r.p("prot-x"), "ro"); ok("a protected project stays ro when listed rw");
// level defaults: developer visibility → open; Doorman modes → their level; bad access → strict
r = world({ projects: "all" }, { sandboxes: [{ name: "doorman-t", doorman_for: "world-t", visibility: "developer" }] }); assert.equal(r.level, "open");
r = world({ projects: "all", doorman: { mode: "doorman-strict" } }); assert.equal(r.level, "strict"); assert.equal(r.mounts[work], undefined);
r = world({ projects: "all", doorman: { mode: "doorman-open" } }); assert.equal(r.level, "open");
r = world({ projects: "all" }); assert.equal(r.level, "safe", "no Doorman setting: the default mode doorman-safe");
r = world({ access: "wide-open", projects: "all" }); assert.equal(r.level, "strict"); assert.match(r.out, /isn't open, safe or strict, so strict/);
r = world({ access: "safe", projects: ["../x", "a/b", ".."] }); assert.match(r.out, /bad project entry/); assert.match(r.out, /projects \(0\)/);
ok("level defaults (developer → open, Doorman modes, unknown → strict) and bad entries refused");
// the card lists every shared project by name and mode
world({ access: "safe", projects: ["alpha", "beta:rw"] });
execFileSync(process.execPath, [SH, "card", "world-t"], { env, encoding: "utf8" });
const card = fs.readFileSync(path.join(st, "hyprpi", "sandboxes", "world-t", "card", "host-card.md"), "utf8");
assert.match(card, /## Projects/); assert.match(card, /Access level: safe/); assert.match(card, /\| ro \| alpha \|/); assert.match(card, /\| rw \| beta \|/); assert.ok(!/gamma/.test(card));
ok("card: level and every shared project by name and mode; unlisted ones absent");
fs.rmSync(base, { recursive: true, force: true });
console.log("shares-levels: all pass");
