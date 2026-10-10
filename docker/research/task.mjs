// J352 (Angus: idea 2 from the J349 red team, "task-bound research"): the HOST states what a sandbox is working on, in
// ~/.config/hyprpi/worlds/<name>.json as "task": "…". Set by Angus (by hand, `research.mjs task --sandbox X --set …`, or
// by approving a Doorman-drafted task change); never by the sandbox. The Doorman rewrites each research request toward
// that purpose and says whether it serves the task and whether the sandbox's recent requests drift between unrelated
// subjects; the code (research.mjs ask) holds anything off-task, drifting, or asked with no task set, for Angus, in
// every mode, and refuses beyond a few such holds an hour.
import fs from "node:fs";
import path from "node:path";
import { worldsFor, withWorldsLock } from "./mode.mjs";

export const TASK_MAX = 300;
export const NO_TASK = "no task is set for this sandbox, so every search waits for Angus";
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();

// A worlds/<name>.json object → its task ("" when none or not a string).
export function taskOf(w) { const t = w && typeof w === "object" && typeof w.task === "string" ? clean(w.task) : ""; return t.slice(0, TASK_MAX); }

// The one resolver (as the mode's): exactly one worlds file naming the sandbox → its task. None or several → no task
// (which holds every search for Angus: fail closed, never a guess between files).
export function taskForSandbox(cfgDir, sandbox) {
  const hits = worldsFor(cfgDir, sandbox);
  if (hits.length > 1) return { task: "", note: `ambiguous: ${hits.map((h) => h.f).join(", ")} all name ${sandbox}; no task until only one does`, file: "" };
  if (!hits.length) return { task: "", note: "", file: "" };
  return { task: taskOf(hits[0].w), note: "", file: hits[0].f };
}

// Set (or clear, with "") the sandbox's task in its one worlds file: atomic, other keys kept. Host-side only (the
// research CLI, or the relay after Angus approves a task change). → { file, before, task }
export function setTask(cfgDir, sandbox, text) {
  return withWorldsLock(cfgDir, () => setTaskLocked(cfgDir, sandbox, text));
}
function setTaskLocked(cfgDir, sandbox, text) {
  const hits = worldsFor(cfgDir, sandbox);
  if (hits.length !== 1) throw new Error(hits.length ? `${hits.length} worlds files name ${sandbox} (${hits.map((h) => h.f).join(", ")}); fix that first` : `no worlds file names ${sandbox}`);
  const task = clean(text);
  if (task.length > TASK_MAX) throw new Error(`a task is at most ${TASK_MAX} characters`);
  const f = path.join(cfgDir, "worlds", hits[0].f), w = JSON.parse(fs.readFileSync(f, "utf8")), before = taskOf(w);
  if (task) w.task = task; else delete w.task;
  const tmp = `${f}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(w, null, 2) + "\n", { mode: fs.statSync(f).mode & 0o777 }); fs.renameSync(tmp, f);
  return { file: f, before, task };
}
