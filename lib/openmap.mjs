// Restore-all (J8, Angus via Thoughts-A): helpers for the "what is open" map.
//
// Agents live in the registry (STATE/agents.json, the one source of truth for agents, Blink):
// `open: true` = it was open and nobody closed it on purpose, so it is restored after a crash,
// shutdown or daemon stop. Only a deliberate close (agent.bye, a window closed by hand while
// hyprpi runs) sets `open: false` with closedBy / closedReason / closedAt.
// Panels (the four kitty panels per world) live in STATE/panels.json, written here.
import fs from "node:fs";

// Panel windows are recognised by title: "hyprpi-router C" etc. (mockups/panels).
export const PANEL_KINDS = {
  router: { kind: "agents", launcher: "agents-tui" },
  room: { kind: "stream", launcher: "room-tui" },
  search: { kind: "search", launcher: "search-tui" },
  board: { kind: "board", launcher: "board-tui" },
};
const KIND_TITLE = Object.fromEntries(Object.entries(PANEL_KINDS).map(([t, k]) => [k.kind, t]));
export const panelTitle = (kind, world) => `hyprpi-${KIND_TITLE[kind]} ${world}`;
export const launcherFor = (kind) => Object.values(PANEL_KINDS).find((k) => k.kind === kind)?.launcher || "";

// A Hyprland client -> panel record, or null when it isn't a panel.
export function panelOf(c) {
  const m = /^hyprpi-(router|room|search|board) ([A-Za-z0-9_-]{1,40})$/.exec(c?.title || "");
  if (!m) return null;
  return {
    kind: PANEL_KINDS[m[1]].kind, world: m[2], address: c.address || "",
    workspace: c.workspace?.id ?? null, wsName: c.workspace?.name || "",
    floating: !!c.floating, at: Array.isArray(c.at) ? c.at.slice(0, 2) : null, size: Array.isArray(c.size) ? c.size.slice(0, 2) : null,
  };
}
export const panelKey = (p) => `${p.kind}:${p.world}`;

// Atomic JSON write (tmp + rename) that keeps the previous version as FILE.bak.
export function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data, null, 1));
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fall back to the backup */ }
  try { return JSON.parse(fs.readFileSync(file + ".bak", "utf8")); } catch { return fallback; }
}

// The model and thinking level a session last used (its last model_change / thinking_level_change),
// so a restored agent comes back on its own model, not the config's --model.
export function sessionModel(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return { model: "", thinking: "" }; }
  let model = "", thinking = "";
  for (const line of text.split("\n")) {
    if (line.includes('"type":"model_change"')) {
      try { const e = JSON.parse(line); if (e.provider && e.modelId) model = `${e.provider}/${e.modelId}`; } catch { /* torn line */ }
    } else if (line.includes('"type":"thinking_level_change"')) {
      try { const e = JSON.parse(line); if (e.thinkingLevel) thinking = e.thinkingLevel; } catch { /* torn line */ }
    }
  }
  return { model, thinking };
}

// Launch order: originals before their twins (a twin's twinOf must be live first).
export function restoreOrder(list) {
  const ids = new Set(list.map((r) => r.id));
  const out = [], done = new Set();
  const visit = (r, depth = 0) => {
    if (done.has(r.id)) return;
    if (r.twinOf && ids.has(r.twinOf) && depth < 10) visit(list.find((x) => x.id === r.twinOf), depth + 1);
    done.add(r.id); out.push(r);
  };
  for (const r of list) visit(r);
  return out;
}

// "12 agents, 8 panels across B, C, D, E"
export function summaryText(agents, panels) {
  const worlds = [...new Set([...agents.map((a) => a.world), ...panels.map((p) => p.world)].filter(Boolean))].sort();
  const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const parts = [agents.length ? n(agents.length, "agent") : "", panels.length ? n(panels.length, "panel") : ""].filter(Boolean);
  return `${parts.join(", ") || "nothing"}${worlds.length ? ` across ${worlds.join(", ")}` : ""}`;
}
