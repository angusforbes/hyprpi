// J412 (spec 1.5, decision D9 a): the ONE line a day about what went through without a human decision. In yolo that is everything
// auto-approved (relay log entries with auto:"<mode>" and reviewed:false: kind, sandbox) plus the research results delivered unreviewed;
// in open it is the research plans sent but flagged (off task, no task). Pure function over the two logs; the CLI is
// `research.mjs digest --daily [--send]`, run once a day by docker/research/digest-timer.sh. Nothing here decides or sends anything else.
import fs from "node:fs";
import path from "node:path";

function readLines(f, now, sinceMs) {
  let raw = ""; try { raw = fs.readFileSync(f, "utf8"); } catch { return []; }
  const out = []; // by time, not by line count: the whole window is read (red team J412: a flood must not push an item out)
  for (const l of raw.split("\n")) { if (!l) continue; try { const e = JSON.parse(l); const t = Date.parse(e.ts || e.t); if (t > now - sinceMs) out.push(e); } catch { /* skip */ } }
  return out;
}
// → { count, text }: text is a single line ("" when nothing went through unreviewed).
export function dailyLine({ researchLog, relayLog, now = Date.now(), sinceMs = 24 * 3600e3 } = {}) {
  const auto = readLines(relayLog, now, sinceMs).filter((e) => e.reviewed === false && typeof e.auto === "string");
  const res = readLines(researchLog, now, sinceMs);
  const delivered = res.filter((e) => e.ev === "delivered-open"), flagged = res.filter((e) => e.ev === "flagged");
  const byKind = {}; for (const e of auto) { const k = String(e.kind || e.op || "?").slice(0, 24); byKind[k] = (byKind[k] || 0) + 1; }
  const parts = [];
  if (delivered.length) parts.push(`${delivered.length} research result${delivered.length > 1 ? "s" : ""} delivered without review`);
  if (flagged.length) parts.push(`${flagged.length} research plan${flagged.length > 1 ? "s" : ""} sent flagged (off task or no task)`);
  for (const [k, n] of Object.entries(byKind).sort()) parts.push(`${n} ${k}`);
  if (!parts.length) return { count: 0, text: "" };
  const sbs = [...new Set([...auto.map((e) => e.sb), ...res.map((e) => e.sandbox)].filter(Boolean))].slice(0, 6).join(", ");
  return { count: delivered.length + flagged.length + auto.length, text: `Daily digest (J412): in the last 24 h, without a human decision${sbs ? ` (${sbs})` : ""}: ${parts.join("; ")}. Everything is in the logs.` };
}
