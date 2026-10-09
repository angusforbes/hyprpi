// The Doorman's research modes (J325, Angus): set per sandbox in ~/.config/hyprpi/worlds/<name>.json as
//   "doorman": { "mode": "doorman-safe" }
//
//   doorman-strict  Angus approves the Doorman's planned searches before anything is sent, then reviews the deliverable.
//   doorman-safe    (default) the Doorman writes the searches and vets the result; Angus reviews only the deliverable.
//   doorman-open    no human review: the Doorman writes and checks the searches and vets the deliverable, which goes
//                   straight into the sandbox labelled "external, not human-reviewed". Opt-in only. It does NOT meet
//                   NVIDIA ASR first principle #11 (human-gated trust promotion) or #4 (Rule of Three) for a sandbox
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
  if (m !== undefined) return { mode: DEFAULT_MODE, note: `unknown doorman.mode ${JSON.stringify(String(m)).slice(0, 40)}: using ${DEFAULT_MODE}` };
  if (w?.research?.strict === true) return { mode: "doorman-strict", note: 'deprecated "research": {"strict": true}: read as doorman-strict; set "doorman": {"mode": "doorman-strict"} instead' };
  return { mode: DEFAULT_MODE, note: "" };
}
