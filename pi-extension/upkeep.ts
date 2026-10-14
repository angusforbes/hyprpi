/**
 * J125 upkeep, the agent side (settings: ~/.config/hyprpi/hyprpi.jsonc, section "upkeep"; lib/policy.mjs).
 *
 * 1. Pruning: pi's "context" hook transforms the messages of each model request (pi restores them, so the
 *    session file keeps everything). Older large images and big tool outputs become a stub with a
 *    file:// link; anything that isn't already a file on disk is saved first, so every link resolves.
 *    Never pruned: Angus's current message and the latest tool result (Thoughts-D).
 * 2. Compact and continue: after a compaction, a short hidden reminder of the job (J<n> brief) the agent
 *    is on, so it carries on with it (pi itself continues the run).
 * 3. Overdue refresh: the upkeep_ready tool, called by the agent once it has written the handoff the
 *    daemon asked for; the daemon then reopens it on a fresh session that starts from that handoff.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
// J563 (Claw: "(0, _upkeep.statePath) is not a function"): a namespace import, so a pi process whose module cache still holds an
// older lib/upkeep.mjs (one from before J437 added statePath; an in-process /reload re-reads this file but not that one) falls
// back to expandHome instead of failing every turn
import * as U from "../lib/upkeep.mjs";
const { loadUpkeep } = U as any;
const statePath: (p: string) => string = (U as any).statePath ?? (U as any).expandHome ?? ((p: string) => p);

export { pruneMessages } from "../lib/prune.mjs";
import { pruneMessages } from "../lib/prune.mjs";

// J563 v2 (Angus on the error screen: "pretty ugly"): a context hook that throws must not kill the turn or put a stack trace in
// his window. The turn goes on unchanged (unpruned); the full trace goes to ~/.local/state/hyprpi/upkeep-errors.log; the window
// shows ONE short dim line and the world's Thoughts ONE alert, the first time each step fails in this pi process (not every turn).
export const UPKEEP_ERROR_LOG = path.join(process.env.HYPRPI_STATE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "hyprpi"), "upkeep-errors.log");
// "told" lives on globalThis, so an in-process /reload (which re-runs this file) doesn't re-announce the same failure (UpkeepCheck)
const TOLD: Set<string> = ((globalThis as any).__hyprpiUpkeepTold ??= new Set<string>());
export function failSoft(where: string, err: any, o: { ctx?: any; call?: (m: string, p?: any) => Promise<any>; agentId?: string; room?: string; told?: Set<string> }) {
  const msg = String(err?.message ?? err).split("\n")[0].slice(0, 140);
  try { fs.mkdirSync(path.dirname(UPKEEP_ERROR_LOG), { recursive: true }); fs.appendFileSync(UPKEEP_ERROR_LOG, `${new Date().toISOString()} ${o.agentId || "?"} ${where}: ${err?.stack || msg}\n`); } catch { /* no log: still soft */ }
  const key = `${o.agentId || "?"}:${where}`;
  if (TOLD.has(key)) return;
  TOLD.add(key);
  try { o.ctx?.ui?.notify?.(`⚠ upkeep: ${where} skipped (${msg}); reported`, "warning"); } catch { /* no UI */ }
  const ws = Number(process.env.HYPRPI_WORKSPACE) || 1, room = o.room || "ABCDEFGHI"[Math.min(8, Math.floor((ws - 1) / 10))] || "A"; // (Thoughts passes its own room: it has no HYPRPI_WORKSPACE)
  o.call?.("thoughts.alert", { room, text: `upkeep: ${where} failed in agent ${o.agentId || "?"} (${msg}); its turns carry on without it. Trace: ${UPKEEP_ERROR_LOG}` }).catch(() => {});
}

export function upkeepAgent(pi: ExtensionAPI, { call, agentId, idle }: { call: (m: string, p?: any) => Promise<any>; agentId: string; idle: () => boolean }) {
  const seen = new Set<string>();
  let noted = 0, pending = { images: 0, outputs: 0, bytes: 0 };
  pi.on("context", async (e: any, ctx: any) => { try { return await pruneContext(e); } catch (err) { failSoft("pruning", err, { ctx, call, agentId }); return; } });
  async function pruneContext(e: any) {
    let S: any; try { S = loadUpkeep(); } catch { return; }
    if (!S?.prune?.enabled) return;
    const dir = path.join(statePath(S.prune.saveDir || "~/.local/state/hyprpi/pruned"), agentId);
    const r = pruneMessages(e?.messages || [], S, { dir, seen });
    if (!r.stats.images && !r.stats.outputs) return;
    // One quiet note to its Thoughts for what was newly pruned, at most every 10 minutes.
    if (r.stats.newly) { pending.images += r.stats.images; pending.outputs += r.stats.outputs; pending.bytes += r.stats.bytes; }
    if (pending.images + pending.outputs && Date.now() - noted > 600000) {
      noted = Date.now();
      const p = pending; pending = { images: 0, outputs: 0, bytes: 0 };
      call("upkeep.note", { kind: "prune", images: p.images, outputs: p.outputs, kb: Math.round(p.bytes / 1024), dir }).catch(() => {});
    }
    return { messages: r.messages };
  }
  // 2. After a compaction: a hidden reminder of the job it is on (the daemon knows its running briefs).
  pi.on("session_compact", async (_e: any) => {
    let S: any; try { S = loadUpkeep(); } catch { return; }
    if (!S?.compactContinue?.enabled || !S.compactContinue.briefReminder) return;
    try {
      const r = await call("upkeep.jobs", {});
      const jobs = (r?.jobs || []).map((j: any) => `${j.job} v${j.version}: ${j.goal}`).join("\n");
      if (!jobs) return;
      const text = `[hyprpi upkeep] Your context was just compacted. You are on:\n${jobs}\nCarry on with it where you left off; report against its done-when lines as briefed.`;
      pi.sendMessage({ customType: "hyprpi-upkeep", content: text, display: false } as any, idle() ? { triggerTurn: false } as any : { deliverAs: "steer" } as any);
    } catch { /* no daemon: pi still continues */ }
  });
  // 3. The handoff the daemon asked for is written: reopen on a fresh session from it.
  pi.registerTool({
    name: "upkeep_ready",
    label: "Upkeep: handoff written",
    description: "Only when hyprpi upkeep asked you to write a handoff note for a refresh: call this once the note is written (file = the path it gave you). hyprpi then reopens you on a fresh session that starts from your note (same name, workspace, projects, jobs). Finish your reply right after calling it.",
    parameters: Type.Object({ file: Type.String() }, { additionalProperties: false }),
    execute: async (_id: string, p: any) => {
      const r = await call("upkeep.ready", { file: p.file });
      return { content: [{ type: "text" as const, text: `Handoff received (${r.file}). You'll be reopened on a fresh session that starts from it as soon as this turn ends. Don't start anything else.` }], details: r };
    },
  });
}
