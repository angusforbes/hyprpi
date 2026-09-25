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

// The user's recent messages in a Pi session file (tail only).
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
