// Rows of agents and projects for the pop-ups (summon on SUPER+S): status marks, "how long ago",
// and the order Angus asked for (× needs you, ✓ finished unseen, ● working, ○ idle, ◌ parked;
// most recent first inside each). The finder (mockups/finder) has the same rules.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../paths.mjs";

export const markOf = (a) => a.parked ? "◌" : a.status === "working" ? "●" : a.status === "blocked" ? "×" : a.status === "done" && !a.seen ? "✓" : "○";
export const projMark = (p, byId) => { const ms = (p.members || []).map((id) => byId[id]).filter((a) => a && !a.parked).map(markOf); return ms.length ? ["×", "●", "✓"].find((k) => ms.includes(k)) || "○" : "◌"; };
const CAT = { "×": 0, "✓": 1, "●": 2, "○": 3, "◌": 4 };
export const byNeedThenRecent = (x, y) => (CAT[x.mark] ?? 3) - (CAT[y.mark] ?? 3) || (y.recent || 0) - (x.recent || 0) || String(x.sort).localeCompare(String(y.sort), undefined, { sensitivity: "base" });

// 1 min · 2–59 mins · 1 hr · 2–23 hrs · 1 day · N days
export function since(ts, now = Date.now()) {
  if (!ts) return "";
  const m = Math.floor((now - ts) / 60000);
  if (m < 2) return "1 min";
  if (m < 60) return `${m} mins`;
  const h = Math.floor(m / 60);
  if (h < 2) return "1 hr";
  if (h < 24) return `${h} hrs`;
  const d = Math.floor(h / 24);
  return d < 2 ? "1 day" : `${d} days`;
}

// Each agent's last turn event (finished, blocked, started, aborted, resumed, joined) from the
// tails of the activity logs (they survive daemon restarts; tool calls don't count).
const TURN = new Set(["done", "blocked", "prompt", "aborted", "resumed", "joined"]);
export function lastTurns(dir = path.join(stateDir(), "activity")) {
  const last = {};
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return last; }
  for (const f of files) {
    let fd; try { fd = fs.openSync(path.join(dir, f), "r"); } catch { continue; }
    try {
      const size = fs.fstatSync(fd).size, n = Math.min(size, 4 << 20), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.includes('"kind"')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.agent?.id && TURN.has(e.kind) && e.ts > (last[e.agent.id] || 0)) last[e.agent.id] = e.ts;
      }
    } finally { fs.closeSync(fd); }
  }
  return last;
}
