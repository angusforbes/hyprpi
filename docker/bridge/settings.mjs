// The bridge's settings view and proposals (J371, the owner's rule: the bridge never changes settings; it may READ what's in
// effect and PROPOSE a change, which waits in the Doorman window for his approval; host code applies it). Both call
// the host's own commands (J372, Doorview): reading `research.mjs config --json`, proposing `sbx-relay.mjs
// propose-gateway`. Neither writes a config file; the proposal becomes a held item the owner decides.
// The commands: DOORMAN_SETTINGS_CMD / DOORMAN_PROPOSE_CMD (JSON arrays) override them for other hosts and tests.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const H = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cmd = (env, dflt) => { try { const a = JSON.parse(process.env[env] || "null"); if (Array.isArray(a) && a.length) return a.map(String); } catch { /* */ } return dflt; };
const SANDBOX_RE = /^[A-Za-z0-9._-]{1,60}$/;
const run = (argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  let j = null; try { j = JSON.parse(r.stdout || ""); } catch { /* */ }
  return { status: r.status, json: j, text: (r.stdout || r.stderr || "").trim().slice(0, 4000) };
};

export function settings(sandbox) {
  if (!SANDBOX_RE.test(String(sandbox))) return { ok: false, text: "bad sandbox name" };
  const r = run([...cmd("DOORMAN_SETTINGS_CMD", [process.execPath, path.join(H, "research", "research.mjs"), "config", "--json", "--sandbox"]), sandbox]);
  if (r.status !== 0 || !r.json) return { ok: false, text: `couldn't read the settings (exit ${r.status ?? "?"}); its output isn't shown, as it may hold host paths` }; // (FixReview)
  // (J379 red team) a secret-free view: no key file paths (or anything key/token/secret-like), only whether one is set
  const scrub = (v) => Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => (/key|token|secret|password|credential/i.test(k) ? [k, x ? "(set)" : "(not set)"] : [k, scrub(x)]))) : v;
  const view = scrub(r.json);
  return { ok: true, sandbox, settings: view, text: JSON.stringify(view, null, 1) };
}

// changes: { key: value } from the host's proposable list (the host validates; the bridge only passes it on)
export function propose(sandbox, changes, by = "host agent") {
  if (!SANDBOX_RE.test(String(sandbox))) return { ok: false, text: "bad sandbox name" };
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length) return { ok: false, text: "nothing to propose" };
  const r = run([...cmd("DOORMAN_PROPOSE_CMD", [process.execPath, path.join(H, "sbx-relay.mjs"), "propose-gateway"]), sandbox, "--by", String(by).slice(0, 60), "--changes", JSON.stringify(changes)]);
  if (r.json && typeof r.json.ok === "boolean") return { ok: r.json.ok, id: r.json.id, text: r.json.text || (r.json.ok ? "proposed; it waits for the owner's approval in the Doorman window" : "refused") };
  return { ok: false, text: `couldn't propose: ${r.text || "no output"}` };
}
