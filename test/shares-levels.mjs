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
r = world({ access: null, projects: "all" }, { sandboxes: [{ name: "doorman-t", doorman_for: "world-t", visibility: "developer" }] }); assert.equal(r.level, "strict", "access: null is unknown → strict");
r = world({ access: "safe", projects: ["alpha:rw:ro", "beta:RW", { name: "gamma", mode: "write" }] }); assert.match(r.out, /projects \(0\)/, "extra colons / unknown modes refused");
fs.mkdirSync(path.join(work, ".dotproj"));
r = world({ access: "safe", projects: [".dotproj"] }); assert.match(r.out, /projects \(1\): \.dotproj ro/, "a dot-folder project is listed");
ok("level defaults (developer → open, Doorman modes, unknown → strict) and bad entries refused");
// (LevelReview) no way around the list: a general share of the project folder, or a symlinked project
fs.symlinkSync(path.join(base, "cfg"), path.join(work, "linky"));
r = world({ access: "safe", projects: ["linky", "alpha"], shares: [{ path: work, mode: "rw" }, { path: path.join(work, "gamma"), mode: "ro" }] });
assert.equal(r.mounts[work], undefined); assert.equal(r.p("gamma"), undefined); assert.equal(r.p("linky"), undefined);
assert.match(r.out, /isn't allowed at the safe level/); assert.match(r.out, /linky \(no such project\)/); assert.match(r.out, /projects \(1\): alpha ro/);
const other = path.join(base, "notes"); fs.mkdirSync(other);
r = world({ access: "strict", projects: [], shares: [{ path: other, mode: "rw" }] }); assert.equal(r.mounts[other], "ro", "strict: general shares ro");
r = world({ access: "open", projects: [], shares: [{ path: work, mode: "rw" }] }); assert.equal(r.mounts[work], "rw", "open: as before");
ok("safe/strict: no general share around a project folder, no symlinked project; strict shares ro");
// (LevelReview) role folders can't get around it either; strict roles are ro
const gcfg = (extra) => fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ projectFolders: [work], protected: [path.join(work, "prot-x")], ...extra }));
gcfg({ roleFolders: { downloads: work, screenshots: other } });
r = world({ access: "strict", projects: [], roles: { downloads: true, screenshots: true } });
assert.equal(r.mounts[work], undefined, "a role folder at the project folder is refused"); assert.match(r.out, /role downloads: in or around a project folder/);
assert.equal(r.mounts[other], "ro", "strict roles are ro");
r = world({ access: "open", projects: [], roles: { downloads: true } }); assert.equal(r.mounts[work], "rw", "open: roles as before");
gcfg({});
ok("safe/strict: no role folder around a project folder; strict roles ro");
// (LevelReview) a listed subfolder of a protected project folder stays ro; the card lists what's really mounted
const mono = path.join(base, "mono"); fs.mkdirSync(path.join(mono, ".git"), { recursive: true }); fs.mkdirSync(path.join(mono, "src")); fs.mkdirSync(path.join(mono, "docs"));
gcfg({ projectFolders: [mono], protected: [mono] });
r = world({ access: "safe", projects: ["src:rw"] }); assert.equal(r.mounts[path.join(mono, "src")], "ro"); assert.match(r.out, /projects \(1\): src ro/);
gcfg({ projectFolders: [mono], protected: [] });
r = world({ access: "open", projects: "all" }); assert.match(r.out, /projects \(2\): docs rw, src rw/, "a repo project folder: its children, each with its real mode");
// (LevelReview) a project folder reached through a symlink doesn't dodge protection
const link = path.join(base, "WorkLink"); fs.symlinkSync(work, link);
gcfg({ projectFolders: [link], protected: [path.join(work, "prot-x")] });
r = world({ access: "safe", projects: ["prot-x:rw"] }); assert.equal(r.mounts[path.join(work, "prot-x")], "ro", "canonical: still protected");
gcfg({});
ok("a listed child of a protected folder is ro; the card's list follows the real mounts; symlinked folders canonical");
// the card lists every shared project by name and mode
world({ access: "safe", projects: ["alpha", "beta:rw"] });
execFileSync(process.execPath, [SH, "card", "world-t"], { env, encoding: "utf8" });
const card = fs.readFileSync(path.join(st, "hyprpi", "sandboxes", "world-t", "card", "host-card.md"), "utf8");
assert.match(card, /## Projects/); assert.match(card, /Access level: safe/); assert.match(card, /\| ro \| alpha \|/); assert.match(card, /\| rw \| beta \|/); assert.ok(!/gamma/.test(card));
ok("card: level and every shared project by name and mode; unlisted ones absent");
// (LevelReview) a share that is an alias of a protected project is that project: ro
const alias = path.join(base, "protAlias"); fs.symlinkSync(path.join(work, "prot-x"), alias);
r = world({ access: "open", projects: [], shares: [{ path: alias, mode: "rw" }] }); assert.equal(r.mounts[alias], "ro");
const parentAlias = path.join(base, "WorkAlias"); fs.symlinkSync(work, parentAlias);
r = world({ access: "open", projects: [], shares: [{ path: parentAlias, mode: "rw" }] }); assert.equal(r.mounts[path.join(parentAlias, "prot-x")], "ro", "overlay at the alias's place");
assert.match(r.out, /projects \(\d+\): alpha rw, beta rw, gamma rw, prot-x ro/, "the card lists what an alias share really gives");
ok("an alias of a protected project is ro; an alias of its parent gets the ro overlay and the card lists its projects");
// addProject (OpenRoute's share_project): within the level, atomically, never wider
process.env.XDG_CONFIG_HOME = cfg; process.env.XDG_STATE_HOME = st;
const { addProject } = await import("../docker/world/shares.mjs");
const wj = () => JSON.parse(fs.readFileSync(path.join(cfg, "hyprpi", "worlds", "world-t.json"), "utf8"));
world({ access: "safe", projects: ["alpha"] });
let a = addProject("world-t", "beta", "rw"); assert.ok(a.ok, a.text); assert.deepEqual(wj().projects, ["alpha", "beta:rw"]);
a = addProject("world-t", "beta"); assert.ok(a.ok); assert.deepEqual(wj().projects, ["alpha", "beta:ro"], "re-adding replaces, ro by default at safe");
assert.equal(addProject("world-t", "nope").ok, false); assert.equal(addProject("world-t", "../x").ok, false); assert.equal(addProject("world-t", "linky").ok, false, "no symlinked project");
assert.equal(addProject("World T", "alpha").ok, false); assert.equal(addProject("world-t", 7).ok, false); assert.equal(addProject("world-t", ["alpha"]).ok, false); assert.equal(addProject("world-t", "alpha", 1).ok, false); assert.equal(addProject("world-t", "alpha", "write").ok, false);
world({ access: "strict", projects: [] });
a = addProject("world-t", "alpha", "rw"); assert.equal(a.ok, false); assert.match(a.text, /strict level/, "never wider than the level");
assert.ok(addProject("world-t", "alpha", "ro").ok); assert.deepEqual(wj().projects, ["alpha:ro"]);
world({ access: "open", projects: "all" });
a = addProject("world-t", "gamma"); assert.ok(a.ok); assert.match(a.text, /already shared/); assert.equal(wj().projects, "all");
r = world({ access: "safe", projects: ["alpha"], keep: 1 }); assert.ok(addProject("world-t", "gamma").ok); assert.equal(wj().keep, 1, "other keys kept");
assert.match(execFileSync(process.execPath, [SH, "plan", "world-t"], { env, encoding: "utf8" }), /projects \(2\): alpha ro, gamma ro/);
ok("addProject: validated, within the level, atomic, other keys kept; plan shows it");
fs.rmSync(base, { recursive: true, force: true });
console.log("shares-levels: all pass");
