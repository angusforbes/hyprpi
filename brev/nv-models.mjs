#!/usr/bin/env node
// brev/nv-models.mjs [--check] [--list FILE]: runs ON a Brev box (J499). Sets up provider "nv-inference" (NVIDIA Inference Hub) in
// pi's ~/.pi/agent/models.json from brev/nv-models.list, with the box's own dedicated key read at request time by a !command from
// ~/workspace/.secrets/nv_inference_key (never read into a file or printed here), and makes the list's "default" model pi's default
// (settings.json) and Thoughts' (hyprpi config.json thoughtsModel, unless HYPRPI_REMOTE_THOUGHTS_MODEL names another). Other
// providers (e.g. local-vllm) are kept. Idempotent: a file is written only when its content changes.
// --check: ask the API which models the key can reach (GET /v1/models) and leave out listed ones it can't (a narrower key).
// Exit 0 also when there is no key: it says so and changes nothing (e.g. world H, which has no Brev key).
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const HOME = os.homedir(), args = process.argv.slice(2);
const listFile = args.includes("--list") ? args[args.indexOf("--list") + 1] : path.join(path.dirname(new URL(import.meta.url).pathname), "nv-models.list");
const KEYF = path.join(HOME, "workspace/.secrets/nv_inference_key");
const BASE = "https://inference-api.nvidia.com/v1";
const say = (s) => console.log(`nv-models: ${s}`);

if (!fs.existsSync(KEYF)) { say(`no key at ${KEYF}: nv-inference models not set up (nothing changed). On a Brev box, put a dedicated Inference Hub key (sk-…) there yourself: 600 in a 700 folder.`); process.exit(0); }
const mode = (p) => fs.statSync(p).mode & 0o777;
if (mode(KEYF) & 0o077 || mode(path.dirname(KEYF)) & 0o077) { say(`${KEYF} must be 600 in a 700 folder (chmod 600 it, chmod 700 its folder); nothing changed`); process.exit(2); }
const key = fs.readFileSync(KEYF, "utf8").replace(/[\r\n]/g, "");
if (key.startsWith("nvapi-")) { say("the key is a build.nvidia.com key (nvapi-…); the Inference Hub needs an sk-… key: nothing changed"); process.exit(2); }

// the list
const rows = fs.readFileSync(listFile, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => l.split(/\s+/));
let models = [], def = null;
for (const [id, api, ctx, max, flag] of rows) {
  if (!id || !/^(completions|responses)$/.test(api || "") || !(+ctx > 0) || !(+max > 0)) { say(`skipping a bad line in ${listFile}: ${[id, api, ctx, max].join(" ")}`); continue; }
  models.push({ id, name: `${id.split("/").pop()} (Inference Hub)`, ...(api === "completions" ? { api: "openai-completions" } : {}), reasoning: api === "responses", input: ["text", "image"], contextWindow: +ctx, maxTokens: +max });
  if (flag === "default") def = id;
}
if (!models.length) { say(`no models in ${listFile}; nothing changed`); process.exit(2); }
def ||= models[0].id;

if (args.includes("--check")) {
  try {
    const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { say(`the key was refused by ${BASE} (HTTP ${r.status}): nothing changed`); process.exit(3); }
    const have = new Set(((await r.json()).data || []).map((m) => m.id));
    const gone = models.filter((m) => !have.has(m.id)).map((m) => m.id);
    if (gone.length) say(`the key can't reach ${gone.join(", ")}: left out`);
    models = models.filter((m) => have.has(m.id));
    if (!models.some((m) => m.id === def)) def = models[0]?.id;
    if (!models.length) { say("the key reaches none of the listed models: nothing changed"); process.exit(3); }
  } catch (e) { say(`couldn't reach ${BASE} (${e.name}); setting up without the check`); }
}

const writeIfChanged = (file, obj) => {
  const text = JSON.stringify(obj, null, 2) + "\n";
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (old === text) return false;
  fs.writeFileSync(file, text, { mode: 0o600 }); fs.chmodSync(file, 0o600); return true;
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };

const agentDir = path.join(HOME, ".pi/agent"); fs.mkdirSync(agentDir, { recursive: true }); fs.chmodSync(agentDir, 0o700);
const mj = readJson(path.join(agentDir, "models.json")); mj.providers ||= {};
mj.providers["nv-inference"] = { baseUrl: BASE, api: "openai-responses", apiKey: `!tr -d '\\r\\n' < ${KEYF}`, models };
const c1 = writeIfChanged(path.join(agentDir, "models.json"), mj);
const sj = readJson(path.join(agentDir, "settings.json")); sj.defaultProvider = "nv-inference"; sj.defaultModel = def;
const c2 = writeIfChanged(path.join(agentDir, "settings.json"), sj);
const hc = path.join(HOME, ".config/hyprpi/config.json"); // under HOME only, never XDG_CONFIG_HOME (a test with a scratch HOME must not reach the real config)
let c3 = false;
if (fs.existsSync(hc) && !process.env.HYPRPI_REMOTE_THOUGHTS_MODEL) { const cj = readJson(hc); cj.thoughtsModel = `nv-inference/${def}`; const t = JSON.stringify(cj, null, 2) + "\n"; if (fs.readFileSync(hc, "utf8") !== t) { fs.writeFileSync(hc, t); c3 = true; } }
say(`${models.length} models (${models.map((m) => m.id.split("/").pop()).join(", ")}); default nv-inference/${def}; ` +
  (c1 || c2 || c3 ? `updated ${[c1 && "models.json", c2 && "settings.json", c3 && "thoughtsModel"].filter(Boolean).join(", ")} (agents already running see it after a restart)` : "unchanged"));
