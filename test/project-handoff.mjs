#!/usr/bin/env node
// J651 (Angus: "amend the handoff command so that it includes the idea of tasks writing a report directly in the project folder
// (if it's a project-task agent or project-agent)"; P12, T15, T17; rule 11). An isolated daemon (own socket/state/config/HOME, no
// Hyprland, HYPRPI_ORCH_LAUNCH=/bin/true so no real agent starts), a board D with @vibez owned by a fake agent "Owner".
//   W1 `hyprpi project-of --ensure` for the owner (role owner) and for a child it spawned (role task) names @vibez and
//      ~/Obsidian/Projects/vibez, and creates the folder; pi-agent-forum's /handoff, rendered with that project, tells the agent to
//      write its report there.
//   W2 `hyprpi project-handoff FILE` (a report in that folder) makes the card record the folder and link the report; the board
//      panel shows a Folder line; a report outside the folder is refused.
//   W3 a loose agent (no project): project-of prints nothing, and /handoff renders exactly as before J651.
//   W4 the child's welcome (from a project agent) tells it to send its parent a one-line digest after any decision (T15).
//   W7 the one-key rule's one-line format is in the project owners' section and in Thoughts' prompt.
//   node test/run.mjs test/project-handoff.mjs   (exit 0 = pass)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), FORUM = process.env.PI_AGENT_FORUM_DIR || [path.join(ROOT, "..", "pi-agent-forum"), path.join(os.homedir(), "Harness", "pi-agent-forum")].find((d) => fs.existsSync(path.join(d, "src", "core.ts")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "j651-")), H = path.join(T, "home"), sock = path.join(T, "d.sock"), state = path.join(T, "state"), cfg = path.join(T, "cfg");
for (const d of [H, path.join(state, "boards"), path.join(cfg, "hyprpi")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, topics: false }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const now = Date.now(), card = (id, name, writer, members) => ({ id, name, title: `${name} card`, icon: "📦", status: "active", members, writer, created: now, updated: now, by: "x", where: null, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [] });
fs.writeFileSync(path.join(state, "boards", "D.json"), JSON.stringify({ room: "D", projects: [card("p-vib", "vibez", "hp-owner", ["hp-owner"])] }));
const env = { ...process.env, HOME: H, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, XDG_CONFIG_HOME: cfg, HYPRPI_TEST: "1", HYPRPI_ORCH_LAUNCH: "/bin/true", HYPRLAND_INSTANCE_SIGNATURE: "j651-bogus", HYPRPI_NO_ENSURE: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_ALLOW_HYPR", "HYPRPI_WORKSPACE"]) delete env[k];
const fd = fs.openSync(path.join(T, "daemon.log"), "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
const cli = (id, ...args) => execFileSync(process.execPath, [path.join(ROOT, "bin/hyprpi"), ...args], { env: { ...env, HYPRPI_AGENT_ID: id }, encoding: "utf8", timeout: 15000 }).trim();
const cliErr = (id, ...args) => { try { cli(id, ...args); return ""; } catch (e) { return String(e.stderr || e.message); } };
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const ev = {}; const fake = async (id, name, ws) => { ev[id] = []; const c = await connect({ path: sock, onEvent: (e, x) => ev[id].push({ e, x }) }); await c.call("agent.hello", { agent_id: id, pid: process.pid, name, want_workspace: ws, cwd: T }); return c; };
  const owner = await fake("hp-owner", "Owner", 32), loose = await fake("hp-loose", "Loose", 33);
  // the owner spawns a task agent; it connects as the launcher would
  const sp = await owner.call("orch.spawn", { prompt: "check the B key", name: "Helper" });
  const child = await fake(sp.id, sp.name, 34); await sleep(2500);

  // W1
  const po = cli("hp-owner", "project-of", "--ensure"), pc = cli(sp.id, "project-of", "--ensure"), folder = path.join(H, "Obsidian", "Projects", "vibez");
  ok("W1 project-of: the owner works for @vibez, folder ~/Obsidian/Projects/vibez, role owner", po === "vibez\t~/Obsidian/Projects/vibez\towner", JSON.stringify(po));
  ok("W1 project-of: its task agent works for @vibez too, role task", pc === "vibez\t~/Obsidian/Projects/vibez\ttask", JSON.stringify(pc));
  ok("W1 … and --ensure created the folder", fs.statSync(folder).isDirectory());
  const core = await import(path.join(FORUM, "src/core.ts"));
  const fcfg = { board: "~/Obsidian/Agent Message Board", projects: "~/Obsidian/Projects", user: "Angus", projectOf: `${process.execPath} ${path.join(ROOT, "bin/hyprpi")} project-of --ensure` };
  const runAs = (id) => (cmd, args) => execFileSync(cmd, args, { env: { ...env, HYPRPI_AGENT_ID: id }, encoding: "utf8", timeout: 8000 });
  const pOwner = core.resolveProject(fcfg, runAs("hp-owner")), pTask = core.resolveProject(fcfg, runAs(sp.id));
  const hOwner = core.render(core.loadCommand("handoff").body, fcfg, "", pOwner), hTask = core.render(core.loadCommand("handoff").body, fcfg, "", pTask);
  ok("W1 /handoff for the project agent: write the report into ~/Obsidian/Projects/vibez/ and link it with hyprpi project-handoff", /works for the project @vibez\*\*/.test(hOwner) && hOwner.includes("`~/Obsidian/Projects/vibez/YYYY-MM-DD HH-MM handoff <your name>.md`") && /hyprpi project-handoff/.test(hOwner), "");
  ok("W1 /handoff for its task agent: the same folder, and it says it's a task agent", /@vibez \(you are a task agent of its project agent\)/.test(hTask) && hTask.includes("~/Obsidian/Projects/vibez/"));
  // W2: the agent writes its report there, then links it
  const rep = path.join(folder, "2026-10-15 16-00 handoff Owner.md"); fs.writeFileSync(rep, "# handoff\n");
  const linked = cli("hp-owner", "project-handoff", rep);
  const pr = (await owner.call("board.get", { room: "D" })).projects.find((p) => p.name === "vibez");
  ok("W2 the card records the folder and links the report", pr.folder === "~/Obsidian/Projects/vibez" && pr.handoff?.path === "~/Obsidian/Projects/vibez/2026-10-15 16-00 handoff Owner.md" && /@vibez: the card links/.test(linked), JSON.stringify({ folder: pr.folder, handoff: pr.handoff }));
  const rep2 = path.join(folder, "2026-10-15 16-05 handoff Helper.md"); fs.writeFileSync(rep2, "# helper\n"); cli(sp.id, "project-handoff", rep2);
  ok("W2 a task agent's report is linked on its project's card too", (await owner.call("board.get", { room: "D" })).projects.find((p) => p.name === "vibez").handoff?.path.endsWith("handoff Helper.md"));
  const outside = path.join(H, "elsewhere.md"); fs.writeFileSync(outside, "x");
  ok("W2 a report outside the project's folder is refused", /must be in ~\/Obsidian\/Projects\/vibez\//.test(cliErr("hp-owner", "project-handoff", outside)));
  // the real board panel, in a pty, against this daemon (a fake hyprctl only)
  const B = path.join(T, "bin"); fs.mkdirSync(B, { recursive: true });
  fs.writeFileSync(path.join(B, "hyprctl"), `#!/bin/sh\ncase "$*" in *clients*) echo '[]';; *activeworkspace*) echo '{"id":31}';; *) echo '[]';; esac\n`, { mode: 0o755 });
  const out = path.join(T, "board.out");
  const pe = { ...env, PATH: `${B}:${process.env.PATH}`, HYPRPI_ALLOW_HYPR: "1", TERM: "xterm-256color", COLORTERM: "truecolor" };
  const bp = spawn("script", ["-qfec", `stty cols 120 rows 40; exec ${process.execPath} ${path.join(ROOT, "mockups", "board-tui.mjs")} D`, out], { env: pe, stdio: ["pipe", "ignore", "ignore"] });
  await sleep(5000); try { bp.kill("SIGTERM"); } catch { /* gone */ } await sleep(300); try { bp.kill("SIGKILL"); } catch { /* gone */ }
  const txt = fs.readFileSync(out, "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  ok("W2 the board panel shows the card's Folder line: the folder and the latest handoff", /Folder\s+~\/Obsidian\/Projects\/vibez\/ · latest handoff ~\/Obsidian\/Projects\/vibez\/2026-10-15 16-05 handoff Helper\.md/.test(txt.replace(/\s*\n\s*/g, " ")), (txt.match(/Folder.{0,120}/) || [""])[0]);
  // W3
  ok("W3 a loose agent: project-of prints nothing", cli("hp-loose", "project-of", "--ensure") === "");
  ok("W3 … and resolveProject gives none", core.resolveProject(fcfg, runAs("hp-loose")) === null);
  const before = execFileSync("git", ["-C", FORUM, "show", "57cb351:commands/handoff.md"], { encoding: "utf8" }).replace(/^<!--[\s\S]*?-->\n/, "");
  ok("W3 … and /handoff renders exactly as before J651", core.render(core.loadCommand("handoff").body, fcfg, "notes", null) === core.render(before, fcfg, "notes", null));
  ok("W3 … also with no projectOf configured (other people's setups)", core.resolveProject({ ...fcfg, projectOf: undefined }) === null);
  // W4
  const welcome = ev[sp.id].filter((x) => x.e === "prompt").map((x) => x.x.text).join("\n");
  ok("W4 the task agent's welcome: send your project agent a one-line digest after any decision (T15), reports in the project folder", /task agent of @vibez/.test(welcome) && /after any decision .* one-line digest with report_to_parent \(not final\)/.test(welcome) && welcome.includes("~/Obsidian/Projects/vibez/"), welcome.slice(0, 200));
  const sp2 = await loose.call("orch.spawn", { prompt: "x", name: "LooseKid" }); const k2 = await fake(sp2.id, sp2.name, 35); await sleep(2500);
  ok("W4 a loose agent's child gets no project line", !/task agent of @/.test(ev[sp2.id].filter((x) => x.e === "prompt").map((x) => x.x.text).join("\n")));
  // a non-final report reaches the parent (the digest's channel)
  await child.call("orch.report", { text: "decided: keep B as the toggle", final: false }); await sleep(800);
  ok("W4 the digest reaches the project agent (a non-final report_to_parent)", ev["hp-owner"].some((x) => /keep B as the toggle/.test(JSON.stringify(x.x))), "");
  owner.close(); loose.close(); child.close(); k2.close();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { d.kill("SIGTERM"); await sleep(300); try { d.kill("SIGKILL"); } catch { /* gone */ } }

// W7
const { PROJECT_AGENT_SECTION } = await import(path.join(ROOT, "lib/project-agent.mjs"));
const th = fs.readFileSync(path.join(ROOT, "lib/thoughts.mjs"), "utf8");
ok("W7 owners' section: one line with the exact one-line format", PROJECT_AGENT_SECTION.split("\n").filter((l) => l.includes("`T12: question? (y/n)` or `T12: question? a. one, b. two`")).length === 1);
ok("W7 Thoughts' prompt: one line with the format, its number as the label", th.split("\n").filter((l) => l.includes("`81: question? (y/n)` or `81: question? a. one, b. two`")).length === 1);
console.log(fails ? `project-handoff: ${fails} FAILED (state ${T})` : "project-handoff: all pass"); process.exit(fails ? 1 : 0);
