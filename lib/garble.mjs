// J392: is a model's reply garbled? (kimi-k3 passed a short "reply ok" preflight but answered a full agent prompt with word
// salad: a leaked "<|close|>", scripts nobody asked for, or nothing at all with no usage reported.) Pure, no I/O.
// garbled({ text, hasToolCall, usage, stopReason }, promptText) -> "" (fine) | a short reason.
// Kept deliberately narrow: code blocks, inline code and quoted text are ignored, a reply in a script the prompt itself
// uses (Chinese to a Chinese prompt, Japanese to a Japanese one) passes, and short replies are never judged on script.
const SCRIPTS = [
  ["latin", /\p{Script=Latin}/u], ["cyrillic", /\p{Script=Cyrillic}/u], ["greek", /\p{Script=Greek}/u], ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u], ["devanagari", /\p{Script=Devanagari}/u], ["thai", /\p{Script=Thai}/u], ["hangul", /\p{Script=Hangul}/u],
  ["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ["han", /\p{Script=Han}/u],
];
// text a person wrote: fenced and inline code, and quoted/blockquoted text, don't count
export const prose = (s) => String(s || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ").replace(/^\s*>.*$/gm, " ")
  .replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”|「[^」\n]{0,300}」/g, " ");
// letters per script
export function scriptShare(s) {
  const n = {}; let tot = 0;
  for (const ch of String(s || "")) { if (!/\p{L}/u.test(ch)) continue; tot++; for (const [name, re] of SCRIPTS) if (re.test(ch)) { n[name] = (n[name] || 0) + 1; break; } }
  return { n, tot };
}
const TOKEN = /<\|[A-Za-z0-9_\-. ]{1,40}\|>|<｜[^｜\n]{1,40}｜>|\[\/?INST\]|<\/?s>|\[unused\d+\]/;
export function garbled(m, promptText = "") {
  const text = String(m?.text ?? ""), u = m?.usage || {};
  const used = Number(u.output || 0) + Number(u.input || 0) + Number(u.totalTokens || 0);
  if (m?.stopReason === "error" || m?.stopReason === "aborted") return ""; // an error has its own stall path
  if (!text.trim() && !m?.hasToolCall) return used > 0 ? "" : "an empty reply with no usage reported";
  const p = prose(text);
  const t = TOKEN.exec(p); if (t) return `a leaked template token (${t[0].slice(0, 20)})`;
  const { n, tot } = scriptShare(p);
  if (tot >= 30) {
    const asked = scriptShare(prose(promptText)); if (!asked.tot) { asked.n.latin = 1; asked.tot = 1; } // no prompt text known: assume Latin (English)
    const ask = (k) => (asked.tot ? (asked.n[k] || 0) / asked.tot : 0);
    const foreign = Object.entries(n).filter(([k]) => ask(k) < 0.05 && !(k === "han" && ask("kana") >= 0.05)).reduce((a, [, v]) => a + v, 0);
    if (foreign / tot > 0.5) return `mostly in a script the task doesn't use (${Math.round(100 * foreign / tot)}% of ${tot} letters)`;
    // word salad in an English-ish task: single words that glue Latin to Han/Cyrillic/etc. ("build习俗", "Sou要强"), far more than any real reply has
    if (ask("latin") >= 0.95) {
      const ws = p.split(/\s+/).filter(Boolean), mixed = ws.filter((w) => /\p{Script=Latin}/u.test(w) && /[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Greek}\p{Script=Devanagari}\p{Script=Thai}]/u.test(w)).length;
      if (mixed >= 8 && mixed / ws.length >= 0.02) return `${mixed} words glue Latin letters to another script`;
    }
    // word salad: many scripts at once
    const kinds = Object.entries(n).filter(([k, v]) => v / tot > 0.08 && !(k === "han" && n.kana)).length;
    if (kinds >= 3) return `${kinds} different scripts mixed together`;
  }
  return "";
}
