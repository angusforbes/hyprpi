// J397 (Angus: "one list"): the host's scoped model list (pi's enabledModels in ~/.pi/agent/settings.json) is the ONLY list.
// hyprpi refuses any model that list doesn't match (spawn, open, set_model, explicit or routed); a garbled model is taken OFF it.
// Patterns are pi's: exact "provider/id", case-insensitive globs ("anthropic/*", "nv-inference/**": * stays inside one path
// segment, ** crosses them), an optional ":thinking" suffix (ignored here). An empty or missing list means "all models" (pi's own rule).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const THINK = /:(off|minimal|low|medium|high|xhigh|max)$/;
export const settingsFile = () => path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "settings.json");
const norm = (m) => String(m || "").trim().replace(THINK, "").toLowerCase();
const re = (p) => new RegExp("^" + norm(p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
export const readList = (file = settingsFile()) => { try { const v = JSON.parse(fs.readFileSync(file, "utf8")).enabledModels; return Array.isArray(v) ? v.map(String).filter(Boolean) : []; } catch { return []; } };

// -> the matching pattern, "" when none matches, "*" when there is no list (everything is allowed)
export function allowedBy(model, patterns = readList()) {
  if (!patterns.length) return "*";
  const m = norm(model); if (!m) return "";
  const cands = m.includes("/") ? [m] : [m, ...[...new Set(patterns.map((p) => norm(p).split("/")[0]))].map((pr) => `${pr}/${m}`)]; // a bare id: try each listed provider
  for (const p of patterns) { const r = re(p); if (cands.some((c) => r.test(c))) return p; }
  return "";
}
export function notAllowed(model, suggestion) {
  return `the model ${norm(model)} is not on the host's scoped model list (enabledModels in ~/.pi/agent/settings.json), so it wasn't used. Use ${suggestion} instead.`;
}

// every "provider/id" pi knows (to expand a glob when one model must come out of it)
let known = null;
export function knownModels() {
  if (known) return known;
  const r = spawnSync(process.env.HYPRPI_PI || "pi", ["--list-models"], { encoding: "utf8", timeout: 60000, cwd: os.homedir() });
  const out = []; for (const l of String(r.stdout || "").split("\n").slice(1)) { const [p, id] = l.trim().split(/\s+/); if (p && id) out.push(`${p}/${id}`); }
  return (known = out);
}
export const setKnownModels = (list) => { known = list; };

// Take one exact model off the list (J394's "ban", J397): an exact entry is deleted; a glob that matches it is replaced by
// its explicit expansion minus the model (pi has no "except" pattern). A backup first, an atomic write, other settings untouched.
// -> { removed: true, how, backup } | { removed: false, already: true }; throws when it can't be done safely
export function removeModel(model, { file = settingsFile(), id = "J397" } = {}) {
  model = norm(model);
  if (!/^[\w.:@~-]+\/[\w.:@~\/-]{1,119}$/.test(model) || model.includes("*")) throw new Error(`not an exact provider/id model: ${JSON.stringify(model).slice(0, 80)}`);
  file = fs.realpathSync(file);
  const text = fs.readFileSync(file, "utf8"), cfg = JSON.parse(text), list = Array.isArray(cfg.enabledModels) ? cfg.enabledModels.map(String) : [];
  if (!list.length) throw new Error("there is no enabledModels list (everything is allowed): nothing to take it off; add a list first");
  if (!allowedBy(model, list)) return { removed: false, already: true };
  let next = [], how = [];
  for (const p of list) {
    const hit = re(p).test(model);
    if (!hit) { next.push(p); continue; }
    if (norm(p).replace(THINK, "") === model) { how.push(`removed the entry ${p}`); continue; }
    const exp = knownModels().filter((k) => re(p).test(norm(k)) && norm(k) !== model);
    if (!exp.length) throw new Error(`couldn't expand the pattern ${p} (pi --list-models gave nothing for it); nothing changed`);
    next.push(...exp); how.push(`replaced the pattern ${p} by its ${exp.length} explicit models without ${model} (pi has no exclusion pattern)`);
  }
  next = [...new Set(next)];
  if (allowedBy(model, next)) throw new Error("the edited list still allows the model; nothing written");
  const iso = new Date().toISOString(), backup = `${file}.bak-${id}-${iso.replace(/[-:.TZ]/g, "")}`;
  const indent = /^\{\n( +)"/.exec(text)?.[1].length || 2;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file + ".tmp", JSON.stringify({ ...cfg, enabledModels: next }, null, indent) + (text.endsWith("\n") ? "\n" : "")); fs.renameSync(file + ".tmp", file);
  return { removed: true, how: how.join("; "), backup: path.basename(backup) };
}

// Models hyprpi.jsonc itself names (ladder, kinds, review, thoughts) that the list doesn't allow -> [{ where, model }]
export function auditPolicy(policy, patterns = readList()) {
  const R = policy.routing || {}, found = [];
  (R.ladder || []).forEach((s, i) => found.push([`routing.ladder[${i}]`, s]));
  for (const [k, v] of Object.entries(R.kinds || {})) if (typeof v === "string") found.push([`routing.kinds.${k}`, v]);
  const walk = (o, p) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (/model$/i.test(k) && typeof v === "string" && v) found.push([`${p}.${k}`, v]); else walk(v, `${p}.${k}`); } };
  walk(policy.thoughts, "thoughts"); walk(policy.orchestration, "orchestration");
  return found.filter(([, m]) => !allowedBy(m, patterns)).map(([where, model]) => ({ where, model: norm(model) }));
}
