#!/usr/bin/env node
// J413 proof (Angus "4 yes"): on a Loose jobs card (writer = a Thoughts agent, J10) a finished job
// (done / verified) archives itself a day after its last state change, a stopped / cancelled one an hour
// after; running jobs and other cards are untouched; a job that runs again gets its line back; board care
// then has nothing stale to report about them.
//   node test/loose-jobs-archive.mjs [REAL_STATE_DIR]   (exit 0 = pass)
// A) lib/board.mjs finishedLooseJobs (pure).
// B) an isolated daemon (temp socket + state, no Hyprland) on a fixture board: the start-up pass archives
//    the right lines; verify_work failed:true reopens an archived done job and its line comes back.
// C) with REAL_STATE_DIR (e.g. ~/.local/state/hyprpi): a COPY of its boards/ and briefs.json; reports which
//    Loose-jobs lines the daemon archives (read-only for the real state).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { finishedLooseJobs, staleItems } from "../lib/board.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const H = 3600e3, D = 24 * H, now = Date.now();

// ---- A) pure
const items = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"].map((h) => ({ h, sec: "next", text: h, ts: now - 5 * D, updated: now - 5 * D }));
items.push({ h: "N9", sec: "done", text: "N9", ts: now - 5 * D }); items.push({ h: "N10", sec: "next", text: "N10", ts: now - 5 * D, archived: now - D });
const jobs = [
  { item: "N1", state: "done", updated: now - 2 * D },       // archive
  { item: "N2", state: "done", updated: now - 2 * H },       // keep (grace: a day)
  { item: "N3", state: "verified", updated: now - 25 * H },  // archive
  { item: "N4", state: "stopped", updated: now - 2 * H },    // archive
  { item: "N5", state: "stopped", updated: now - 10 * 60e3 },// keep (grace: an hour)
  { item: "N6", state: "cancelled", updated: now - 3 * H },  // archive
  { item: "N7", state: "running", updated: now - 9 * D },    // keep
  { item: "N9", state: "done", updated: now - 9 * D },       // keep (a Done item: archiveOldDone's job)
  { item: "N10", state: "done", updated: now - 9 * D },      // already archived
  { item: "N99", state: "done", updated: now - 9 * D },      // not on the card
];
ok("A finishedLooseJobs", JSON.stringify(finishedLooseJobs({ items }, jobs, now)) === JSON.stringify(["N1", "N3", "N4", "N6"]), JSON.stringify(finishedLooseJobs({ items }, jobs, now)));

// ---- daemon helpers
async function daemon(state, label) {
  const sock = path.join(state, "d.sock"), cfg = path.join(state, "cfg");
  fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false }));
  fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
  const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: "j413-bogus", HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000" };
  delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
  const p = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(state, `${label}.log`), "w"), "inherit"] });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 200));
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const api = await connect({ path: sock, onEvent: () => {} });
  return { p, api, sock };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = async (api, room, name) => (await api.call("board.get", { room })).projects.find((x) => x.name === name);

