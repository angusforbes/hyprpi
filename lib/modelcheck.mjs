// J383 (after J374: OpenRoute hand-picked openrouter/~google/gemini-pro-latest, which the account's
// OpenRouter guardrails block, and its reviewer died on its first turn): before an agent is started or
// switched onto an EXPLICITLY chosen model, one cheap call (`pi -p … "Reply with just: ok"`, no tools, no
// extensions, thinking off) checks that it runs. Results are cached in STATE/model-checks.json: a working
// model for okTtl (1 h), a failing one for badTtl (10 min). Models the routing config names (ladder, kinds)
// count as known-good and aren't called. A refusal names a working alternative.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const THINK = /:(off|minimal|low|medium|high|xhigh|max)$/;
export const bareModel = (m) => String(m || "").trim().replace(THINK, "");

export function createModelCheck({ stateDir, pi = "pi", log = () => {}, knownGood = () => [], okTtl = 3600e3, badTtl = 600e3, transientTtl = 60e3, timeoutMs = 90e3, env = process.env, runner = null } = {}) {
  const file = path.join(stateDir, "model-checks.json");
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { /* none yet */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* best effort */ } };
  const inflight = new Map();
  // -> { ok, error }
  const run = runner || ((model) => new Promise((resolve) => {
    const e = { ...env }; for (const k of Object.keys(e)) if (/^(HYPRPI_AGENT_ID|PI_SESSION)/.test(k)) delete e[k];
    let out = "", err = "", done = false;
    const c = spawn(env.HYPRPI_MODELCHECK_PI || pi, ["-p", "--no-session", "-nt", "-ne", "-ns", "-np", "-nc", "--thinking", "off", "--model", model, "Reply with just: ok"], { env: e, cwd: env.HOME || "/", stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => { if (!done) { done = true; c.kill("SIGKILL"); resolve({ ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)} s` }); } }, timeoutMs);
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err += d; });
    c.on("error", (x) => { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, error: x.message }); } });
    c.on("close", (code) => {
      if (done) return; done = true; clearTimeout(t);
      const msg = (err.trim().split("\n").filter((l) => !/^Warning:/.test(l)).pop() || out.trim().split("\n").pop() || "").slice(0, 2000);
      resolve(code === 0 && out.trim() ? { ok: true } : { ok: false, error: msg || `exit ${code}` });
    });
  }));
  async function check(m) {
    const model = bareModel(m);
    if (!model) return { ok: true, model, skipped: "no model" };
    if (knownGood().map(bareModel).includes(model)) return { ok: true, model, cached: "routing config" };
    const c = cache[model];
    if (c && Date.now() - c.at < (c.ok ? okTtl : c.transient ? transientTtl : badTtl)) return { ok: c.ok, error: c.error, transient: !!c.transient, model, cached: new Date(c.at).toISOString() };
    if (!inflight.has(model)) inflight.set(model, run(model).then((r) => {
      // ModelCheckReview: only a DEFINITE refusal (unknown model, auth, guardrail / policy, 4xx) is remembered
      // for badTtl; a rate limit, timeout or network blip is retried after a minute.
      const definite = !r.ok && isDefinite(r.error);
      cache[model] = { ok: !!r.ok, error: r.ok ? undefined : r.error, transient: !r.ok && !definite, at: Date.now() }; save();
      log(`model check: ${model} ${r.ok ? "works" : "FAILED: " + String(r.error).slice(0, 160)}`);
      return r;
    }).finally(() => inflight.delete(model)));
    const r = await inflight.get(model);
    return { ok: !!r.ok, error: r.error, transient: !r.ok && !isDefinite(r.error), model };
  }
  return { check, cache: () => cache };
}

// A failure that says the model can't be used (vs a rate limit, timeout or network error).
export function isDefinite(error) {
  const e = String(error || "");
  if (/\b(429|rate.?limit|timed? ?out|no answer within|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|50[0-4]\b|overloaded)/i.test(e)) return false;
  return /\b(40[0-4]|not found|guardrail|data policy|unauthori[sz]ed|forbidden|invalid api key|no models match|not available)\b/i.test(e);
}

// A short readable reason from pi's error ("404: {json}") and the refusal text.
// The probe runs pi with no extensions or project config (from $HOME): a provider that only an extension or a
// project's own config registers would fail here though the agent could use it (ModelCheckReview); such
// setups can turn the check off (HYPRPI_MODELCHECK=0 or hyprpi config modelCheck: false).
export function refusal(model, error, suggestion, transient = false) {
  let why = String(error || "it doesn't answer");
  const m = /"message":"([^"]+)/.exec(why); if (m) why = m[1].split("\\n")[0];
  const head = transient ? `the model ${model} couldn't be verified just now (${why.slice(0, 220)}; maybe temporary: try again in a minute)` : `the model ${model} can't run here (${why.slice(0, 220)})`;
  return `${head}, so it wasn't used. Use ${suggestion} instead (the configured alternative), or another model that answers \`pi -p --model <id> "ok"\`.`;
}
