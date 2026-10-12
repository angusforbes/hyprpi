#!/usr/bin/env node
// lib/nv-models.mjs: applies a resolved model list (lib/models-resolve.mjs's output) to one machine's pi and hyprpi (J499, J500).
// Self-contained (node only), so `world X setup` can copy this one file to a remote machine and run it there:
//   node nv-models.mjs --models FILE [--check] [--key-file PATH|none]
// It sets provider "nv-inference" (NVIDIA Inference Hub) in ~/.pi/agent/models.json to the listed models (other providers kept;
// an apiKey the provider already has is kept, else it reads the key file at request time by a !command, never copied or printed),
// makes the list's default pi's default (settings.json), rewrites the explicit nv-inference entries of an existing enabledModels
// (other providers and nv-inference globs are kept; with "nv-inference/**" nothing is added), and sets hyprpi's thoughtsModel
// (the list's "thoughts", else nv-inference/<default>) unless HYPRPI_REMOTE_THOUGHTS_MODEL names another. Idempotent: a file is
// written only when its content changes; a broken file stops the run before anything is written.
//   --key-file: default ~/workspace/.secrets/nv_inference_key (a Brev box's own key); world H's is ~/.config/hyprpi-secrets/…;
//               "none" = the key is in pi's auth.json (the sandbox): no key file, no apiKey.
//   --check:    ask the API which models the key reaches and leave the others out (needs a key file).
// No key file: it says so and changes nothing (exit 0), e.g. a box where the key hasn't been put yet.
// docker/world/pi-models.mjs uses applyModels() on a sandbox's files the same way.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
export const BASE = "https://inference-api.nvidia.com/v1";
const shq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'"; // a path in the !command is shell-quoted

