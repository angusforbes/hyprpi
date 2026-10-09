import fs from "node:fs";
import path from "node:path";
// The Doorman's research modes (J325, Angus): set per sandbox in ~/.config/hyprpi/worlds/<name>.json as
//   "doorman": { "mode": "doorman-safe" }
//
//   doorman-strict  Angus approves the Doorman's planned searches before anything is sent, then reviews the deliverable.
//   doorman-safe    (default) the Doorman writes the searches and vets the result; Angus reviews only the deliverable.
//   doorman-open    no human review: the Doorman writes and checks the searches and vets the deliverable, which goes
//                   straight into the sandbox labelled "external, not human-reviewed". Opt-in only. It does NOT meet
//                   the principles of human-gated trust promotion and the Rule of Three for a sandbox
//                   that holds internal data.
// The old J314 setting "research": { "strict": true } still means doorman-strict (deprecated).
// Anything else, or a missing setting, is doorman-safe: doorman-open is never reached without the exact setting.
export const MODES = ["doorman-strict", "doorman-safe", "doorman-open"];
export const DEFAULT_MODE = "doorman-safe";

export const MODE_TEXT = {
  "doorman-strict": "Angus approves the Doorman's searches before anything is sent, then reviews the result before it reaches you.",
  "doorman-safe": "the Doorman writes the searches from your request and vets the result; Angus reviews the result before it reaches you.",
  "doorman-open": "the Doorman writes the searches and vets the result, which comes straight to you WITHOUT human review: treat it as external, unreviewed data.",
};

// A worlds/<name>.json object (or null) → { mode, note } (note: why it isn't simply the configured value).
export function modeOf(w) {
  const m = w && typeof w === "object" ? w.doorman?.mode : undefined;
  if (typeof m === "string" && MODES.includes(m)) return { mode: m, note: "" };
  if (m !== undefined) { let shown = "?"; try { shown = String(JSON.stringify(m) ?? typeof m).slice(0, 40); } catch { /* */ } return { mode: DEFAULT_MODE, note: `unknown doorman.mode ${shown}: using ${DEFAULT_MODE}` }; }
  if (w?.research?.strict === true) return { mode: "doorman-strict", note: 'deprecated "research": {"strict": true}: read as doorman-strict; set "doorman": {"mode": "doorman-strict"} instead' };
  return { mode: DEFAULT_MODE, note: "" };
}

// The one resolver for a sandbox's mode (review J325 #1): every worlds/*.json naming the sandbox is read. Exactly one
// → its mode. None → the default. More than one (a stale copy, a backup) → ambiguous: fail closed to doorman-strict,
// never to whichever file sorts first.
export function modeForSandbox(cfgDir, sandbox) {
  const hits = [];
  let names = []; try { names = fs.readdirSync(path.join(cfgDir, "worlds")).filter((f) => f.endsWith(".json")).sort(); } catch { /* no folder */ }
  for (const f of names) { let w; try { w = JSON.parse(fs.readFileSync(path.join(cfgDir, "worlds", f), "utf8")); } catch { continue; } if (w && typeof w === "object" && (typeof w.sandbox === "string" ? w.sandbox : f.slice(0, -5)) === sandbox) hits.push({ f, w }); }
  if (hits.length > 1) return { mode: "doorman-strict", note: `ambiguous: ${hits.map((h) => h.f).join(", ")} all name ${sandbox}; using doorman-strict until only one does`, file: "" };
  if (!hits.length) return { mode: DEFAULT_MODE, note: "", file: "" };
  return { ...modeOf(hits[0].w), file: hits[0].f };
}
