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
// JSONC: drop // comments outside strings, and trailing commas
const jsonc = (t) => { let o = "", s = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (s) { o += c; if (c === "\\") o += t[++i]; else if (c === '"') s = false; } else if (c === '"') { s = true; o += c; } else if (c === "/" && t[i + 1] === "/") { while (i < t.length && t[i] !== "\n") i++; o += "\n"; } else o += c; } return JSON.parse(o.replace(/,(\s*[}\]])/g, "$1")); };
let cfg; try { cfg = jsonc(fs.readFileSync(cfgFile, "utf8")); } catch (e) { die(`can't read ${cfgFile}: ${e.message}`); }
const list = (k) => (Array.isArray(cfg[k]) ? cfg[k] : []).map(String);
const glob = (p) => new RegExp("^" + String(p).toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

// catalogs of known model details: the laptop's pi nv-inference provider, then the sandbox world's list, then "details"
const lap = readJson(path.join(PI, "models.json"))?.providers?.["nv-inference"] || {};
const lapApi = lap.api || "openai-responses";
const cat = new Map();
for (const m of readJson(path.join(here, "../docker/world/nv-inference-models.json"))?.models || []) cat.set(m.id, { ...m, api: m.api || "openai-responses" });
for (const m of lap.models || []) cat.set(m.id, { ...m, api: m.api || lapApi });
for (const [id, d] of Object.entries(cfg.details || {})) cat.set(id, { id, ...(cat.get(id) || {}), ...d });

let ids;
if (cfg.preset === "short") ids = list("short");
else if (cfg.preset === "custom") ids = list("custom");
else if (cfg.preset === "laptop") {
  const scoped = (readJson(path.join(PI, "settings.json"))?.enabledModels || []).map(String);
  const pats = scoped.filter((p) => p.startsWith("nv-inference/")).map((p) => glob(p.slice("nv-inference/".length)));
  ids = (lap.models || []).map((m) => m.id).filter((id) => pats.some((re) => re.test(id.toLowerCase())));
} else die(`"preset" must be short, laptop or custom (it is ${JSON.stringify(cfg.preset)})`);
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
