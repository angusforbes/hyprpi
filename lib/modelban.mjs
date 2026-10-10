// J394: add one exact model id to hyprpi.jsonc "modelDeny" (J389), with a comment saying when, who and why.
// Text edit that keeps the file's own comments; a backup first, an atomic write, and the result is parsed back before it stays.
import fs from "node:fs";
import path from "node:path";
import { parseJsonc } from "./policy.mjs";
import { deniedBy } from "./modelcheck.mjs";

// the text with every comment blanked (same length), so a search can't match inside a comment; strings stay
const maskComments = (t) => { let o = "", i = 0, inStr = false; while (i < t.length) { const c = t[i], n = t[i + 1];
  if (inStr) { o += c; if (c === "\\") { o += n ?? ""; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
  if (c === '"') { inStr = true; o += c; i++; continue; }
  if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") { o += " "; i++; } continue; }
  if (c === "/" && n === "*") { while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) { o += t[i] === "\n" ? "\n" : " "; i++; } o += "  "; i += 2; continue; }
  o += c; i++; } return o; };
const oneLine = (s, n = 160) => String(s || "").replace(/\*\//g, "*\u2215").replace(/\s+/g, " ").trim().slice(0, n);
// -> { added: true, backup } | { added: false, already: "pattern" }; throws if it can't be done safely
export function banModel(file, model, { when = new Date(), helper = "", why = "", id = "J394" } = {}) {
  model = String(model || "").trim();
  if (!/^[\w.:@~-]+\/[\w.:@~\/-]{1,119}$/.test(model) || model.includes("*")) throw new Error(`not an exact provider/id model: ${JSON.stringify(model).slice(0, 80)} (a bare id would also block other providers' models of that name)`);
  file = fs.realpathSync(file); // a symlinked policy keeps its link
  const text = fs.readFileSync(file, "utf8"), cur = parseJsonc(text);
  const hit = deniedBy(model, cur.modelDeny || []); if (hit) return { added: false, already: hit };
  const iso = new Date(when).toISOString(), stamp = iso.slice(0, 16).replace("T", " ");
  const entry = `${JSON.stringify(model)} /* ${id} ${stamp}: banned automatically after a garbled first reply${helper ? ` (helper ${oneLine(helper, 40)})` : ""}${why ? `: ${oneLine(why, 120)}` : ""} */`;
  let out;
  const masked = maskComments(text), m = /"modelDeny"\s*:\s*\[/.exec(masked);
  if (m) { // the matching ]: skip strings and comments
    let i = m.index + m[0].length, inStr = false, close = -1, last = "[";
    for (; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; last = '"'; continue; }
      if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
      if (c === "]") { close = i; break; }
      if (!/\s/.test(c)) last = c;
    }
    if (close < 0) throw new Error("couldn't find the end of modelDeny");
    out = text.slice(0, close) + (last === "[" || last === "," ? "" : ",") + " " + entry + " " + text.slice(close);
  } else { // no list yet: add one right after the opening brace of the object
    const b = masked.indexOf("{"); if (b < 0) throw new Error("hyprpi.jsonc has no object");
    out = text.slice(0, b + 1) + `\n  "modelDeny": [${entry}],` + text.slice(b + 1);
  }
  const back = JSON.stringify(parseJsonc(out).modelDeny || []);
  if (!deniedBy(model, parseJsonc(out).modelDeny || []) || JSON.stringify((cur.modelDeny || []).concat([model])) !== back) throw new Error("the edited file didn't parse back as expected; nothing written");
  const backup = `${file}.bak-${id}-${iso.replace(/[-:.TZ]/g, "")}`; // to the millisecond: two bans never share a backup
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file + ".tmp", out); fs.renameSync(file + ".tmp", file);
  return { added: true, backup: path.basename(backup) };
}
