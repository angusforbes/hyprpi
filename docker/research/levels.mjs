// J380 v3 (Angus: "the host sets available permission levels"): ONE host-side file says which modes and options a world may use AT ALL.
// ~/.config/hyprpi/gateway-levels.json (only the owner edits it, `doorman config levels set`, from a real terminal):
//   { "modes": ["strict", "safe", "open"],      // modes a world may be set to (default: all four, yolo included; list only the ones you want)
//     "max_share_level": "open",                // the widest share level (strict < safe < open)
//     "phone_decisions": false,                 // may a world turn on decisions from the phone?
//     "runner_harnesses": ["claude-code"] }     // host agents the per-job runner may start
// Absent file = these defaults. A world's settings are checked against it everywhere they are set (the admin command, a proposal from a
// host agent or a sandbox: refused, not held) and the mode actually used is clamped to it (a hand-edited worlds file can't exceed it).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ALL_MODES = ["strict", "safe", "open", "yolo"], SHARE = ["strict", "safe", "open"];
// No file = what the gateway allowed before this file existed: everything.
export const DEFAULT_LEVELS = Object.freeze({ modes: ["strict", "safe", "open", "yolo"], max_share_level: "open", phone_decisions: true, runner_harnesses: ["claude-code", "codex", "pi"] });
export const levelsFile = (cfgDir) => path.join(cfgDir || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hyprpi"), "gateway-levels.json");
const NAME = /^[a-z0-9][a-z0-9_-]{0,29}$/;

// -> { levels, error } (a broken file fails CLOSED: the strictest levels, and the error is shown)
export function loadLevels(cfgDir) {
  const strictest = { modes: ["strict"], max_share_level: "strict", phone_decisions: false, runner_harnesses: [] };
  let text; try { text = fs.readFileSync(levelsFile(cfgDir), "utf8"); } catch (e) { return e.code === "ENOENT" ? { levels: { ...DEFAULT_LEVELS, modes: [...DEFAULT_LEVELS.modes], runner_harnesses: [...DEFAULT_LEVELS.runner_harnesses] }, error: "", file: false } : { levels: strictest, error: `can't read ${levelsFile(cfgDir)}: ${e.message}`, file: true }; }
  let j; try { j = JSON.parse(text); } catch (e) { return { levels: strictest, error: `${levelsFile(cfgDir)} doesn't parse (${e.message}): using the strictest levels`, file: true }; }
  const v = validateLevels(j); if (v.errors.length) return { levels: strictest, error: `${levelsFile(cfgDir)}: ${v.errors.join("; ")}: using the strictest levels`, file: true };
  return { levels: v.levels, error: "", file: true };
}
export function validateLevels(j) {
  const errors = []; if (!j || typeof j !== "object" || Array.isArray(j)) return { errors: ["must be an object"], levels: null };
  const out = { ...DEFAULT_LEVELS, modes: [...DEFAULT_LEVELS.modes], runner_harnesses: [...DEFAULT_LEVELS.runner_harnesses] };
  for (const k of Object.keys(j)) if (!Object.hasOwn(DEFAULT_LEVELS, k)) errors.push(`unknown key ${JSON.stringify(k).slice(0, 30)}`);
  if (j.modes !== undefined) { if (!Array.isArray(j.modes) || !j.modes.length || !j.modes.every((m) => ALL_MODES.includes(m))) errors.push(`modes must be a non-empty list of ${ALL_MODES.join(", ")}`); else out.modes = [...new Set(j.modes)]; }
  if (j.max_share_level !== undefined) { if (!SHARE.includes(j.max_share_level)) errors.push(`max_share_level must be one of ${SHARE.join(", ")}`); else out.max_share_level = j.max_share_level; }
  if (j.phone_decisions !== undefined) { if (typeof j.phone_decisions !== "boolean") errors.push("phone_decisions must be true or false"); else out.phone_decisions = j.phone_decisions; }
  if (j.runner_harnesses !== undefined) { if (!Array.isArray(j.runner_harnesses) || !j.runner_harnesses.every((h) => typeof h === "string" && NAME.test(h))) errors.push("runner_harnesses must be a list of names"); else out.runner_harnesses = [...new Set(j.runner_harnesses)]; }
  return { errors, levels: out };
}
export const shareOfMode = (m) => (m === "strict" ? "strict" : m === "safe" ? "safe" : "open"); // the share level a mode implies (mode.mjs levelOfMode)
const shareOk = (levels, share) => SHARE.indexOf(share) <= SHARE.indexOf(levels.max_share_level);
// the modes a world may really use: listed AND not implying a share level wider than the host's cap
export const usableModes = (levels) => levels.modes.filter((m) => shareOk(levels, shareOfMode(m)));
const strictestMode = (levels) => ALL_MODES.find((m) => levels.modes.includes(m)) || "strict";
// is this value allowed? -> "" or the reason (key: mode | level | phone_decisions | runner.harness)
// the harness a host_runner value names: "claude-code" | "codex" | "pi", or { harness, command, model } (OpenRoute J425: gateway.host_runner)
export const harnessOf = (v) => String(v && typeof v === "object" ? v.harness : v ?? "");
// may the runner start this harness on this host? (the runner calls this and fails closed)
export const allowedHarness = (levels, harness) => !!harness && levels.runner_harnesses.includes(String(harness));
export function checkValue(levels, key, value) {
  const v = String(value);
  if (key === "mode") return usableModes(levels).includes(v) ? "" : levels.modes.includes(v) ? `mode ${v} would share more than this host allows (share level ${shareOfMode(v)}, at most ${levels.max_share_level})` : `mode ${v} isn't allowed on this host (allowed: ${levels.modes.join(", ")})`;
  if (key === "level") return SHARE.indexOf(v) <= SHARE.indexOf(levels.max_share_level) ? "" : `share level ${v} is wider than this host allows (at most ${levels.max_share_level})`;
  if (key === "phone_decisions") return /^(on|true)$/i.test(v) && !levels.phone_decisions ? "decisions from the phone aren't allowed on this host" : "";
  if (key === "host_runner") { const h = harnessOf(value); return levels.runner_harnesses.includes(h) ? "" : `host runner ${h || "?"} isn't allowed on this host (allowed: ${levels.runner_harnesses.join(", ") || "none"})`; }
  if (false) return levels.runner_harnesses.includes(v) ? "" : `runner harness ${v} isn't allowed on this host (allowed: ${levels.runner_harnesses.join(", ") || "none"})`;
  return "";
}
// the mode actually used: the world's, or the widest allowed mode that is not wider than it (else the strictest allowed one)
export function clampMode(levels, mode) {
  const ok = usableModes(levels); if (ok.includes(mode)) return { mode, note: "" };
  if (!ok.length) return { mode: "strict", note: `the host's levels leave no usable mode: using strict` }; // nothing is allowed: fail closed
  const r = ALL_MODES.indexOf(mode), below = ALL_MODES.filter((m, i) => i < r && ok.includes(m));
  if (!below.length) return { mode, note: "" }; // stricter than anything allowed: a stricter mode is never widened (a fail-closed strict stays strict)
  return { mode: below.at(-1), note: `mode ${mode} isn't allowed by the host's levels (${ok.join(", ")}): using ${below.at(-1)}` };
}
// the share level actually used: the world's, capped by the host
export const capShare = (levels, level) => (shareOk(levels, level) ? level : levels.max_share_level);
// everything a world has that is outside the levels -> [reason]
export function violations(levels, eff) {
  const out = []; if (eff.mode !== undefined && !ALL_MODES.includes(String(eff.mode))) { /* not a mode: nothing to compare */ } for (const k of ["mode", "level", "phone_decisions", "host_runner"]) if (eff[k] !== undefined && eff[k] !== "") { const r = checkValue(levels, k, eff[k]); if (r) out.push(r); } return out;
}
export const describeLevels = (l) => [`modes a world may use: ${l.modes.join(", ")}`, `widest share level: ${l.max_share_level}`, `decisions from the phone: ${l.phone_decisions ? "may be turned on" : "not allowed"}`, `host agents the runner may start: ${l.runner_harnesses.join(", ") || "none"}`];

export function writeLevels(cfgDir, patch) {
  const cur = loadLevels(cfgDir); if (cur.error) throw new Error(cur.error + " (fix or remove the file first)");
  const v = validateLevels({ ...cur.levels, ...patch }); if (v.errors.length) throw new Error(v.errors.join("; "));
  const f = levelsFile(cfgDir); fs.mkdirSync(path.dirname(f), { recursive: true });
  let mode = 0o644; try { mode = fs.statSync(f).mode & 0o777; if (cur.file) fs.copyFileSync(f, `${f}.bak-${Date.now()}`); } catch { /* new file */ }
  fs.writeFileSync(f + ".tmp", JSON.stringify(v.levels, null, 2) + "\n", { mode }); fs.renameSync(f + ".tmp", f); return v.levels;
}
