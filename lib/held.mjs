// Held sandbox messages (J268): what the drop-box relay (docker/sbx-relay.mjs) is holding for Angus's
// approval, read straight from its pending folder, for the RECEIVING world's room panel on the host.
//
// Deciding never goes through the hyprpi daemon (it has no approve operation at all): the panel runs the
// relay's own CLI, which refuses `approve` from anything with an agent among its ancestors or without a
// terminal (the panel's kitty is one). A sandboxed world's own panels (HYPRPI_SANDBOX_WORLD set, inside
// world G's sandbox) never list or decide anything here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STATE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "hyprpi", "sbx-relay");
const PENDING = path.join(STATE, "pending");
const RELAY = fileURLToPath(new URL("../docker/sbx-relay.mjs", import.meta.url));
const ID_RE = /^[A-Za-z0-9._-]+--[0-9a-f]{6}$/;

export const heldEnabled = () => !process.env.HYPRPI_SANDBOX_WORLD && !process.env.HYPRPI_G_WORLD;

// Control characters out (the relay already strips them; this is the panel's own guard), one line.
const flat = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();

// Held messages addressed to someone in world `letter` (A, B, …), oldest first.
export function heldFor(letter) {
  if (!heldEnabled() || !letter) return [];
  // bounded directory walk (review J268 #6): the relay holds at most 20 per sandbox
  const names = [];
  let dir; try { dir = fs.opendirSync(PENDING); } catch { return []; }
  try { for (let e, i = 0; i < 500 && (e = dir.readSync()); i++) if (e.name.endsWith(".json")) names.push(e.name); } finally { dir.closeSync(); }
  const out = [];
  for (const n of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(PENDING, n), "utf8"));
      if (!ID_RE.test(m.id || "")) continue;
      // rooms: stored since J268; older records only have "…, room B)" in shown
      const rooms = Array.isArray(m.rooms) ? m.rooms : (m.shown || []).map((s) => (/room ([A-Z])\)$/.exec(String(s)) || [])[1]).filter(Boolean);
      if (!rooms.map((r) => String(r).toUpperCase()).includes(String(letter).toUpperCase())) continue;
      out.push({ id: m.id, at: m.at || "", sandbox: flat(m.sandbox), to: (m.shown || m.to || []).map((s) => flat(String(s).replace(/ \(.*\)$/, ""))), text: flat(m.text) });
    } catch { /* half-written or gone */ }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Angus's y / n from the panel: the relay CLI decides (approve needs a terminal and no agent ancestor).
export function decideHeld(id, verdict) {
  if (!heldEnabled()) return { ok: false, text: "not here (sandboxed world)" };
  if (!ID_RE.test(id) || !["approve", "deny"].includes(verdict)) return { ok: false, text: "bad id" };
  const r = spawnSync(process.execPath, [RELAY, verdict, id], { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", timeout: 10000 });
  const text = flat((r.stdout || "") + " " + (r.stderr || ""));
  return { ok: r.status === 0, text };
}
