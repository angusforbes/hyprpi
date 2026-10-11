// inbox-retention.mjs: how long files live in a sandbox's read-only inbox, per kind (J459, Angus: "let's add config options to change how
// long things can live in the inbox. I can easily imagine getting distracted and not checking until the next day").
//
// Settings, Angus only (gateway-admin.mjs KEYS: never proposable by a sandbox or agent), in the served world's
// ~/.config/hyprpi/worlds/<world>.json "gateway" block (a number or a numeric string):
//   inbox_messages_hours   message items <13-digit time>-<8 hex>.json      default 24 (1 h .. 720 h)
//   inbox_reports_days     research reports research-<id>.md                default 7  (1 .. 90 days)
//   inbox_gpu_days         GPU results gpu-g<8 hex>.md / gpu-g<8 hex>-*      default 7  (1 .. 90 days)
//   inbox_max_files        the most message items kept (the oldest go first) default 300 (20 .. 5000)
// The relay sweeps each inbox at start, every hour, and whenever it writes a file there. Only those three name patterns are ever
// removed; anything else in the inbox (and anything outside it) is left alone.
import fs from "node:fs";
import path from "node:path";
import { worldsFor } from "./research/mode.mjs";

export const RETENTION_KEYS = {
  inbox_messages_hours: { def: 24, min: 1, max: 720, unit: 3600 * 1000 },
  inbox_reports_days: { def: 7, min: 1, max: 90, unit: 24 * 3600 * 1000 },
  inbox_gpu_days: { def: 7, min: 1, max: 90, unit: 24 * 3600 * 1000 },
  inbox_max_files: { def: 300, min: 20, max: 5000, unit: 1 },
};
export const RETENTION_OK = (k) => (v) => { const s = RETENTION_KEYS[k]; return /^[0-9]{1,5}$/.test(String(v)) && Number(v) >= s.min && Number(v) <= s.max; };
export const RETENTION_WHY = (k) => { const s = RETENTION_KEYS[k]; return `a whole number from ${s.min} to ${s.max}`; };

const MSG_RE = /^[0-9]{13}-[0-9a-f]{8}\.json$/, REPORT_RE = /^research-[a-z0-9]+\.md$/, GPU_RE = /^gpu-g[0-9a-f]{8}(\.md|-[A-Za-z0-9._-]+)$/;

// The settings in effect for a sandbox: { messagesMs, reportsMs, gpuMs, maxFiles }. A missing, unreadable or out-of-range value is the default.
export function retentionFor(cfgDir, sandbox) {
  let g = {}; try { const hits = worldsFor(cfgDir, sandbox); if (hits.length === 1) g = hits[0].w?.gateway || {}; } catch { /* defaults */ }
  const v = (k) => { const s = RETENTION_KEYS[k], x = g[k]; return x != null && RETENTION_OK(k)(x) ? Number(x) : s.def; };
  return { messagesMs: v("inbox_messages_hours") * RETENTION_KEYS.inbox_messages_hours.unit, reportsMs: v("inbox_reports_days") * RETENTION_KEYS.inbox_reports_days.unit,
    gpuMs: v("inbox_gpu_days") * RETENTION_KEYS.inbox_gpu_days.unit, maxFiles: v("inbox_max_files") };
}

// One sweep over an inbox's names. io = { mtimeMs(name), unlink(name) } (the relay passes its pinned-directory versions). room = how many
// message items to make room for (1 when about to write one). → the names removed.
export function sweepInbox(names, io, ret, { now = Date.now(), room = 0 } = {}) {
  const gone = [], rm = (n) => { try { io.unlink(n); gone.push(n); } catch { /* raced */ } };
  const msgs = names.filter((n) => MSG_RE.test(n)).sort(), cut = now - ret.messagesMs;
  msgs.forEach((n, i) => { if (i < msgs.length - ret.maxFiles + room || Number(n.split("-")[0]) < cut) rm(n); });
  for (const n of names) {
    const keep = REPORT_RE.test(n) ? ret.reportsMs : GPU_RE.test(n) ? ret.gpuMs : 0;
    if (!keep) continue;
    let t; try { t = io.mtimeMs(n); } catch { continue; }
    if (now - t > keep) rm(n);
  }
  return gone;
}
