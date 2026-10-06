// J125 pruning: the pure transform behind pi-extension/upkeep.ts (context hook). Older large images and big
// tool outputs leave the model's context as a stub with a file:// link; non-files are saved first.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const hm = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return "earlier"; } };
const fileUrl = (p) => "file://" + p.split("/").map(encodeURIComponent).join("/");


// Pure transform (exported for tests): returns new messages (originals untouched) and what was pruned.
export function pruneMessages(messages, S, { dir, seen = new Set() }) {
  const P = S.prune || {};
  const stats = { images: 0, outputs: 0, bytes: 0, newly: 0 };
  if (!P.enabled || !Array.isArray(messages) || !messages.length) return { messages, stats };
  const lastUser = messages.map((m) => m?.role).lastIndexOf("user");
  const lastTool = messages.map((m) => m?.role).lastIndexOf("toolResult");
  // A tool call's arguments by id (a read of a screenshot: its own path is the pointer).
  const args = new Map();
  for (const m of messages) if (m?.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b?.type === "toolCall") args.set(b.id, b.arguments || {});
  // Turn age: how many of Angus's messages come after message i.
  const userAfter = new Array(messages.length).fill(0);
  for (let i = messages.length - 2, n = messages[messages.length - 1]?.role === "user" ? 1 : 0; i >= 0; i--) { userAfter[i] = n; if (messages[i]?.role === "user") n++; }
  const save = (data, ext) => {
    const h = crypto.createHash("sha1").update(data).digest("hex").slice(0, 16);
    const f = path.join(dir, `${h}.${ext}`);
    try { if (!fs.existsSync(f)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, data); } } catch { return ""; }
    return f;
  };
  let keptImages = 0;
  const out = messages.slice();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content) || i === lastUser || i === lastTool || (m.role !== "user" && m.role !== "toolResult")) {
      // (protected: the current message and the latest tool result never count against keepImages)
      continue;
    }
    let changed = false;
    const content = m.content.map((b) => {
      if (b?.type === "image" && typeof b.data === "string") {
        const bytes = Math.floor(b.data.length * 0.75);
        if (bytes < (P.imageMinKB ?? 40) * 1024 || keptImages < (P.keepImages ?? 3)) { keptImages++; return b; }
        const a = m.role === "toolResult" ? args.get(m.toolCallId) : null;
        const own = a?.path && fs.existsSync(path.resolve(String(a.path))) ? path.resolve(String(a.path)) : "";
        const f = own || save(Buffer.from(b.data, "base64"), EXT[b.mimeType] || "img");
        if (!f) { keptImages++; return b; } // couldn't save: never drop it without a pointer
        const key = "i:" + f; if (!seen.has(key)) { seen.add(key); stats.newly++; }
        stats.images++; stats.bytes += bytes; changed = true;
        return { type: "text", text: `[image from ${hm(m.timestamp)} removed from context to save space; it's on disk: ${fileUrl(f)} (read that file to see it again)]` };
      }
      if (b?.type === "text" && m.role === "toolResult" && typeof b.text === "string" && b.text.length > (P.maxToolChars ?? 12000) && userAfter[i] >= (P.keepTurns ?? 6)) {
        const f = save(Buffer.from(b.text, "utf8"), "txt");
        if (!f) return b;
        const key = "t:" + f; if (!seen.has(key)) { seen.add(key); stats.newly++; }
        stats.outputs++; stats.bytes += b.text.length; changed = true;
        return { type: "text", text: `${b.text.slice(0, 600)}\n[… ${Math.round(b.text.length / 1000)}k characters of this ${m.toolName || "tool"} output removed from context to save space; the full output is on disk: ${fileUrl(f)} (read that file to see it again)]` };
      }
      return b;
    });
    if (changed) out[i] = { ...m, content };
  }
  return { messages: out, stats };
}

