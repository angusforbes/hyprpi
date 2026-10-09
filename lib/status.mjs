// J337 (Angus: "a new hyprpi command called "/status" it just summarizes everything that you'er working on now or
// recently finsihed, works in thoughts or hyprpi agents, absically as if i had asked "Ok where are we now with our
// projects and activiites?""): the facts behind /status, as plain text for the model that writes the answer.
//
// The daemon gathers the data (lib/daemon.mjs statusData: live agents, briefs, the board, held messages, the restart
// queue, unpushed commits); this file only filters and words it, so it can be tested without a daemon.
//   statusText(data)   → the facts as text (what the model is given; `hyprpi status` prints it)
//   statusPrompt(o)    → the instruction around the facts, for Thoughts or for an agent window
//   unpushedRepos(dir) → git repos under dir with commits their upstream doesn't have
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";

export const RECENT_H = 6; // "recently" = the last 6 hours

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export function ago(ts, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ts) / 60000));
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
// The first line of a report that says what happened ("changed: …" usually), without the field label.
export function reportGist(r, n = 220) {
  const t = String(r || "").trim();
  if (!t) return "";
  const m = /(?:^|\n)\s*changed:\s*([\s\S]*?)(?:\n\s*(?:proof|undo|surprises|open):|$)/i.exec(t);
  return clip(m ? m[1] : t.split("\n")[0], n);
}
const openOf = (r) => { const m = /(?:^|\n)\s*open:\s*([\s\S]*)$/i.exec(String(r || "")); return m ? clip(m[1], 200) : ""; };

// data: see lib/daemon.mjs statusData. Returns the facts as text.
export function statusText(d) {
  const now = d.now || Date.now(), H = d.recentH || RECENT_H, since = now - H * 3600e3, out = [];
  const scope = d.self ? `${d.self}'s own work (an agent window)` : d.focus?.kind === "project" ? `project @${d.focus.name}` : d.focus?.kind === "agent" ? `agent ${d.focus.name}` : "everything";
  out.push(`Status facts for world ${d.room}, ${new Date(now).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}, live from the hyprpi daemon. Scope: ${scope}.`);
  if (d.focus?.kind === "unknown") out.push(`("${d.focus.raw}" is no project or live agent in world ${d.room}, so this is everything.)`);

  const jobs = d.jobs || [];
  const running = jobs.filter((j) => j.state === "running" || j.state === "stopped");
  const recent = jobs.filter((j) => ["done", "verified", "cancelled"].includes(j.state) && j.updated >= since);
  const unverified = jobs.filter((j) => j.state === "done"); // any age: still waiting for a check (review J337 #4)

  out.push("", `Agents${d.self ? "" : " (live)"}:`);
  if (!(d.agents || []).length) out.push("- none");
  for (const a of d.agents || []) out.push(`- ${a.name}${a.ws ? ` (${a.ws})` : ""}: ${a.status}${a.parked ? ", parked" : ""}${a.topic ? ` · ${clip(a.topic, 80)}` : ""}${a.projects?.length ? ` · ${a.projects.map((p) => "@" + p).join(" ")}` : ""}`);
  if (d.children?.length) { out.push("", "Its helper agents:"); for (const c of d.children) out.push(`- ${c.name}: ${c.status}${c.report ? ` · last report: ${clip(c.report, 160)}` : ""}`); }

  out.push("", "Jobs running:");
  if (!running.length) out.push("- none");
  for (const j of running) out.push(`- ${j.id} v${j.version} (${j.agent || "?"}${j.project ? `, @${j.project}` : ""}, ${j.state}, given ${ago(j.created, now)}): ${clip(j.goal, 200)}`);

  out.push("", `Jobs finished in the last ${H} h:`);
  if (!recent.length) out.push("- none");
  for (const j of recent.sort((x, y) => y.updated - x.updated).slice(0, 15)) {
    const st = j.state === "done" ? "reported, not yet verified" : j.state;
    out.push(`- ${j.id} (${j.agent || "?"}${j.project ? `, @${j.project}` : ""}, ${st}, ${ago(j.updated, now)}): ${clip(j.goal, 160)}${j.report ? `\n    result: ${reportGist(j.report)}` : ""}${openOf(j.report) ? `\n    open: ${openOf(j.report)}` : ""}`);
  }
  if (recent.length > 15) out.push(`- … and ${recent.length - 15} more`);

  out.push("", "Projects (where things stand):");
  if (!(d.projects || []).length) out.push("- none");
  for (const p of d.projects || []) {
    out.push(`- @${p.name}${p.title ? ` (${clip(p.title, 70)})` : ""}${p.status && p.status !== "active" ? ` [${p.status}]` : ""}`);
    if (p.where) out.push(`    where: ${clip(p.where, 220)}`);
    if (p.next_step) out.push(`    next step: ${clip(p.next_step, 200)}`);
    for (const t of (p.done || []).slice(-4)) out.push(`    done recently: ${clip(t, 160)}`);
  }

  out.push("", "Waiting on Angus:");
  let w = 0;
  for (const x of d.decisions || []) { w++; out.push(`- decision @${x.project} ${x.h} (asked by ${x.by}, ${ago(x.ts, now)}): ${clip(x.text, 200)}${x.options?.length ? ` — ${x.options.map((o) => `${o.key}) ${clip(o.text, 50)}${o.key === x.recommend ? " (recommended)" : ""}`).join(" · ")}` : ""}`); }
  for (const h of d.held || []) { w++; out.push(`- held message from sandbox ${h.sandbox} to ${(h.to || []).join(", ") || "?"}: ${clip(h.text, 160)} (review it in the Thoughts panel)`); }
  if (unverified.length) { w++; const ids = unverified.sort((x, y) => y.updated - x.updated).map((j) => j.id); out.push(`- ${ids.length} job${ids.length === 1 ? "" : "s"} reported but not yet verified (Angus or a second agent checks): ${ids.slice(0, 15).join(", ")}${ids.length > 15 ? `, … ${ids.length - 15} older` : ""}`); }
  if (!w) out.push("- nothing");

  out.push("", "Housekeeping:");
  const r = d.restart;
  out.push(r ? `- daemon restart queued ${ago(r.since, now)} (${(r.reasons || []).map((x) => `${x.by}: ${clip(x.reason, 80)}`).join("; ")}); waiting on ${(r.waiting_on || []).join(", ") || "nobody"}` : "- no daemon restart queued");
  for (const x of d.agentRestarts || []) out.push(`- agent restart pending: ${x.name}${x.waiting ? " (when its turn ends)" : ""}`);
  const up = d.unpushed || [];
  out.push(up.length ? `- unpushed commits: ${up.map((u) => `${u.repo} ${u.count} (newest: ${clip(u.latest, 60)})`).join("; ")}` : "- no unpushed commits");
  return out.join("\n");
}

