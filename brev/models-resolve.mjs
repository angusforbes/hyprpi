#!/usr/bin/env node
// brev/models-resolve.mjs [--config FILE] [--show]: runs on the LAPTOP (J499). Reads brev/models.jsonc and prints the resolved
// nv-inference model list as JSON ({ "default": id, "models": [pi model entries], "denied": [{id, why}] }), which `world X setup`
// sends to the box for brev/nv-models.mjs. --show prints a readable list instead. Reads the laptop's pi files; writes nothing.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname), args = process.argv.slice(2);
const cfgFile = args.includes("--config") ? args[args.indexOf("--config") + 1] : path.join(here, "models.jsonc");
const PI = process.env.HYPRPI_LAPTOP_PI_DIR || path.join(os.homedir(), ".pi/agent");
const die = (s) => { console.error(`models-resolve: ${s}`); process.exit(2); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
// JSONC: drop // and /* */ comments, then trailing commas, both only outside strings
const outside = (t, f) => { let o = "", s = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (s) { o += c; if (c === "\\") o += t[++i] ?? ""; else if (c === '"') s = false; continue; } if (c === '"') { s = true; o += c; continue; } const r = f(t, i); if (r) { o += r.out; i = r.next - 1; } else o += c; } return o; };
const jsonc = (t) => {
  t = outside(t, (t, i) => t[i] === "/" && t[i + 1] === "/" ? { out: "", next: t.indexOf("\n", i) < 0 ? t.length : t.indexOf("\n", i) }
    : t[i] === "/" && t[i + 1] === "*" ? { out: " ", next: t.indexOf("*/", i + 2) < 0 ? t.length : t.indexOf("*/", i + 2) + 2 } : null);
  t = outside(t, (t, i) => { if (t[i] !== ",") return null; let j = i + 1; while (j < t.length && /\s/.test(t[j])) j++; return t[j] === "}" || t[j] === "]" ? { out: "", next: i + 1 } : null; });
  return JSON.parse(t);
};
let cfg; try { cfg = jsonc(fs.readFileSync(cfgFile, "utf8")); } catch (e) { die(`can't read ${cfgFile}: ${e.message}`); }
const list = (k) => (Array.isArray(cfg[k]) ? cfg[k] : []).map(String);
const glob = (p) => new RegExp("^" + String(p).toLowerCase().replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); // deny patterns: * and ?

// catalogs of known model details: the laptop's pi nv-inference provider, then the sandbox world's list, then "details"
const lap = readJson(path.join(PI, "models.json"))?.providers?.["nv-inference"] || {};
const lapApi = lap.api || "openai-responses";
const cat = new Map();
for (const m of readJson(path.join(here, "../docker/world/nv-inference-models.json"))?.models || []) cat.set(m.id, { ...m, api: m.api || "openai-responses" });
for (const m of lap.models || []) cat.set(m.id, { ...m, api: m.api || lapApi });
for (const [id, d] of Object.entries(cfg.details || {})) cat.set(id, { id, ...(cat.get(id) || {}), ...d });

let ids;
if (cfg.preset === "short" || cfg.preset === "claude3gpt3") ids = list(cfg.preset);
else if (cfg.preset === "custom") ids = list("custom");
else if (cfg.preset === "laptop") {
  const scoped = (readJson(path.join(PI, "settings.json"))?.enabledModels || []).map(String);
  // (review) pi's own scope resolver, so the box gets exactly what pi on this laptop scopes (its patterns, braces, case, suffixes);
  // from the client packages `world X open` keeps (~/.cache/hyprpi-remote); the approximation below only if they aren't there
  const lapModels = (lap.models || []).map((m) => ({ ...m, provider: "nv-inference", api: m.api || lapApi, baseUrl: lap.baseUrl }));
  const deps = process.env.HYPRPI_REMOTE_DEPS || path.join(os.homedir(), ".cache/hyprpi-remote");
  const mr = path.join(deps, "node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js");
  let piScope = null; try { piScope = (await import(mr)).resolveModelScopeFromModels; } catch { /* not installed */ }
  if (piScope) ids = [...new Set(piScope(scoped, lapModels).scopedModels.map((x) => x.model.id))];
  else die(`preset "laptop" needs pi's model resolver at ${mr} (run \`omnistation/world X open\` once, which installs it); nothing resolved`); // (review) no approximate list
} else die(`"preset" must be short, claude3gpt3, laptop or custom (it is ${JSON.stringify(cfg.preset)})`);
const def = String(cfg.default || ids[0] || "");
ids = [...new Set([def, ...ids, ...list("add")])].filter((id) => id && !list("exclude").includes(id));
const denied = [];
ids = ids.filter((id) => { const d = (cfg.deny || []).find((x) => glob(x.pattern).test(id.toLowerCase())); if (d) denied.push({ id, why: d.why || d.pattern }); return !d; });
if (!ids.includes(def)) die(`the default ${def} is excluded or denied`);
const missing = ids.filter((id) => !cat.has(id) || !cat.get(id).api || !(cat.get(id).contextWindow > 0));
if (missing.length) die(`no details for ${missing.join(", ")}: add them under "details" in ${cfgFile}`);
const models = ids.map((id) => { const m = cat.get(id); const e = { id, name: m.name || `${id.split("/").pop()} (Inference Hub)`, api: m.api, reasoning: !!m.reasoning, input: m.input || ["text", "image"], contextWindow: m.contextWindow, maxTokens: m.maxTokens || 32000 }; if (m.thinkingLevelMap) e.thinkingLevelMap = m.thinkingLevelMap; return e; });
if (args.includes("--show")) {
  console.log(`preset ${cfg.preset}: ${models.length} models, default ${def}`);
  for (const m of models) console.log(`  ${m.id}  (${m.api.replace("openai-", "")}, ${m.contextWindow} ctx)`);
  for (const d of denied) console.log(`  denied: ${d.id} (${d.why})`);
} else console.log(JSON.stringify({ default: def, models, denied }));