// ---- B) fixture
{
  const S = fs.mkdtempSync(path.join(os.tmpdir(), "j413-")); fs.mkdirSync(path.join(S, "boards"));
  const mk = (h, sec = "next") => ({ h, sec, text: `⟦${h}⟧`, by: { id: "", name: "Thoughts-Z" }, ts: now - 5 * D, updated: now - 5 * D });
  const loose = { id: "p-lz", name: "inbox-z", title: "Loose jobs", icon: "📥", status: "active", members: [], writer: "thoughts:Z", created: now - 9 * D, updated: now - 5 * D, by: "Thoughts-Z", where: null, next_step: null, seq: { D: 0, N: 7, H: 0 }, items: ["N1", "N2", "N3", "N4", "N5", "N6", "N7"].map((h) => mk(h)) };
  const proj = { id: "p-pz", name: "realproj", title: "a project", icon: "🔧", status: "active", members: [], writer: "hp-nobody", created: now - 9 * D, updated: now - 5 * D, by: "x", where: null, next_step: null, seq: { D: 0, N: 1, H: 0 }, items: [mk("N1")] };
  fs.writeFileSync(path.join(S, "boards", "Z.json"), JSON.stringify({ room: "Z", projects: [loose, proj] }));
  const brief = (id, item, state, updated, project = "p-lz") => [id, { id, version: 1, state, created: now - 9 * D, updated, project, projectName: project === "p-lz" ? "inbox-z" : "realproj", item, agent: "hp-x", agent_name: "Atlas", from: "Thoughts-Z", room: "Z", fields: { goal: id, angus: "x", done_when: ["W1 x"] }, history: [{ version: 1, state, ts: updated }] }];
  fs.writeFileSync(path.join(S, "briefs.json"), JSON.stringify({ next: 10, briefs: Object.fromEntries([
    brief("J1", "N1", "done", now - 2 * D), brief("J2", "N2", "done", now - 2 * H), brief("J3", "N3", "verified", now - 25 * H),
    brief("J4", "N4", "stopped", now - 2 * H), brief("J5", "N5", "stopped", now - 10 * 60e3), brief("J6", "N6", "cancelled", now - 3 * H),
    brief("J7", "N7", "running", now - 9 * D), brief("J8", "N1", "stopped", now - 2 * D, "p-pz"),
  ]) }));
  const { p, api } = await daemon(S, "B");
  await sleep(7000); // the start-up pass runs after 5 s
  const lz = await card(api, "Z", "inbox-z"), pz = await card(api, "Z", "realproj");
  const arch = lz.items.filter((it) => it.archived).map((it) => it.h).join(" ");
  ok("B start-up pass archives N1 N3 N4 N6 on the Loose jobs card", arch === "N1 N3 N4 N6", arch);
  ok("B other cards untouched (a stopped job on a project card stays)", !pz.items.some((it) => it.archived));
  const stale = staleItems(lz).map((it) => it.h).join(" ");
  ok("B board care's stale list has no finished or stopped job", !/N1\b|N3|N4|N6/.test(stale), `stale now: ${stale || "none"} (N7 is running, N2/N5 within their grace)`);
  // A job that runs again (a verifier's FAIL reopens it) gets its line back.
  await api.call("thoughts.verify", { room: "Z", job: "J1", failed: true, by: "Checker", note: "test" });
  await sleep(300);
  const n1 = (await card(api, "Z", "inbox-z")).items.find((it) => it.h === "N1");
  ok("B a reopened job's line is unarchived", n1 && !n1.archived && /running/.test(n1.text), n1 && n1.text);
  p.kill(); await new Promise((r) => p.once("exit", r)); fs.rmSync(S, { recursive: true, force: true });
}

// ---- C) a copy of real state
const REAL = process.argv[2];
if (REAL) {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), "j413r-"));
  fs.cpSync(path.join(REAL, "boards"), path.join(S, "boards"), { recursive: true });
  fs.copyFileSync(path.join(REAL, "briefs.json"), path.join(S, "briefs.json"));
  const before = JSON.parse(fs.readFileSync(path.join(S, "briefs.json"), "utf8")).briefs;
  const { p, api } = await daemon(S, "C");
  await sleep(7000);
  const rooms = fs.readdirSync(path.join(S, "boards")).filter((f) => /^[A-Z]\.json$/.test(f)).map((f) => f[0]);
  for (const room of rooms) {
    const { projects } = await api.call("board.get", { room });
    for (const pr of projects.filter((x) => /^thoughts:/.test(x.writer || ""))) {
      const st = staleItems(pr).map((it) => `${it.h} ${Object.values(before).find((b) => b.project === pr.id && b.item === it.h)?.state || "?"}`);
      const arch = pr.items.filter((it) => it.archived && Object.values(before).some((b) => b.project === pr.id && b.item === it.h && ["done", "verified", "stopped", "cancelled"].includes(b.state))).map((it) => it.h);
      console.log(`C @${pr.name}: archived jobs ${arch.join(" ") || "-"} · still stale ${st.join(", ") || "none"}`);
      if (pr.name === "inbox-c") {
        const a = (h) => pr.items.find((it) => it.h === h)?.archived;
        ok("C real @inbox-c: J176 (N3, done) and J178 (N4, stopped) archived", a("N3") && a("N4"));
        ok("C real @inbox-c: no stale finished/stopped job left", !st.some((x) => /done|verified|stopped|cancelled/.test(x)), st.join(", "));
      }
    }
  }
  p.kill(); await new Promise((r) => p.once("exit", r)); fs.rmSync(S, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
