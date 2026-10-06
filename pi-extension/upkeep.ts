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
import { loadUpkeep, expandHome } from "../lib/upkeep.mjs";

export { pruneMessages } from "../lib/prune.mjs";
import { pruneMessages } from "../lib/prune.mjs";

export function upkeepAgent(pi: ExtensionAPI, { call, agentId, idle }: { call: (m: string, p?: any) => Promise<any>; agentId: string; idle: () => boolean }) {
  const seen = new Set<string>();
  let noted = 0, pending = { images: 0, outputs: 0, bytes: 0 };
  pi.on("context", async (e: any) => {
    let S: any; try { S = loadUpkeep(); } catch { return; }
    if (!S?.prune?.enabled) return;
    const dir = path.join(expandHome(S.prune.saveDir || "~/.local/state/hyprpi/pruned"), agentId);
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
  });
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
