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

export function createModelCheck({ stateDir, pi = "pi", log = () => {}, knownGood = () => [], okTtl = 3600e3, badTtl = 600e3, timeoutMs = 90e3, env = process.env, runner = null } = {}) {
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
    if (c && Date.now() - c.at < (c.ok ? okTtl : badTtl)) return { ok: c.ok, error: c.error, model, cached: new Date(c.at).toISOString() };
    if (!inflight.has(model)) inflight.set(model, run(model).then((r) => {
      cache[model] = { ok: !!r.ok, error: r.ok ? undefined : r.error, at: Date.now() }; save();
      log(`model check: ${model} ${r.ok ? "works" : "FAILED: " + String(r.error).slice(0, 160)}`);
      return r;
    }).finally(() => inflight.delete(model)));
    const r = await inflight.get(model);
    return { ok: !!r.ok, error: r.error, model };
  }
  return { check, cache: () => cache };
}

// A short readable reason from pi's error ("404: {json}") and the refusal text.
export function refusal(model, error, suggestion) {
  let why = String(error || "it doesn't answer");
  const m = /"message":"([^"]+)/.exec(why); if (m) why = m[1].split("\\n")[0];
  return `the model ${model} can't run here (${why.slice(0, 220)}), so no agent was started on it. Use ${suggestion} instead (it works), or another model that answers \`pi -p --model <id> "ok"\`.`;
}