// pure: { models, settings, config|null } + resolved -> the new objects and what changed; keyCmd: the apiKey to set when the provider
// has none (null = set none)
export function applyModels({ models: mj0 = {}, settings: sj0 = {}, config: cj0 = null }, resolved, { keyCmd = null, thoughtsOverride = "" } = {}) {
  const ok = (m) => m && typeof m.id === "string" && /^openai-(completions|responses)$/.test(m.api || "") && Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0 && (m.maxTokens === undefined || (Number.isSafeInteger(m.maxTokens) && m.maxTokens > 0));
  const models = (resolved.models || []).filter(ok);
  if (!models.length) throw new Error("no usable models in the list");
  const def = models.some((m) => m.id === resolved.default) ? resolved.default : models[0].id;
  const mj = structuredClone(mj0), sj = structuredClone(sj0), cj = cj0 && structuredClone(cj0);
  if (mj.providers != null && (typeof mj.providers !== "object" || Array.isArray(mj.providers))) throw new Error("models.json's providers isn't an object");
  mj.providers ||= {};
  const old = mj.providers["nv-inference"] || {};
  const p = { ...old, baseUrl: BASE, api: "openai-responses" };
  if (!old.apiKey && keyCmd) p.apiKey = keyCmd; else if (!old.apiKey) delete p.apiKey;
  p.models = models.map((m) => { if (m.api !== p.api) return m; const { api, ...rest } = m; return rest; }); // a model's api only where it differs from the provider's (as pi's own files have it)
  mj.providers["nv-inference"] = p;
  sj.defaultProvider = "nv-inference"; sj.defaultModel = def;
  if (Array.isArray(sj.enabledModels)) {
    const isGlob = (e) => /[*?[{]/.test(e);
    const kept = sj.enabledModels.filter((e) => !String(e).startsWith("nv-inference/") || isGlob(String(e)));
    sj.enabledModels = kept.includes("nv-inference/**") ? kept : [...kept, ...models.map((m) => `nv-inference/${m.id}`)];
  }
  if (cj && !thoughtsOverride) cj.thoughtsModel = resolved.thoughts || `nv-inference/${def}`;
  return { models: mj, settings: sj, config: cj, def, count: models.length };
}

const say = (s) => console.log(`nv-models: ${s}`);
async function cli(args) {
  const HOME = os.homedir();
  const modelsFile = args.includes("--models") ? args[args.indexOf("--models") + 1] : path.join(path.dirname(new URL(import.meta.url).pathname), "nv-models.json");
  let kf = args.includes("--key-file") ? args[args.indexOf("--key-file") + 1] : "~/workspace/.secrets/nv_inference_key";
  const keyless = kf === "none";
  const KEYF = keyless ? "" : kf.replace(/^~(?=\/)/, HOME);
  let key = "";
  if (!keyless) {
    if (!fs.existsSync(KEYF)) { say(`no key at ${KEYF}: nv-inference models not set up (nothing changed). Put a dedicated Inference Hub key (sk-…) there yourself: 600 in a 700 folder.`); process.exit(0); }
    const mode = (p) => fs.statSync(p).mode & 0o777;
    if (mode(KEYF) & 0o077 || mode(path.dirname(KEYF)) & 0o077) { say(`${KEYF} must be 600 in a 700 folder (chmod 600 it, chmod 700 its folder); nothing changed`); process.exit(2); }
    key = fs.readFileSync(KEYF, "utf8").replace(/[\r\n]/g, "");
    if (key.startsWith("nvapi-")) { say("the key is a build.nvidia.com key (nvapi-…); the Inference Hub needs an sk-… key: nothing changed"); process.exit(2); }
  } else if (args.includes("--check")) { say("--check needs a key file; nothing changed"); process.exit(2); }

  let resolved; try { resolved = JSON.parse(fs.readFileSync(modelsFile, "utf8")); } catch (e) { say(`can't read the model list ${modelsFile} (${e.message}); nothing changed`); process.exit(2); }
  if (args.includes("--check")) {
    try {
      const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { say(`the key was refused by ${BASE} (HTTP ${r.status}): nothing changed`); process.exit(3); }
      const have = new Set(((await r.json()).data || []).map((m) => m.id));
      const gone = (resolved.models || []).filter((m) => !have.has(m.id)).map((m) => m.id);
      if (gone.length) say(`the key can't reach ${gone.join(", ")}: left out`);
      resolved.models = (resolved.models || []).filter((m) => have.has(m.id));
      if (!resolved.models.length) { say("the key reaches none of the listed models: nothing changed"); process.exit(3); }
    } catch (e) { say(`couldn't check the key against ${BASE} (${e.name}); nothing changed (run without --check to set up unchecked)`); process.exit(3); }
  }

  const readJson = (f) => { // only a missing file counts as empty; a broken one stops everything before any write
    let t; try { t = fs.readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") return {}; say(`can't read ${f} (${e.code}); nothing changed`); process.exit(2); }
    try { const j = JSON.parse(t); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch { /* below */ }
    say(`${f} isn't a JSON object; fix or move it, nothing changed`); process.exit(2);
  };
  const agentDir = path.join(HOME, ".pi/agent");
  const hc = path.join(HOME, ".config/hyprpi/config.json"); // under HOME only, never XDG_CONFIG_HOME (a scratch-HOME test must not reach the real config)
  const files = { models: readJson(path.join(agentDir, "models.json")), settings: readJson(path.join(agentDir, "settings.json")), config: fs.existsSync(hc) ? readJson(hc) : null };
  let r; try { r = applyModels(files, resolved, { keyCmd: keyless ? null : `!tr -d '\\r\\n' < ${shq(KEYF)}`, thoughtsOverride: process.env.HYPRPI_REMOTE_THOUGHTS_MODEL || "" }); } catch (e) { say(`${e.message}; nothing changed`); process.exit(2); }
  fs.mkdirSync(agentDir, { recursive: true }); fs.chmodSync(agentDir, 0o700);
  const same = (file, obj) => { try { return JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) === JSON.stringify(obj); } catch { return false; } }; // same content (spacing aside) = left alone
  const write = (file, obj, mode) => { const text = JSON.stringify(obj, null, 2) + "\n"; if (fs.existsSync(file) && same(file, obj)) return false; fs.writeFileSync(file, text, { mode }); if (mode) fs.chmodSync(file, mode); return true; };
  const c1 = write(path.join(agentDir, "models.json"), r.models, 0o600);
  const c2 = write(path.join(agentDir, "settings.json"), r.settings, 0o600);
  const c3 = r.config ? write(hc, r.config) : false;
  say(`${r.count} models; default nv-inference/${r.def}; ` + (c1 || c2 || c3 ? `updated ${[c1 && "models.json", c2 && "settings.json", c3 && "thoughtsModel"].filter(Boolean).join(", ")} (agents already running see it after a restart)` : "unchanged"));
}
// (J512) run as a script, also when called through a link (a Brev box's ~/.hyprpi-i is a link into ~/workspace: import.meta.url is the real path)
const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url)); } catch { return false; } };
if (isMain()) await cli(process.argv.slice(2));
