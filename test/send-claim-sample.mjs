// J704 W3: replay real recent sessions (read-only) through send-claim's assess(); prints counts and each flagged run.
// Run: node test/run.mjs test/send-claim-sample.mjs -- [N files]
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { assess, isSendCall, findClaims } from "../pi-extension/send-claim.ts";
const root = path.join(os.homedir(), ".pi/agent/sessions");
const files = fs.readdirSync(root).flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => path.join(root, d, f))).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, Number(process.argv[2] || 120));
const MENTION = /\b(sent|posted|emailed|messaged|published|replied|forwarded)\b/i;
let runs = 0, mention = 0, flagged = 0; const out = [];
for (const f of files) {
  let sentSession = false, cur = null; const calls = new Map();
  const close = () => { if (!cur) return; runs++; const t = cur.texts.join("\n"); if (MENTION.test(t)) { mention++; const r = assess(cur.texts, cur.sent, sentSession); if (r.flagged || (process.env.ALL && !cur.sent)) { flagged++; out.push({ f: path.basename(f).slice(0, 30), claims: r.claims.slice(0, 2), tools: cur.names.slice(-6) }); } } if (cur.sent) sentSession = true; cur = null; };
  for (const l of fs.readFileSync(f, "utf8").split("\n")) {
    let d; try { d = JSON.parse(l); } catch { continue; } const m = d.message; if (!m) continue;
    if (m.role === "user") { close(); cur = { texts: [], sent: false, names: [] }; continue; }
    if (!cur) continue;
    if (m.role === "assistant" && Array.isArray(m.content)) for (const p of m.content) { if (p.type === "text") cur.texts.push(p.text); if (p.type === "toolCall") { calls.set(p.id, isSendCall(p.name, p.arguments)); cur.names.push(p.name); } }
    if (m.role === "toolResult" && calls.get(m.toolCallId) && !m.isError) cur.sent = true;
  }
  close();
}
console.log(JSON.stringify({ files: files.length, runs, runsMentioningSentWords: mention, flagged, rate: (flagged / Math.max(1, mention)).toFixed(3) }));
for (const o of out) console.log(JSON.stringify(o));
