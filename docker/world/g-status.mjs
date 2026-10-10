// A sandboxed world's agents, shown on the host (J401). Inside the sandbox a small sidecar (`node g-status.mjs run`, started by
// world.sh) reads the world's own daemon every few seconds and sends a summary to the host's world-helper (op "status"). On the
// host, world-helper checks it with validateStatus() below and keeps only what passes; the agents panel draws those as dim,
// display-only rows "reported by G". Nothing the sandbox sends is trusted beyond this schema; the rows can't be used to talk,
// demand, focus or close anything (the workspace comes from world-helper's own window map, not from the sandbox).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
export const LIMITS = { agents: 12, bytes: 8192 };
export const STATUSES = ["working", "background", "blocked", "done", "idle"];
export const THOUGHTS = ["running", "idle", "off"];
const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,30}$/, ID_RE = /^[A-Za-z0-9_.-]{3,64}$/, MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,59}){0,3}$/;
// a model as shown: its last part ("gpt-6-astra"), when it looks like a model id; anything else is "other"
export const modelShown = (m) => (typeof m === "string" && m.length <= 120 && MODEL_RE.test(m) ? m.split("/").pop().replace(/^claude-/, "").slice(0, 40) : "other");

// raw: what the sandbox sent (any JSON). -> { agents: [{ id, name, status, model }], thoughts, dropped } (never throws)
export function validateStatus(raw) {
  const out = { agents: [], thoughts: "", dropped: 0 };
  let size = 0; try { size = Buffer.byteLength(JSON.stringify(raw ?? null)); } catch { return { ...out, dropped: 1 }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || size > LIMITS.bytes) return { ...out, dropped: 1 };
  const list = Array.isArray(raw.agents) ? raw.agents : [];
  const seen = new Set();
  for (const a of list) {
    if (out.agents.length >= LIMITS.agents) { out.dropped++; continue; }
    const ok = a && typeof a === "object" && typeof a.name === "string" && NAME_RE.test(a.name) && typeof a.id === "string" && ID_RE.test(a.id)
      && typeof a.status === "string" && STATUSES.includes(a.status) && !seen.has(a.id);
    if (!ok) { out.dropped++; continue; }
    seen.add(a.id);
    out.agents.push({ id: a.id, name: a.name.replace(/\s+/g, " ").trim(), status: a.status, model: modelShown(a.model) });
  }
  if (typeof raw.thoughts === "string" && THOUGHTS.includes(raw.thoughts)) out.thoughts = raw.thoughts;
  return out;
}

// --- inside the sandbox: the sidecar -------------------------------------------------------------------------------------
// only as the main program (world-helper imports this module and itself runs as "world-helper.mjs run …")
const MAIN = (() => { try { return realpathSync(process.argv[1] || "") === fileURLToPath(import.meta.url); } catch { return false; } })();
if (MAIN && process.argv[2] === "run") {
  const { connect } = await import("../../lib/client.mjs"), { gCall } = await import("./g-call.mjs");
  let last = "", lastAt = 0;
  for (;;) {
    try {
      const api = await connect({ name: "g-status" });
      const r = await api.call("ui.subscribe", { windows: false }); try { api.close?.(); } catch { /* */ }
      const me = process.env.HYPRPI_SANDBOX_WORLD || "", th = (Array.isArray(r.thoughts) ? r.thoughts : []).find((t) => t && t.room === me);
      const body = { agents: (r.agents || []).slice(0, 20).map((a) => ({ id: a.id, name: a.display || a.name, status: a.status, model: a.model })),
        thoughts: th ? (th.running ? "running" : "idle") : "off" };
      const s = JSON.stringify(body);
      if (s !== last || Date.now() - lastAt > 30000) { await gCall({ op: "status", status: body }).catch(() => {}); last = s; lastAt = Date.now(); }
    } catch { /* the daemon is restarting: try again */ }
    await new Promise((res) => setTimeout(res, 5000));
  }
}
