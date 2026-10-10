// J423 (Angus: "for thr G wrld, the agents can still get their own icons, they'll just have the what at the end teh sane
// as the TUIs"): a sandboxed world's agent is drawn "<its icon> Name 🐳" on the host, like G's panels (">Agents G 🐳").
// Its icon comes from inside the sandbox (g-status → world-helper), so it is UNTRUSTED: iconOk() lets through one emoji
// grapheme and nothing else (no text, controls or escapes). An agent with no (valid) icon gets a steady default from its
// name (the same name, the same animal), never the whale: 🐳 is the sandbox mark at the end.
const POOL = ["🦊", "🦉", "🐙", "🦋", "🐢", "🦔", "🐝", "🦎", "🐬", "🦜", "🐞", "🦀", "🐿️", "🦩", "🐧", "🦦"];
// A well-formed emoji: a pictograph (optional VS16, at most one skin tone), joined by ZWJ to at most 3 more such parts;
// or a flag (exactly two regional indicators). No lone indicator, trailing ZWJ or stacked modifiers (J423check).
const PART = "\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?";
const EMOJI_RE = new RegExp(`^(?:${PART}(?:\\u200D${PART}){0,3}|\\p{Regional_Indicator}{2})$`, "u");
export function iconOk(s) {
  if (typeof s !== "string" || !s || s.length > 16 || !EMOJI_RE.test(s)) return false;
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length === 1;
}
export function defaultIcon(name) {
  let h = 0; for (const ch of String(name || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return POOL[h % POOL.length];
}
// The icon to draw for a sandboxed agent: its own when valid and not the whale, else the default for its name.
export const sbxIcon = (icon, name) => (iconOk(icon) && !/^🐳|^🐋/u.test(icon) ? icon : defaultIcon(name));
