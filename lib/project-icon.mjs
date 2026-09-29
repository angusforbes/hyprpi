// An icon for a new project (Angus, 2026-09-29: "when we make a new hyprpi project, pick a good
// icon based on the name or the context"). Two steps, both used by the daemon when a project is
// created without one:
//   guessIcon(name, title)  instant: a keyword table over the name and title ("" = no match)
//   askIcon(name, title)    the topic model picks one emoji (a Promise; null on failure)
// The daemon sets the guess at once (so a card never waits for a model), then the model's pick,
// unless someone set an icon in between. Everything goes through projectIcon() (lib/board.mjs),
// so only a single safe emoji can land on a card.
import { spawn } from "node:child_process";
import { projectIcon } from "./board.mjs";

// Most specific first; matched on whole words (and word starts: "docker" in "dockerfile").
const KEYWORDS = [
  [/\b(docker|container|sandbox|podman)/, "🐳"],
  [/\b(poem|poetry|verse|dickinson)/, "🪶"],
  [/\b(board|kanban|cards?)\b/, "🗂️"],
  [/\b(key(board|bind|learn)?s?|typing|shortcut)/, "⌨️"],
  [/\b(usb|port|yubikey|hardware|device)/, "🔌"],
  [/\b(audio|sound|mic|speaker|dictation|voice|speech)/, "🔊"],
  [/\b(lip|mouth)/, "👄"],
  [/\b(webcam|camera|photo|video)/, "📷"],
  [/\b(fig(ure)?s?|plot|chart|graph|matlab|data)/, "📈"],
  [/\b(observ|watch|monitor|telemetry|metrics)/, "🔭"],
  [/\b(margin|archive|library|catalog|notes?)/, "📜"],
  [/\b(search|find|index)/, "🔎"],
  [/\b(mail|email|inbox|gmail)/, "✉️"],
  [/\b(calendar|schedule|meeting)/, "📅"],
  [/\b(music|song|midi)/, "🎵"],
  [/\b(game|play)/, "🎮"],
  [/\b(web|site|page|browser|html)/, "🌐"],
  [/\b(secur|auth|password|secret|crypt)/, "🔐"],
  [/\b(test|bench|experiment|trial)/, "🧪"],
  [/\b(doc|docs|readme|manual|guide|writ)/, "📚"],
  [/\b(agent|pi|hyprpi|bot|ai|model|llm)\b/, "🤖"],
  [/\b(bar|panel|tui|ui|window|desktop|hypr|omarchy|theme)/, "🖥️"],
  [/\b(build|fix|tool|script|config)/, "🔧"],
];

export function guessIcon(name, title = "") {
  const hay = `${String(name || "").replace(/[-_]+/g, " ")} ${title || ""}`.toLowerCase();
  for (const [re, icon] of KEYWORDS) if (re.test(hay)) return icon;
  return "";
}

// The first grapheme of the model's answer that passes projectIcon(), or null.
export function iconFrom(text) {
  for (const { segment } of new Intl.Segmenter().segment(String(text || ""))) {
    try { const v = projectIcon(segment); if (v) return v; } catch { /* not an emoji: next */ }
  }
  return null;
}

export function askIcon(name, title = "", { pi = "pi", model = "claude-haiku-4-5", timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(HERDR_|HYPRPI_AGENT_ID|PI_SESSION)/.test(k)) delete env[k];
    let child;
    try {
      child = spawn(pi, ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
        "--no-prompt-templates", "--thinking", "off", "--system-prompt", "You output exactly one emoji and nothing else.",
        "--model", model], { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch { return resolve(null); }
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? iconFrom(out) : null); });
    child.stdin.end("Pick ONE emoji that best represents this project, for a small icon next to its name "
      + "in a project list. Prefer a concrete, recognisable object over a generic one (not 📋, 📁, ✅ or ⭐).\n"
      + `Project: @${name}${title ? `\nWhat it is: ${title}` : ""}\nAnswer with the emoji only.`);
  });
}
