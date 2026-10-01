// Topic labels for the agent list, like herdr's $topic token
// (~/.config/herdr/scripts/herdr-model-info.py): from each agent's recent user
// messages, ask a small model for a short phrase (default up to 5 words / 40
// characters: config topicWords / topicChars) naming the current subject.
// Re-summarised only when the latest user message changes.
import fs from "node:fs";
import { spawn } from "node:child_process";

const TAIL_BYTES = 256 * 1024;
const prompt = (words) =>
  "You label a coding session with a short topic for a sidebar.\n" +
  `Reply with ONLY the label: a short phrase of 2 to ${words} words, sentence case, ` +
  "no trailing punctuation, no quotes. Be specific about what is being done.\n" +
  "Name the CURRENT / most recent subject, not older ones.\n" +
  "Examples: WhatsApp login bug | Room TUI selection fixes | Prisma VPN setup | NIM image tests\n\n" +
  "Recent conversation:\n";

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

// The user's recent messages in a Pi session file (tail only). Also the requests that reach an
// agent through hyprpi (talk / demand / room questions: "custom_message" entries, customType
// hyprpi-talk / hyprpi-room), without their header and reply instructions: most agents' work now
// arrives that way, and with only user messages their topic froze for hours (Angus, 2026-09-30).
const HYPRPI_ASK = new Set(["hyprpi-talk", "hyprpi-room"]);
function askText(t) {
  return String(t || "").replace(/^\[hyprpi [^\]\n]*\]\n?/, "")
    .replace(/\n\n(?:Reply \(optional\)|\S+ is waiting for your answer|\(Answer in the room)[\s\S]*$/, "")
    .replace(/^\[Thoughts-[A-Z], (?:from|asking for) Angus\]\s*(?:Please do this:\n)?/, "").trim();
}
export function recentUserTexts(sessionPath) {
  let text = "";
  try {
    const fd = fs.openSync(sessionPath, "r");
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d?.type === "custom_message" && HYPRPI_ASK.has(d.customType)) { const t = askText(textOf(d.content)); if (t) out.push(t); continue; }
    if (d?.type !== "message" || d.message?.role !== "user") continue;
    const t = textOf(d.message.content).trim();
    if (t) out.push(t);
  }
  return out;
}

// { key, src } for an agent's session, or null when there is nothing to label.
export function topicInput(sessionPath) {
  const users = recentUserTexts(sessionPath);
  if (!users.length) return null;
  const recent = users.slice(-3).map((u) => u.slice(0, 300));
  return { key: users[users.length - 1].slice(0, 120), src: recent.join("\n---\n").slice(0, 1200) };
}

function sanitize(s, words, chars) {
  let line = String(s || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  line = line.replace(/^[\s"'`*_#-]+/, "").replace(/[\s"'`*_.]+$/, "");
  line = line.split(/\s+/).slice(0, words).join(" ");
  if (line.length > chars) line = line.slice(0, chars).replace(/\s+\S*$/, "").trimEnd() || line.slice(0, chars);
  return line || null;
}

export function summarize(src, { pi = "pi", model = "claude-haiku-4-5", timeoutMs = 60000, words = 5, chars = 40 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(HERDR_|HYPRPI_AGENT_ID|PI_SESSION)/.test(k)) delete env[k];
    let child;
    try {
      child = spawn(pi, ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
        "--no-prompt-templates", "--thinking", "off", "--system-prompt", "You output only a short topic label, nothing else.",
        "--model", model], { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch { return resolve(null); }
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? sanitize(out, words, chars) : null); });
    child.stdin.end(prompt(words) + src);
  });
}


