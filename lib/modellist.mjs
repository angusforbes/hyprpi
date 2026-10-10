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
// pi's pattern language: * inside one segment, ** across segments, ? one char, [..] a class; anything else literal
const segRe = (t) => { let o = "", i = 0; // one path segment: ** inside a segment is just *, ? one char, [..] a class that can't contain "/"
  while (i < t.length) { const c = t[i];
    if (c === "*") { while (t[i + 1] === "*") i++; o += "[^/]*"; i++; continue; } if (c === "?") { o += "[^/]"; i++; continue; }
    if (c === "[") { const e = t.indexOf("]", i + 1); if (e > i + 1) { let body = t.slice(i + 1, e).replace(/\//g, ""); const neg = /^[!^]/.test(body); if (neg) body = body.slice(1); o += "[" + (neg ? "^/" : "") + body.replace(/\\/g, "\\\\") + "]"; i = e + 1; continue; } }
    o += c.replace(/[.+^${}()|[\]\\\/]/g, "\\$&"); i++; }
  return o; };
// pi's pattern language: a segment that is exactly ** matches any number of segments; elsewhere * stays inside one segment
const globRe = (p) => { const segs = norm(p).split("/"); let o = "";
  segs.forEach((sg, k) => { const last = k === segs.length - 1;
    if (sg === "**") o += last ? (k === 0 ? ".*" : ".*") : (k === 0 ? "(?:.*/)?" : "(?:.*/)?"); // the separator after a middle/leading ** is optional-with-it
    else o += segRe(sg) + (last ? "" : "/"); });
  return new RegExp("^" + o + "$"); };
const hasGlob = (p) => /[*?[]/.test(p);
// does one pattern select this "provider/id"? A pattern with a "/" must match the whole; one without also matches the id part
function matches(p, full) {
  const pn = norm(p), r = globRe(p);
  if (r.test(full)) return true;
  if (pn.includes("/")) return false;
  if (!hasGlob(pn)) return false; // a bare name without a glob is pi's fuzzy "pick one model" lookup: not evaluated here (unsupported, see unsupportedPatterns)
  return r.test(full.slice(full.indexOf("/") + 1)); // the id part (no fuzzy substring matching: pi picks ONE model for a fuzzy name, a substring would allow many)
}
// pi can't read the file -> throw (fail closed); no file or no list -> []
export const readList = (file = settingsFile()) => {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw new Error(`can't read ${file}: ${e.message}`); }
  let v; try { v = JSON.parse(text).enabledModels; } catch (e) { throw new Error(`${file} doesn't parse (${e.message}), so hyprpi can't tell which models are allowed`); }
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
};

// -> the matching pattern, "" when none matches, "*" when there is no list (everything is allowed).
// A bare id (no provider) is resolved against the models pi actually knows; it is allowed only if EVERY model it could mean is listed
// (and fail closed when it can't be resolved).
export function allowedBy(model, patterns = readList()) {
  if (!patterns.length) return "*";
  const m = norm(model); if (!m) return "";
  const find = (full) => patterns.find((p) => matches(p, full)) || "";
  // identity first: what pi would actually run for this string (an exact "provider/id" wins; else a provider-less id, which may itself contain slashes)
  let known; try { known = knownModels().map(norm); } catch { known = null; }
  if (!known) return ""; // pi's registry can't be read: fail closed
  const exact = known.includes(m), cands = exact ? [m] : known.filter((k) => k.slice(k.indexOf("/") + 1) === m);
  if (!cands.length) return ""; // an identity pi doesn't know can't be shown to be listed: fail closed
  const hits = cands.map(find); return hits.every(Boolean) ? hits[0] : "";
}
// scope entries hyprpi can't evaluate (a bare name without a glob: pi resolves it to ONE model by fuzzy lookup)
export const unsupportedPatterns = (patterns = readList()) => patterns.filter((p) => !norm(p).includes("/") && !hasGlob(norm(p)));
export function notAllowed(model, suggestion) {
  return `the model ${norm(model)} is not on the host's scoped model list (enabledModels in ~/.pi/agent/settings.json), so it wasn't used. Use ${suggestion} instead.`;
}

// every "provider/id" pi knows (to expand a glob when one model must come out of it)
let known = null, knownAt = 0;
export function knownModels() {
  if (known && Date.now() - knownAt < 10 * 60000) return known;
  const r = spawnSync(process.env.HYPRPI_PI || "pi", ["--list-models"], { encoding: "utf8", timeout: 60000, cwd: os.homedir() });
  const out = []; for (const l of String(r.stdout || "").split("\n").slice(1)) { const [p, id] = l.trim().split(/\s+/); if (p && id) out.push(`${p}/${id}`); }
  if (r.status !== 0 || !out.length) throw new Error(`\`pi --list-models\` failed or listed nothing (exit ${r.status}); the model list can't be expanded safely`);
  known = out; knownAt = Date.now(); return known;
}
export const setKnownModels = (list) => { known = list; knownAt = Date.now() + 3600e3 * 24; };

// Take one exact model off the list (J394's "ban", J397): an exact entry is deleted; a glob that matches it is replaced by
// its explicit expansion minus the model (pi has no "except" pattern). A backup first, an atomic write, other settings untouched.
// -> { removed: true, how, backup } | { removed: false, already: true }; throws when it can't be done safely
export function removeModel(model, { file = settingsFile(), id = "J397", protect = [] } = {}) {
  model = norm(model);
  if (!/^[\w.:@~-]+\/[\w.:@~\/-]{1,119}$/.test(model) || model.includes("*")) throw new Error(`not an exact provider/id model: ${JSON.stringify(model).slice(0, 80)}`);
  for (const q of protect.map(norm).filter(Boolean)) if (model === q || model.endsWith("/" + q) || q.endsWith("/" + model)) throw new Error(`${model} is protected (a Thoughts model); not taken off the list: switch that by hand`);
  file = fs.realpathSync(file);
  // the (slow) listing first, then read, edit and write with nothing awaited in between, so a concurrent change by pi is lost only in that instant
  let first; try { first = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`can't read the settings file: ${e.message}`); }
  if ((Array.isArray(first.enabledModels) ? first.enabledModels : []).some((p) => hasGlob(norm(p)))) knownModels();
  const st = fs.statSync(file), text = fs.readFileSync(file, "utf8"), cfg = JSON.parse(text), list = Array.isArray(cfg.enabledModels) ? cfg.enabledModels.map(String) : [];
  if (!list.length) throw new Error("there is no enabledModels list (everything is allowed): nothing to take it off; add a list first");
  if (!list.some((p) => matches(p, model))) return { removed: false, already: true };
  let next = [], how = [];
  for (const p of list) {
    if (!matches(p, model)) { next.push(p); continue; }
    if (norm(p) === model) { how.push(`removed the entry ${p}`); continue; }
    const exp = knownModels().filter((k) => matches(p, norm(k)) && norm(k) !== model);
    if (!exp.length) throw new Error(`couldn't expand the pattern ${p} (pi --list-models gave nothing for it); nothing changed`);
    next.push(...exp); how.push(`replaced the pattern ${p} by the ${exp.length} models pi lists for it, without ${model} (pi has no exclusion pattern; models pi doesn't list right now are not carried over)`);
  }
  next = [...new Set(next)];
  if (!next.length) throw new Error(`taking ${model} off would leave the list empty, and an empty list means \"every model is allowed\"; nothing changed`);
  if (next.some((p) => matches(p, model))) throw new Error("the edited list still allows the model; nothing written");
  const iso = new Date().toISOString(), backup = `${file}.bak-${id}-${iso.replace(/[-:.TZ]/g, "")}`;
  const indent = /^\{\n( +)"/.exec(text)?.[1].length || 2;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file + ".tmp", JSON.stringify({ ...cfg, enabledModels: next }, null, indent) + (text.endsWith("\n") ? "\n" : ""), { mode: st.mode & 0o777 }); fs.chmodSync(file + ".tmp", st.mode & 0o777); fs.renameSync(file + ".tmp", file);
  return { removed: true, how: how.join("; "), backup: path.basename(backup) };
}

// Models hyprpi.jsonc itself names (ladder, kinds, review, thoughts) that the list doesn't allow -> [{ where, model }]
export function auditPolicy(policy, patterns = readList(), extra = []) {
  const R = policy.routing || {}, found = extra.map(([w, m]) => [w, m]);
  (R.ladder || []).forEach((s, i) => found.push([`routing.ladder[${i}]`, s]));
  for (const [k, v] of Object.entries(R.kinds || {})) if (typeof v === "string") found.push([`routing.kinds.${k}`, v]);
  const walk = (o, p) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (/model$/i.test(k) && typeof v === "string" && v) found.push([`${p}.${k}`, v]); else walk(v, `${p}.${k}`); } };
  walk(policy.thoughts, "thoughts"); walk(policy.orchestration, "orchestration");
  return found.filter(([, m]) => !allowedBy(m, patterns)).map(([where, model]) => ({ where, model: norm(model) }));
}
