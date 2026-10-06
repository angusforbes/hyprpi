// An agent's session, for the phone's session page (J161). Sessions can be huge (one reached 221 MB),
// so this never reads a whole file: tail() reads backwards from an offset in 1 MB chunks until it has
// the last N turns, and since() reads forward from an offset (the live updates). Entries become small
// items for the page: the turn's input (Angus's prompt, a talk/demand, a brief), the agent's text,
// one line per tool call (with a short result), notes (interrupted, errors). Thinking is left out.
// Images: a read of an image file shows that file (the page uses /api/thumb + Fils); an inline image
// (pasted, a screenshot tool) is referenced by its line offset and served by image() on request.
import fs from "node:fs";

const CHUNK = 1 << 20;            // 1 MB per read
const MAX_READ = 24 << 20;        // never read more than this for one request
const MAX_LINE = 6 << 20;         // a longer line (big inline images) is skipped, not parsed
const IMG_FILE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const one = (s, n = 90) => clip(String(s ?? "").replace(/\s+/g, " ").trim(), n);
const home = process.env.HOME || "";
const tilde = (p) => String(p || "").replace(home, "~");

// A turn starts with input from outside: a user message, or a displayed custom message from hyprpi.
function turnStart(e) {
  if (e.type === "message" && e.message?.role === "user") return true;
  if (e.type === "custom_message" && e.display !== false && !/^hyprpi-(talk-reply|note|activity)$/.test(e.customType || "")) return true;
  return false;
}
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("\n") : "";

// One tool call as one line ("read files.js", "ran git log …").
function toolLine(name, args = {}) {
  const n = String(name || "").toLowerCase(), a = args || {};
  if (n === "bash") return "ran " + one(String(a.command || "").split("\n")[0].replace(/^\s*cd\s+\S+\s*&&\s*/, ""), 80);
  if (n === "read") return "read " + tilde(a.path || a.file_path || "");
  if (n === "edit" || n === "multiedit") return "edited " + tilde(a.path || a.file_path || "");
  if (n === "write") return "wrote " + tilde(a.path || a.file_path || "");
  if (/^(grep|rg|find|ls|glob)$/.test(n)) return `${n} ${one(a.pattern || a.path || a.query || "", 60)}`;
  if (n === "talk" || n === "demand") return `${n} → ${(a.recipients || []).join(", ")}: ${one(a.message, 60)}`;
  if (n === "talk_reply" || n === "room_reply") return `replied: ${one(a.text, 70)}`;
  if (n === "room_post") return `posted: ${one(a.text, 70)}`;
  if (n === "board_update") return `board ${a.action || ""} ${a.project || ""} ${one(a.text || a.handle || "", 50)}`.trim();
  const first = Object.values(a).find((v) => typeof v === "string");
  return `${name} ${one(first || "", 70)}`.trim();
}

// One session line → items. `at` is the line's byte offset (for inline images).
function itemsOf(e, at) {
  const out = [], ts = Date.parse(e.timestamp || "") || 0;
  if (e.type === "message") {
    const m = e.message || {};
    if (m.role === "user") {
      const imgs = Array.isArray(m.content) ? m.content.map((c, i) => c.type === "image" ? { at, i } : null).filter(Boolean) : [];
      out.push({ k: "in", from: "Angus", text: clip(textOf(m.content), 6000), imgs, ts });
    } else if (m.role === "assistant") {
      for (const c of m.content || []) {
        if (c.type === "text" && c.text?.trim()) out.push({ k: "text", text: clip(c.text, 12000), ts });
        else if (c.type === "toolCall") {
          const args = c.arguments || {}, p = args.path || args.file_path;
          out.push({ k: "tool", id: c.id, name: c.name, line: toolLine(c.name, args), args: clip(JSON.stringify(args, null, 1), 1200), file: p && IMG_FILE.test(String(p)) ? String(p).replace(/^~/, home) : "", ts });
        }
      }
      if (m.stopReason === "aborted") out.push({ k: "note", text: "interrupted", ts });
      else if (m.stopReason === "error" || m.errorMessage) out.push({ k: "note", text: "✗ " + one(m.errorMessage || "error", 160), err: true, ts });
    } else if (m.role === "toolResult") {
      const imgs = (m.content || []).map((c, i) => c.type === "image" ? { at, i } : null).filter(Boolean);
      out.push({ k: "result", id: m.toolCallId, err: !!m.isError, text: clip(textOf(m.content), 900), imgs, ts });
    }
  } else if (e.type === "custom_message") {
    const t = String(e.content ?? textOf(e.content));
    const head = /^\[hyprpi (\w+) from ([^·\]\n]+)/.exec(t);
    if (turnStart(e)) out.push({ k: "in", from: head ? `${head[2].trim()} (${head[1]})` : e.customType === "hyprpi-prompt" ? "Angus" : (e.customType || "hyprpi"), text: clip(t, 6000), imgs: [], ts });
    else if (e.customType === "hyprpi-phone-cmd" || e.customType === "hyprpi-ignore") out.push({ k: "note", text: one(t, 200), ts }); // J163: a phone command's result; an /ignore signpost
    else if (e.customType === "hyprpi-talk-reply") out.push({ k: "in", from: head ? head[2].trim() + " (reply)" : "reply", text: clip(t, 4000), imgs: [], ts, reply: true });
  } else if (e.type === "compaction") out.push({ k: "note", text: "— earlier context compacted —", ts });
  return out;
}

