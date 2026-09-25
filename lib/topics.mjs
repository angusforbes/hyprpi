// Topic labels for the agent list, like herdr's $topic token
// (~/.config/herdr/scripts/herdr-model-info.py): from each agent's recent user
// messages, ask a small model for a 1-3 word noun label of the current subject.
// Re-summarised only when the latest user message changes.
import fs from "node:fs";
import { spawn } from "node:child_process";

const TAIL_BYTES = 256 * 1024;
const PROMPT =
  "You label a coding session with a very short topic for a sidebar.\n" +
  "Reply with ONLY the label: 1 or 2 words (never more than 3), Title Case, " +
  "NOUNS ONLY (no verbs, no gerunds), no punctuation, no quotes.\n" +
  "Name the CURRENT / most recent subject, not older ones.\n" +
  "Examples: WhatsApp | Prisma VPN | Bluetooth | Sidebar Topics | NIM Testing\n\n" +
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

function sanitize(s) {
  let line = String(s || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  line = line.replace(/^[\s"'`*_#-]+/, "").replace(/[\s"'`*_.]+$/, "");
  line = line.split(/\s+/).slice(0, 3).join(" ");
  if (line.length > 22) line = line.slice(0, 22).trimEnd();
  return line || null;
}

export function summarize(src, { pi = "pi", model = "claude-haiku-4-5", timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(HERDR_|HYPRPI_AGENT_ID|PI_SESSION)/.test(k)) delete env[k];
    let child;
    try {
      child = spawn(pi, ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
        "--no-prompt-templates", "--thinking", "off", "--system-prompt", "You output only a short noun topic label, nothing else.",
        "--model", model], { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch { return resolve(null); }
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? sanitize(out) : null); });
    child.stdin.end(PROMPT + src);
  });
}
