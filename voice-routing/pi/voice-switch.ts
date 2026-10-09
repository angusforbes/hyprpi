// voice-switch — redirect the user's targeted dictation (hyprpi voice-routing / voice-agent)
// to another agent or room without the picker.
//
//   /voice-switch <who>      human slash command
//   /voice-switch            show the current target + candidates
//   voice_switch tool        for the model: call it when the user says "switch
//                            listener / audience / voice to X", "talk to the
//                            room", "send my voice to Torque", "voice back to
//                            you", etc.
//
// Everything is delegated to ~/.local/bin/voice-agent (`set`, `status`,
// `list`), which never interrupts the receiving agent: switching only rewrites
// the target file and focuses the pane.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  const va = async (args: string[]) => {
    const r = await pi.exec("voice-agent", args, { timeout: 20000 });
    return { ok: r.code === 0, out: (r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim() };
  };

  pi.registerTool({
    name: "voice_switch",
    label: "Voice switch",
    description:
      "Change who receives the user's targeted dictation (SUPER+Caps Lock). action=set with `who` = an agent name " +
      "(e.g. Torque; icon optional, unique prefix ok), a pane id (w8:p4), 'me' (this pane), 'room'/'here' (this " +
      "workspace's shared room), 'room:w4' or 'room <label>', or 'none'. action=status shows the current target; " +
      "action=list shows every candidate. Switching never interrupts the target agent. On success the target's pane is focused. " +
      "On failure the result explains why (unknown/ambiguous name, agent gone) — relay that reason to the user. " +
      "Targets are a SET: action=set replaces it with one target, action=add adds another (\"also send to Torque\"), action=remove drops one (\"stop sending to Hello\"). Members of a targeted room are not double-prompted. " +
      "action=handsfree with who='on'|'off'|'toggle'|'status' controls hands-free mode (always-on mic listening for " +
      "\"on on on / send send send / off off off\" + resident whisper). Hands-free off = only SUPER+Caps Lock push-to-talk.",
    promptSnippet: "Redirect the user's dictation to another agent or room (voice_switch)",
    promptGuidelines: [
      "Use voice_switch when the user asks to switch the listener/audience/voice target, e.g. \"switch to Torque\", \"talk to the room\", \"voice back to you\", \"send my dictation to Hello\". Do not open the picker; if the tool fails, tell him exactly why.",
      "Use voice_switch action=handsfree when the user asks to turn hands-free / the always-on listener / the microphone listening on or off (\"turn off the listener\", \"hands-free on\", \"stop listening\").",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("set"), Type.Literal("add"), Type.Literal("remove"), Type.Literal("status"), Type.Literal("list"), Type.Literal("handsfree")], { default: "set" })),
      who: Type.Optional(Type.String({ description: "target for action=set; on|off|toggle|status for action=handsfree" })),
    }),
    async execute(_id, p) {
      const action = p.action ?? "set";
      if (action === "set" || action === "add" || action === "remove") {
        if (!p.who?.trim()) return { content: [{ type: "text", text: "no target given" }], isError: true };
        const r = await va([action, p.who.trim()]);
        return { content: [{ type: "text", text: r.out || (r.ok ? "switched" : "failed") }], isError: !r.ok };
      }
      if (action === "handsfree") {
        const r = await va(["handsfree", (p.who ?? "status").trim()]);
        return { content: [{ type: "text", text: r.out || (r.ok ? "ok" : "failed") }], isError: !r.ok };
      }
      const r = await va([action]);
      return { content: [{ type: "text", text: r.out }], isError: !r.ok };
    },
  });

  pi.registerCommand("voice-switch", {
    description: "Voice targets: /voice-switch <name|room|here|me|none> (replace) · /voice-switch add|remove <name> · /voice-switch handsfree [on|off]",
    handler: async (args, ctx) => {
      const who = (args ?? "").trim();
      const hf = who.match(/^hands-?free(?:\s+(on|off|toggle|status))?$/i);
      if (hf) {
        const r = await va(["handsfree", hf[1]?.toLowerCase() ?? "toggle"]);
        ctx.ui.notify(r.out, r.ok ? "info" : "warning");
        return;
      }
      if (!who) {
        const s = await va(["status"]);
        const l = await va(["list"]);
        ctx.ui.notify(s.out, "info");
        pi.sendMessage({ customType: "voice-switch", content: `Voice target:\n${s.out}\n\nCandidates:\n${l.out}`, display: true }, { deliverAs: "nextTurn" });
        return;
      }
      const m = who.match(/^(add|\+|remove|rm|-)\s+(.+)$/i);
      const r = m ? await va([/^(add|\+)$/i.test(m[1]) ? "add" : "remove", m[2]]) : await va(["set", who]);
      ctx.ui.notify(r.out, r.ok ? "info" : "warning");
    },
  });
}