// Parse lines [buf] that begin at byte `base`; returns [{ at, e }].
function parseLines(buf, base) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let nl = buf.indexOf(10, pos); if (nl < 0) nl = buf.length;
    const len = nl - pos;
    if (len > 1 && len <= MAX_LINE) { try { out.push({ at: base + pos, e: JSON.parse(buf.toString("utf8", pos, nl)) }); } catch { /* a partial or odd line */ } }
    else if (len > MAX_LINE) out.push({ at: base + pos, e: { type: "note-skip" } });
    pos = nl + 1;
  }
  return out;
}

// The last `turns` turns before byte `end` (default: the end of the file).
export function tail(file, { turns = 10, end = null } = {}) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let stop = end == null ? size : Math.min(Number(end) || 0, size);
    let start = stop, read = 0, lines = [], carry = Buffer.alloc(0);
    // Read backwards until we have `turns` turn starts (plus one more boundary) or hit the cap / file start.
    while (start > 0 && read < MAX_READ) {
      const n = Math.min(CHUNK, start); start -= n;
      const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, start); read += n;
      let buf = Buffer.concat([b, carry]);
      // keep the (possibly partial) first line for the next round, unless we're at the file start
      let firstNl = start > 0 ? buf.indexOf(10) : -1;
      if (start > 0 && firstNl < 0) { carry = buf; continue; } // one line longer than what we've read so far
      const body = start > 0 ? buf.subarray(firstNl + 1) : buf;
      carry = start > 0 ? buf.subarray(0, firstNl + 1) : Buffer.alloc(0);
      lines = parseLines(body, start + (start > 0 ? firstNl + 1 : 0)).concat(lines);
      if (lines.filter((l) => turnStart(l.e)).length > turns) break;
    }
    // Trim to the last `turns` turn starts.
    const starts = lines.map((l, i) => turnStart(l.e) ? i : -1).filter((i) => i >= 0);
    const from = starts.length > turns ? starts[starts.length - turns] : 0;
    const keep = lines.slice(from);
    const first = keep.length ? keep[0].at : stop;
    return { items: keep.flatMap((l) => itemsOf(l.e, l.at)), before: first, more: first > 0, end: stop, size, read };
  } finally { fs.closeSync(fd); }
}

// Everything after byte `after` (the live updates), at most MAX_READ; only whole lines.
export function since(file, after) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let from = Math.max(0, Math.min(Number(after) || 0, size));
    if (from >= size) return { items: [], end: size, size, read: 0 };
    const n = Math.min(size - from, MAX_READ), b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, from);
    const lastNl = b.lastIndexOf(10);
    if (lastNl < 0) return { items: [], end: from, size, read: n }; // a line still being written
    const lines = parseLines(b.subarray(0, lastNl + 1), from);
    return { items: lines.flatMap((l) => itemsOf(l.e, l.at)), end: from + lastNl + 1, size, read: n };
  } finally { fs.closeSync(fd); }
}

// An inline image: line at byte `at`, content index `i` → { mime, data: Buffer } or null.
export function image(file, at, i) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, pos = Number(at);
    if (!(pos >= 0 && pos < size)) return null;
    const n = Math.min(MAX_LINE + 1, size - pos), b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, pos);
    const nl = b.indexOf(10); const line = b.toString("utf8", 0, nl < 0 ? n : nl);
    const e = JSON.parse(line), c = (e.message?.content || e.content || [])[Number(i)];
    if (!c || c.type !== "image" || !/^image\/(png|jpe?g|gif|webp)$/.test(c.mimeType || "")) return null;
    return { mime: c.mimeType, data: Buffer.from(c.data, "base64") };
  } catch { return null; } finally { fs.closeSync(fd); }
}
