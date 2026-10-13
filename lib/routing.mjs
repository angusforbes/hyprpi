// J130 model routing over the policy's "routing" section (lib/policy.mjs, ~/.config/hyprpi/hyprpi.jsonc):
// the model for a job (explicit > kind > default) and one-step escalation up the ladder.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { loadPolicy } from "./policy.mjs";
import { remoteHome } from "./remote-world.mjs";
import { readList } from "./modellist.mjs";

// J543 (parity: spawn_agent on a remote world's machine was refused: its routing ladder named anthropic/claude-sonnet-5-5 …, which
// that machine only has as nv-inference/azure/anthropic/claude-sonnet-5-5): ON A REMOTE MACHINE ONLY, a routed model that isn't on
// its scoped list (enabledModels) becomes the listed model with the same id (the last part), else the same family at another
// version (claude-haiku-4-5 -> …/claude-haiku-5-5). Anything else is left as it is (and refused as before). The laptop: unchanged.
// (The hub has no enabledModels at all: then the models of its own providers in ~/.pi/agent/models.json are the list.)
function machineModels() {
  try { const l = readList(); if (l.length) return l; } catch { /* below */ }
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const j = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
    return Object.entries(j.providers || {}).flatMap(([p, v]) => (v?.models || []).map((m) => m?.id ? `${p}/${m.id}` : "")).filter(Boolean);
  } catch { return []; }
}
export function localModel(model, list = machineModels()) {
  const m = String(model || ""); if (!m || !Array.isArray(list) || !list.length || list.includes(m)) return m;
  const exact = list.filter((x) => typeof x === "string" && !/[*?[]/.test(x));
  const seg = (x) => String(x).split("/").pop(), fam = (x) => seg(x).replace(/-\d+(?:[-.]\d+)*$/, "");
  return exact.find((x) => seg(x) === seg(m)) || exact.find((x) => fam(x) === fam(m) && fam(m) !== seg(m)) || m;
}

// "provider/id:thinking" -> { model, thinking }
export function splitSpec(spec) {
  const s = String(spec || "").trim(), m = s.match(/^(.*?):(off|minimal|low|medium|high|xhigh|max)$/);
  return m ? { model: m[1], thinking: m[2] } : { model: s, thinking: "" };
}

// The model for a job: explicit > complexity/kind > default. Returns { model, thinking, routed, step, why }.
export function routeModel(job = {}, policy = loadPolicy()) {
  const r = routeModel0(job, policy);
  return r.routed && remoteHome() ? { ...r, model: localModel(r.model) } : r; // J543: a remote machine's own names for the models
}
function routeModel0({ model = "", thinking = "", complexity = "" } = {}, policy) {
  const R = policy.routing || {}, ladder = R.ladder || [];
  if (model) return { model, thinking, routed: false, step: ladderStep(model, thinking, ladder), why: "explicit" };
  const kind = String(complexity || R.default || "ordinary").toLowerCase();
  let v = (R.kinds || {})[kind];
  if (v === undefined) v = (R.kinds || {})[R.default] ?? 1;
  const ceiling = Number.isInteger(R.ceiling) ? R.ceiling : ladder.length - 1;
  if (typeof v === "number") {
    const step = Math.max(0, Math.min(v, ceiling, ladder.length - 1));
    const s = splitSpec(ladder[step]);
    return { model: s.model, thinking: thinking || s.thinking, routed: true, step, why: kind };
  }
  const s = splitSpec(v);
  return { model: s.model, thinking: thinking || s.thinking, routed: true, step: ladderStep(s.model, s.thinking, ladder), why: kind };
}

// The ladder step of (model, thinking): an exact match, else the same model at another thinking; -1 if absent.
export function ladderStep(model, thinking, ladder) {
  const id = (x) => String(x || "").split("/").pop();
  let best = -1;
  ladder.forEach((spec, i) => { const s = splitSpec(spec); if (id(s.model) === id(model) && (!thinking || !s.thinking || s.thinking === thinking)) { if (best < 0 || s.thinking === thinking) best = i; } });
  if (best < 0) ladder.forEach((spec, i) => { if (best < 0 && id(splitSpec(spec).model) === id(model)) best = i; });
  return best;
}

// One step up from (model, thinking); null at the ceiling or off the ladder. ignoreCeiling only for an explicit ask.
export function nextStep(model, thinking, policy = loadPolicy(), { ignoreCeiling = false } = {}) {
  const R = policy.routing || {}, ladder = R.ladder || [];
  const ceiling = ignoreCeiling ? ladder.length - 1 : (Number.isInteger(R.ceiling) ? R.ceiling : ladder.length - 1);
  const cur = ladderStep(model, thinking, ladder);
  const nxt = cur < 0 ? -1 : cur + 1;
  if (nxt < 0 || nxt > ceiling || nxt >= ladder.length) return null;
  const s = splitSpec(ladder[nxt]);
  return { ...s, model: remoteHome() ? localModel(s.model) : s.model, step: nxt }; // J543
}
