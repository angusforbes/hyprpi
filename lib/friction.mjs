// J488 (Angus: "i like what you ae saying bout hte auto skills builder... make it so!"): his complaints are a cue.
// Every Thoughts (and any agent, via `hyprpi friction`) logs a friction to one shared Markdown file he can read;
// the second time the same KIND comes up, the answer tells Thoughts to propose one small, specific skill (or a
// hook, for a hard rule); once a skill is linked to a kind, entries after it count as recurrences (it isn't
// working). File (config.json frictionLog, default ~/Obsidian/Notes/Friction log.md):
//   ## Skills   - <kind> → <skill name or path>, since YYYY-MM-DD HH:MM
//   ## Entries  - YYYY-MM-DD HH:MM · <world> · <kind> · <agent> · <what happened> · fix: <what fixed it>
import fs from "node:fs";
import path from "node:path";

const HEAD = `# Friction log

What Angus complained about, so that a repeat becomes a small, specific skill or hook (J488). Every Thoughts logs here with friction_log; agents with \`hyprpi friction add\`. The second time a kind comes up, Thoughts proposes one skill (or a hook for a hard rule) in one line; a kind with a skill that comes up again means the skill isn't working.

## Skills

## Entries
`;
const SKILL_RE = /^- ([a-z0-9][a-z0-9-]*) → (.+?), since (\d{4}-\d\d-\d\d \d\d:\d\d)$/;
const ENTRY_RE = /^- (\d{4}-\d\d-\d\d \d\d:\d\d) · ([A-Z0-9]+|-) · ([a-z0-9][a-z0-9-]*) · ([^·]*) · (.*?)(?: · fix: (.*))?$/;

const pad = (n) => String(n).padStart(2, "0");
export const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const clean = (s, max = 400) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/·/g, "-").replace(/\s+/g, " ").trim().slice(0, max);
export function kindOf(k) {
  const x = String(k || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!x) throw new Error("kind: a short tag for this kind of friction, e.g. desktop-input-testing (reuse an existing one when it fits: list shows them)");
  return x;
}

export function read(file) {
  let t = ""; try { t = fs.readFileSync(file, "utf8"); } catch { /* none yet */ }
  const skills = new Map(), entries = [];
  for (const line of t.split("\n")) {
    let m = SKILL_RE.exec(line); if (m) { skills.set(m[1], { kind: m[1], skill: m[2], since: m[3] }); continue; }
    m = ENTRY_RE.exec(line); if (m) entries.push({ at: m[1], world: m[2], kind: m[3], agent: m[4].trim(), what: m[5].trim(), fix: (m[6] || "").trim() });
  }
  return { text: t, skills, entries };
}

// Per kind: how often, first / last, its skill, and how many entries came after the skill (recurrences).
export function summary(file) {
  const { skills, entries } = read(file), kinds = new Map();
  for (const e of entries) {
    const k = kinds.get(e.kind) || { kind: e.kind, count: 0, first: e.at, last: e.at, skill: "", since: "", after: 0 };
    k.count++; if (e.at < k.first) k.first = e.at; if (e.at > k.last) k.last = e.at; kinds.set(e.kind, k);
  }
  for (const [kind, s] of skills) {
    const k = kinds.get(kind) || { kind, count: 0, first: "", last: "", after: 0 };
    k.skill = s.skill; k.since = s.since; k.after = entries.filter((e) => e.kind === kind && e.at > s.since).length; kinds.set(kind, k);
  }
  return [...kinds.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

function ensure(file) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, HEAD);
}
// Insert a line at the end of a section ("## Skills" / "## Entries").
function insert(file, section, line) {
  ensure(file);
  const lines = fs.readFileSync(file, "utf8").replace(/\n+$/, "").split("\n");
  let i = lines.findIndex((l) => l.trim() === section);
  if (i < 0) { lines.push("", section); i = lines.length - 1; }
  let j = i + 1; while (j < lines.length && !/^## /.test(lines[j])) j++;
  while (j > i + 1 && !lines[j - 1].trim()) j--; // before trailing blank lines
  lines.splice(j, 0, line);
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

// What Thoughts should do next, given this kind's state (the cue is in the answer, not in Thoughts' memory).
export function advice(k) {
  if (k.skill && k.after > 0) return `It came up again AFTER its skill (${k.skill}, since ${k.since}): ${k.after} time${k.after > 1 ? "s" : ""}. Tell Angus in one line that the skill isn't working and propose a fix to it.`;
  if (k.skill) return `It has a skill (${k.skill}); nothing to tell Angus.`;
  if (k.count >= 2) return `This is the ${k.count === 2 ? "second" : k.count + "th"} time. Propose ONE small, specific skill (or a hook if it's a hard rule) to Angus in one line, e.g. "Same friction again (${k.kind}): shall I add a skill '<name>': <the 2–3 hints>?"; brief it on his OK, then link it with friction_log skill.`;
  return "First time: just get it fixed; nothing to tell Angus.";
}

export function add(file, p, d = new Date()) {
  const kind = kindOf(p.kind), what = clean(p.what, 500);
  if (!what) throw new Error("what: what happened, in a sentence");
  const before = new Set(summary(file).map((k) => k.kind));
  insert(file, "## Entries", `- ${stamp(d)} · ${clean(p.world || "-", 4) || "-"} · ${kind} · ${clean(p.agent || "-", 60) || "-"} · ${what}${p.fix ? ` · fix: ${clean(p.fix, 300)}` : ""}`);
  const all = summary(file), k = all.find((x) => x.kind === kind);
  return { kind, count: k.count, skill: k.skill, after: k.after, new_kind: !before.has(kind), kinds: all.map((x) => `${x.kind} ${x.count}`), advice: advice(k) };
}

export function linkSkill(file, p, d = new Date()) {
  const kind = kindOf(p.kind), skill = clean(p.skill, 200);
  if (!skill) throw new Error("skill: the skill's name or path (e.g. ~/.pi/agent/skills/desktop-input-testing/SKILL.md)");
  insert(file, "## Skills", `- ${kind} → ${skill}, since ${stamp(d)}`);
  return summary(file).find((x) => x.kind === kind);
}
