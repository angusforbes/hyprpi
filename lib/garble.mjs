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
export const prose = (s) => String(s || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/~~~[\s\S]*?(~~~|$)/g, " ").replace(/`[^`\n]*`/g, " ").replace(/^\s*>.*$/gm, " ")
  .replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”|「[^」\n]{0,300}」/g, " ");
// letters per script
export function scriptShare(s) {
  const n = {}; let tot = 0;
  for (const ch of String(s || "")) { if (!/\p{L}/u.test(ch)) continue; tot++; for (const [name, re] of SCRIPTS) if (re.test(ch)) { n[name] = (n[name] || 0) + 1; break; } }
  return { n, tot };
}
const TOKEN_SRC = String.raw`<\|[A-Za-z0-9_\-. ]{1,40}\|>|<｜[^｜\n]{1,40}｜>|\[\/?INST\]|\[unused\d+\]`;
// A mention of a token in a reply about tokenizers is fine; a LEAK is one at the very start of the reply or repeated
const leak = (p) => { const re = new RegExp(TOKEN_SRC, "g"), all = [...p.matchAll(re)]; if (!all.length) return ""; const first = all[0];
  return first.index <= p.length - p.trimStart().length + 2 || all.length >= 3 ? first[0] : ""; };
// languages a task can name in English, so a reply in that script is what was asked for
const LANGS = { chinese: "han", mandarin: "han", cantonese: "han", japanese: "kana", korean: "hangul", russian: "cyrillic", ukrainian: "cyrillic", bulgarian: "cyrillic", arabic: "arabic", persian: "arabic", farsi: "arabic", urdu: "arabic", hebrew: "hebrew", greek: "greek", hindi: "devanagari", nepali: "devanagari", marathi: "devanagari", thai: "thai" };
// the task's own words: the spawn wrapper ("[hyprpi · … spawned you]" header and "(How this works …)" footer) is English boilerplate, not the task
export const taskText = (s) => String(s || "").replace(/^\s*\[hyprpi ·[^\]\n]*\]\s*/, "").replace(/\n*\(How this works:[\s\S]*?(?:Never move Angus's focus\.\)|$)/g, "");
export function garbled(m, promptText = "") {
  const text = String(m?.text ?? ""), u = m?.usage || {};
  const used = Number(u.output || 0) + Number(u.input || 0) + Number(u.totalTokens || 0);
  if (m?.stopReason === "error" || m?.stopReason === "aborted") return ""; // an error has its own stall path
  if (!text.trim() && !m?.hasToolCall) return used > 0 ? "" : "an empty reply with no usage reported";
  const p = prose(text);
  const t = /special tokens?|\btokeni[sz]er|chat[- ]templates?|<\||\bBPE\b/i.test(taskText(promptText)) ? "" : leak(p); // a task about tokens may quote them
   if (t) return `a leaked template token (${t.slice(0, 20)})`;
  const { n, tot } = scriptShare(p);
  if (tot >= 30) {
    promptText = taskText(promptText); const asked = scriptShare(prose(promptText)); if (!asked.tot) { asked.n.latin = 1; asked.tot = 1; } // no prompt text known: assume Latin (English)
    const named = new Set(Object.entries(LANGS).filter(([w]) => new RegExp(`\\b${w}\\b`, "i").test(promptText)).map(([, sc]) => sc));
    const ask = (k) => (named.has(k) ? 1 : (asked.n[k] || 0) / asked.tot);
    const foreign = Object.entries(n).filter(([k]) => ask(k) < 0.05 && !(k === "han" && ask("kana") >= 0.05)).reduce((a, [, v]) => a + v, 0);
    if (foreign / tot > 0.5) return `mostly in a script the task doesn't use (${Math.round(100 * foreign / tot)}% of ${tot} letters)`;
    // word salad in an English-ish task: single words that glue Latin to Han/Cyrillic/etc. ("build习俗", "Sou要强"), far more than any real reply has
    if (ask("latin") >= 0.95) {
      const ws = p.split(/\s+/).filter(Boolean), mixed = ws.filter((w) => /\p{Script=Latin}/u.test(w) && /[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Greek}\p{Script=Devanagari}\p{Script=Thai}]/u.test(w)).length;
      if (mixed >= 8 && mixed / ws.length >= 0.02) return `${mixed} words glue Latin letters to another script`;
    }
    // word salad: many scripts at once
    const kinds = Object.entries(n).filter(([k, v]) => v / tot > 0.08 && !(k === "han" && n.kana) && ask(k) < 0.05).length;
    if (kinds >= 3) return `${kinds} different scripts mixed together`;
  }
  return "";
}

// J394: a spawned helper's first reply AFTER its spawn prompt, from its session file's text (jsonl). A fork's inherited history
// (before the spawn prompt) is not its reply. -> { text, hasToolCall, usage, stopReason, model, prompt } | null
export function firstReplyFromSession(jsonl) {
  let prompt = [], first = null;
  for (const l of String(jsonl || "").split("\n")) {
    if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; } const m = o?.message; if (!m) continue;
    const text = Array.isArray(m.content) ? m.content.filter((x) => x?.type === "text").map((x) => String(x.text || "")).join("") : String(m.content ?? "");
    if (m.role === "user" || m.role === "custom") { if (/^\s*\[hyprpi · .*spawned you \(spawn_agent\)/.test(text)) { prompt = [text]; first = null; } else if (prompt.length) prompt.push(text); }
    else if (m.role === "assistant" && prompt.length && !first) first = { text, hasToolCall: Array.isArray(m.content) && m.content.some((x) => x?.type === "toolCall"), usage: m.usage, stopReason: m.stopReason, model: m.model ? String(m.model) : "", prompt: prompt.join("\n") };
  }
  return first;
}
