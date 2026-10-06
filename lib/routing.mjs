// J130 model routing over the policy's "routing" section (lib/policy.mjs, ~/.config/hyprpi/hyprpi.jsonc):
// the model for a job (explicit > kind > default) and one-step escalation up the ladder.
import { loadPolicy } from "./policy.mjs";

// "provider/id:thinking" -> { model, thinking }
export function splitSpec(spec) {
  const s = String(spec || "").trim(), m = s.match(/^(.*?):(off|minimal|low|medium|high|xhigh|max)$/);
  return m ? { model: m[1], thinking: m[2] } : { model: s, thinking: "" };
}

// The model for a job: explicit > complexity/kind > default. Returns { model, thinking, routed, step, why }.
export function routeModel({ model = "", thinking = "", complexity = "" } = {}, policy = loadPolicy()) {
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
  return { ...splitSpec(ladder[nxt]), step: nxt };
}
