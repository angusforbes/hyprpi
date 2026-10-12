#!/usr/bin/env node
// lib/models-resolve.mjs: the shared resolver for hyprpi's model config files (J499, J500): brev/models.jsonc (Brev boxes),
// omnistation/models.jsonc (world H) and docker/world/models.jsonc (the sandbox, world G). Runs on the LAPTOP and writes nothing:
// it reads a config and returns the NVIDIA Inference Hub ("nv-inference") model list it picks, which lib/nv-models.mjs applies.
//   node lib/models-resolve.mjs --config FILE [--show]     (brev/models-resolve.mjs = the same with brev's file as default)
// Output JSON: { preset, default, thoughts?, models: [pi model entries], denied: [{ id, why }] }.
// Presets: a list in the file under the preset's name ("short", "claude3gpt3", "custom" or any other name), or
//   "catalog" = every model in docker/world/nv-inference-models.json (the standard tested list, in its order),
//   "laptop"  = the nv-inference models this laptop's pi scopes (its enabledModels, matched by pi's own resolver).
// Then "add", "exclude" and "deny" apply, and "default" is always included.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// JSONC: drop // and /* */ comments, then trailing commas, both only outside strings
const outside = (t, f) => { let o = "", s = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (s) { o += c; if (c === "\\") o += t[++i] ?? ""; else if (c === '"') s = false; continue; } if (c === '"') { s = true; o += c; continue; } const r = f(t, i); if (r) { o += r.out; i = r.next - 1; } else o += c; } return o; };
export const jsonc = (t) => {
  t = outside(t, (t, i) => t[i] === "/" && t[i + 1] === "/" ? { out: "", next: t.indexOf("\n", i) < 0 ? t.length : t.indexOf("\n", i) }
    : t[i] === "/" && t[i + 1] === "*" ? { out: " ", next: t.indexOf("*/", i + 2) < 0 ? t.length : t.indexOf("*/", i + 2) + 2 } : null);
  t = outside(t, (t, i) => { if (t[i] !== ",") return null; let j = i + 1; while (j < t.length && /\s/.test(t[j])) j++; return t[j] === "}" || t[j] === "]" ? { out: "", next: i + 1 } : null; });
  return JSON.parse(t);
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const glob = (p) => new RegExp("^" + String(p).toLowerCase().replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); // deny patterns: * and ?

// -> the resolved object, or throws Error with a message for Angus
export async function resolveModels(cfgFile, { piDir = process.env.HYPRPI_LAPTOP_PI_DIR || path.join(os.homedir(), ".pi/agent"), deps = process.env.HYPRPI_REMOTE_DEPS || path.join(os.homedir(), ".cache/hyprpi-remote") } = {}) {
  let cfg; try { cfg = jsonc(fs.readFileSync(cfgFile, "utf8")); } catch (e) { throw new Error(`can't read ${cfgFile}: ${e.message}`); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`${cfgFile} isn't a JSON object`);
  const list = (k) => (Array.isArray(cfg[k]) ? cfg[k] : []).map(String);
  // catalogs of known model details: the standard list, then the laptop's pi nv-inference provider, then the file's "details";
  // an entry is passed on whole (name, reasoning, input, limits, thinkingLevelMap, …), with its api made explicit
  const tpl = readJson(path.join(REPO, "docker/world/nv-inference-models.json")) || {};
  const lap = readJson(path.join(piDir, "models.json"))?.providers?.["nv-inference"] || {};
  const cat = new Map();
  for (const m of tpl.models || []) cat.set(m.id, { ...m, api: m.api || tpl.api || "openai-responses" });
  for (const m of lap.models || []) cat.set(m.id, { ...(cat.get(m.id) || {}), ...m, api: m.api || lap.api || "openai-responses" });
  for (const [id, d] of Object.entries(cfg.details || {})) cat.set(id, { id, ...(cat.get(id) || {}), ...d });

  const preset = String(cfg.preset || "");
  let ids;
  if (preset === "catalog") ids = (tpl.models || []).map((m) => m.id);
  else if (preset === "laptop") {
    const scoped = (readJson(path.join(piDir, "settings.json"))?.enabledModels || []).map(String);
    // pi's own scope resolver, so this matches exactly what pi on the laptop scopes (from the client packages `world X open` keeps)
    const lapModels = (lap.models || []).map((m) => ({ ...m, provider: "nv-inference", api: m.api || lap.api || "openai-responses", baseUrl: lap.baseUrl }));
    const mr = path.join(deps, "node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js");
    let piScope = null; try { piScope = (await import(mr)).resolveModelScopeFromModels; } catch { /* not installed */ }
    if (!piScope) throw new Error(`preset "laptop" needs pi's model resolver at ${mr} (run \`omnistation/world X open\` once, which installs it); nothing resolved`);
    ids = [...new Set(piScope(scoped, lapModels).scopedModels.map((x) => x.model.id))];
  } else if (/^[A-Za-z][\w-]*$/.test(preset) && Array.isArray(cfg[preset])) ids = list(preset);
  else throw new Error(`"preset" must be catalog, laptop or the name of a list in the file (short, claude3gpt3, custom, …); it is ${JSON.stringify(cfg.preset)}`);
  const def = String(cfg.default || ids[0] || "");
  ids = [...new Set([def, ...ids, ...list("add")])].filter((id) => id && !list("exclude").includes(id));
  const denied = [];
  ids = ids.filter((id) => { const d = (cfg.deny || []).find((x) => glob(x.pattern).test(id.toLowerCase())); if (d) denied.push({ id, why: d.why || d.pattern }); return !d; });
  if (!ids.includes(def)) throw new Error(`the default ${def} is excluded or denied`);
  const bad = ids.filter((id) => { const m = cat.get(id); return !m || !/^openai-(completions|responses)$/.test(m.api || "") || !Number.isSafeInteger(m.contextWindow) || !(m.contextWindow > 0); });
  if (bad.length) throw new Error(`no details for ${bad.join(", ")}: add them under "details" in ${cfgFile}`);
  const models = ids.map((id) => { const m = cat.get(id); return { ...m, id, name: m.name || `${id.split("/").pop()} (Inference Hub)`, input: m.input || ["text", "image"], maxTokens: m.maxTokens || 32000 }; });
  const out = { preset, default: def, models, denied };
  if (cfg.thoughts) { if (!/^[A-Za-z0-9._/:-]+$/.test(String(cfg.thoughts))) throw new Error(`"thoughts" ${JSON.stringify(cfg.thoughts)} isn't a model id`); out.thoughts = String(cfg.thoughts); }
  return out;
}

export async function runCli(argv = process.argv.slice(2), defaultConfig = path.join(REPO, "brev/models.jsonc")) {
  const cfgFile = argv.includes("--config") ? argv[argv.indexOf("--config") + 1] : defaultConfig;
  let r; try { r = await resolveModels(cfgFile); } catch (e) { console.error(`models-resolve: ${e.message}`); process.exit(2); }
  if (argv.includes("--show")) {
    console.log(`preset ${r.preset}: ${r.models.length} models, default ${r.default}${r.thoughts ? `, Thoughts ${r.thoughts}` : ""}`);
    for (const m of r.models) console.log(`  ${m.id}  (${m.api.replace("openai-", "")}, ${m.contextWindow} ctx)`);
    for (const d of r.denied) console.log(`  denied: ${d.id} (${d.why})`);
  } else console.log(JSON.stringify(r));
}
if (import.meta.url === `file://${process.argv[1]}`) await runCli();