// The instruction around the facts. who: "thoughts" | "agent".
export function statusPrompt({ who, focus = "", facts }) {
  const shape = `Answer in this shape, short and plain (no tables, no job-id soup: name a job id only where it helps):
Running: what is being worked on now, one line each (who, what, how far).
Recently done (last few hours): what finished, and whether it's verified.
Waiting on you: numbered (1, 2, 3), what Angus has to decide, review or approve; mark a recommendation "(recommended)". Say "nothing" if nothing.
Next: what happens next without him.`;
  const lead = who === "agent"
    ? `[/status from Angus${focus ? ` about "${focus}"` : ""}: "OK, where are we now with what you're working on?"] Summarise YOUR OWN current job and recent work, and what you're waiting on, from your conversation and these live facts (the facts win over memory where they differ). Don't start new work or call tools for this; just answer.`
    : `[/status from Angus${focus ? ` about "${focus}"` : ""}: "OK, where are we now with our projects and activities?"] Answer from these live facts (they are fresh; trust them over what you remember). Don't ask agents, start work or promise follow-ups for this; just answer (Angus can ask for more).`;
  return `${lead}\n${shape}\n\n${facts}`;
}

// The same without blocking (the daemon's version, review J337 #1): every repo at once, each git call capped at
// timeoutMs, the whole scan at deadlineMs (repos not done by then are left out).
const gitAsync = (cwd, args, timeout) => new Promise((res) => execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout }, (err, out) => res(err ? null : String(out || "").trim())));
export async function unpushedReposAsync(dir, { timeoutMs = 2000, deadlineMs = 4000 } = {}) {
  let names = []; try { names = (await fs.promises.readdir(dir)).sort(); } catch { return []; }
  const one = async (n) => {
    const p = path.join(dir, n);
    try { await fs.promises.access(path.join(p, ".git")); } catch { return null; }
    const k = Number(await gitAsync(p, ["rev-list", "--count", "@{u}..HEAD"], timeoutMs));
    if (!k) return null;
    return { repo: n, count: k, latest: (await gitAsync(p, ["log", "-1", "--format=%s"], timeoutMs)) || "" };
  };
  const done = new Map();
  await Promise.race([Promise.all(names.map((n) => one(n).then((r) => done.set(n, r), () => done.set(n, null)))), new Promise((r) => setTimeout(r, deadlineMs).unref?.())]);
  return names.map((n) => done.get(n)).filter(Boolean);
}

// Git repos directly under `dir` (the harness) whose branch is ahead of its upstream (sync: the CLI and tests).
export function unpushedRepos(dir) {
  const out = [];
  let names = []; try { names = fs.readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    const p = path.join(dir, n);
    if (!fs.existsSync(path.join(p, ".git"))) continue;
    const g = (...a) => spawnSync("git", ["-C", p, ...a], { encoding: "utf8", timeout: 3000 });
    const c = g("rev-list", "--count", "@{u}..HEAD");
    const k = Number(String(c.stdout).trim());
    if (c.status !== 0 || !k) continue;
    out.push({ repo: n, count: k, latest: String(g("log", "-1", "--format=%s").stdout || "").trim() });
  }
  return out;
}