// ---- "did" lines (Angus, 2026-09-30): one line per finished turn for the room stream -----------
// What the agent did in its last turn and how it ended, from the turn's tool calls and its final
// message (the session file's tail: everything after the last real user message).
const TOOL_SHORT = (name, a) => {
  const n = String(name || "").toLowerCase(), x = a || {};
  const clip = (t, k) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > k ? s.slice(0, k - 1) + "…" : s; };
  if (n === "bash") return "$ " + clip(String(x.command || "").split("\n")[0].replace(/^\s*cd\s+\S+\s*&&\s*/, ""), 120);
  if (["read", "edit", "write"].includes(n)) return `${n} ${clip(x.path, 80)}`;
  if (n === "room_post" || n === "talk" || n === "talk_reply" || n === "room_reply") return `${n}: ${clip(x.text || x.message, 160)}`;
  const first = Object.values(x).find((v) => typeof v === "string" && v.trim());
  return `${n}${first ? " " + clip(first, 80) : ""}`;
};
// Where a turn starts: Angus's message, or a talk / room / board message injected into the agent.
const isTurnStart = (r) => (r?.type === "message" && r.message?.role === "user") || (r?.type === "custom_message" && /^hyprpi-(?!ignore$)/.test(r.customType || "")); // an /ignore note starts no turn (N52)
export function turnInput(sessionPath) {
  // Read backwards (256 KB, then more, up to 8 MB) until the turn's start is in view: tool results
  // can make single lines huge.
  let recs = [], u = -1;
  try {
    const fd = fs.openSync(sessionPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      for (let want = TAIL_BYTES; ; want *= 4) {
        const start = Math.max(0, size - want), buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        recs = [];
        for (const line of buf.toString("utf8").split("\n")) { if (!line.trim()) continue; try { recs.push(JSON.parse(line)); } catch { /* partial */ } }
        u = -1; for (let i = recs.length - 1; i >= 0; i--) if (isTurnStart(recs[i])) { u = i; break; }
        if (u >= 0 || start === 0 || want >= 8 * 1024 * 1024) break;
      }
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  if (u < 0) return null;
  const r0 = recs[u];
  const ask = (r0.type === "custom_message" ? String(typeof r0.content === "string" ? r0.content : textOf(r0.content)) : textOf(r0.message.content)).trim();
  const tools = [], says = [];
  for (const r of recs.slice(u + 1)) {
    const m = r?.message;
    if (r?.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c?.type === "toolCall") { let a = c.arguments; if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } } tools.push(TOOL_SHORT(c.name, a)); }
      else if (c?.type === "text" && c.text?.trim()) says.push(c.text.trim());
    }
  }
  const final = says.length ? says[says.length - 1] : "";
  if (!tools.length && final.length < 40) return { key: ask.slice(0, 120) + "|" + final.slice(0, 60), trivial: true, src: "" };
  const src = `REQUEST (the user's last message):\n${ask.slice(0, 600)}\n\nTOOL CALLS (${tools.length}, in order):\n${(tools.length > 60 ? [...tools.slice(0, 25), `… ${tools.length - 50} more …`, ...tools.slice(-25)] : tools).join("\n").slice(0, 5000)}\n\nFINAL MESSAGE:\n${final.slice(0, 2500)}`;
  return { key: ask.slice(0, 120) + "|" + final.slice(0, 60) + "|" + tools.length, trivial: false, src };
}
const TURN_PROMPT =
  "You write ONE line for an activity feed: what a coding agent did in its last turn and how it ended.\n" +
  "Rules: at most 160 characters; plain text, no quotes, no markdown, no leading name; past tense, verbs first, semicolons between parts (e.g. \"made the room header one line; tested in a hidden pty; committed 161186f\").\n" +
  "Include commit hashes, file names and the key result when they matter; say so if it failed, was stopped, or is waiting on the user. Nothing it only looked at.\n" +
  "If it only answered a question, say what it answered (\"answered: …\"). Reply with ONLY the line.\n\n";
export function summarizeTurn(src, { pi = "pi", model = "claude-haiku-4-5", timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(HERDR_|HYPRPI_AGENT_ID|PI_SESSION)/.test(k)) delete env[k];
    let child;
    try {
      child = spawn(pi, ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
        "--no-prompt-templates", "--thinking", "off", "--system-prompt", "You output only one short activity line, nothing else.",
        "--model", model], { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch { return resolve(null); }
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return resolve(null);
      let line = String(out).split("\n").map((x) => x.trim()).find(Boolean) || "";
      line = line.replace(/^[\s"'`*_#-]+/, "").replace(/[\s"'`*_]+$/, "");
      resolve(line ? (line.length > 200 ? line.slice(0, 199) + "…" : line) : null);
    });
    child.stdin.end(TURN_PROMPT + src);
  });
}
