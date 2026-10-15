// Quiet transcript for ONE agent (J637 v3, Angus: "i mainly want a hyprpi agent that can hide its calls and errors
// nicely"). Loaded by index.ts (hyprpi's own extension, loaded first, so its tool-renderer resolver runs before any
// other extension's and its message renderers are the ones pi uses). Off unless THIS agent is switched on:
//   PI_QUIET_TOOLS=1 in its environment, or its hyprpi agent id in ~/.config/hyprpi/quiet-tools.json
//   ({"agents": ["hp-…"]}); PI_QUIET_TOOLS=0 forces it off. Read at start / reload.
// When on:
//   - ordinary tool calls (bash, read, edit, write, grep, board_*, MCP …) draw NOTHING when they succeed;
//   - a failed call is ONE amber line saying what failed; its full output (pi's own rendering) with ctrl+o;
//   - agent-to-agent traffic is ONE dim line each, Thoughts-style: "↪ to Sweep · test T2", "↩ from Radio · J581
//     installed", kept in the scrollback (they are the transcript's own entries, only drawn differently);
//   - the agent's own replies, and Angus's room posts and prompts, are unchanged (prominent).
// Only the drawing changes: the model still receives every message and tool result in full.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";

export function quietOn(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): boolean {
  if (env.PI_QUIET_TOOLS === "1") return true;
  if (env.PI_QUIET_TOOLS === "0") return false;
  const me = env.HYPRPI_AGENT_ID;
  if (!me) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".config/hyprpi/quiet-tools.json"), "utf8"));
    return Array.isArray(cfg.agents) && cfg.agents.includes(me);
  } catch {
    return false;
  }
}

// one short line: first sentence (or line), headers and ids dropped
export function brief(text: string, max = 70, who = ""): string {
  let t = String(text ?? "").replace(/^\[hyprpi[^\]]*\]\s*/i, "").replace(/^\s*(Knock|Thoughts-[A-Z])\s*(→|->)[^:]*:\s*/, "");
  t = t.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  if (who) t = t.replace(new RegExp("^" + who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(→[^:]*)?:\\s*"), ""); // "Radio: …" from Radio
  const s = t.match(/^(.+?[.!?])(\s|$)/);
  if (s && s[1].length >= 12) t = s[1];
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

const names = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

// agent traffic tools: tool -> (args) => one-line call text
const TRAFFIC: Record<string, (a: any) => string> = {
  talk: (a) => `↪ to ${names(a.recipients)} · ${brief(a.message)}`,
  demand: (a) => `↪ asked ${names(a.recipients)} · ${brief(a.message)}`,
  talk_reply: (a) => `↪ replied · ${brief(a.text)}`,
  ask_agent: (a) => `↪ asked ${names(a.agent ?? a.agents ?? a.to)} · ${brief(a.question ?? a.message ?? a.text)}`,
  give_work: (a) => `↪ work to ${names(a.agent ?? a.to)} · ${brief(a.goal ?? a.angus ?? a.message ?? "")}`,
  spawn_agent: (a) => `↪ started ${a.name || "a helper"} · ${brief(a.prompt)}`,
  report_to_parent: (a) => `↪ reported${a.final ? " (final)" : ""} · ${brief(a.text)}`,
  close_agent: (a) => `↪ closed ${a.id || "myself"}`,
  wait_report: () => `· waiting for reports`,
};

const outText = (r: any) => (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("\n");

function callText(tool: string, a: any): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const x = tool === "bash" ? "$ " + s(a?.command).split("\n")[0]
    : ["read", "edit", "write"].includes(tool) ? `${tool} ${s(a?.path) || s(a?.file_path)}`
    : `${tool} ${s(a?.pattern) || s(a?.path) || s(a?.project) || ""}`.trim();
  const one = x.replace(/[\r\n\t]+/g, " ");
  return one.length > 60 ? one.slice(0, 59) + "…" : one;
}

function failLine(tool: string, a: any, r: any): string {
  const out = outText(r).trim();
  const code = out.match(/exited with code (\d+)/i)?.[1];
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && !/exited with code/i.test(l));
  // the line that says what went wrong: the first that mentions a failure, else the last one
  const first = lines.find((l) => /fail|error|exception|denied|not found|no such|cannot|can't|invalid|refused|timed? ?out/i.test(l)) || lines[lines.length - 1] || "error";
  return `✗ ${callText(tool, a)} failed${code ? ` (exit ${code})` : ""}: ${first.length > 70 ? first.slice(0, 69) + "…" : first}`;
}

// demand / wait_report results: one "↩ from X · …" line per answer or report
function trafficResult(tool: string, r: any): string[] {
  const d = r?.details ?? {};
  if (tool === "demand" && Array.isArray(d.replies)) return d.replies.map((x: any) => `↩ from ${x.name} · ${brief(x.text, 70, x.name)}`);
  if (tool === "wait_report" && Array.isArray(d.reports)) return d.reports.map((x: any) => `↩ from ${x.name}${x.final ? " (final)" : ""} · ${brief(x.text, 70, x.name)}`);
  return [];
}

export function quietMode(pi: any) {
  if (!quietOn()) return false;
  pi.on("session_start", async (_e: any, ctx: any) => ctx?.ui?.setHiddenThinkingLabel?.("·"));
  pi.registerToolRenderer((toolName: string, next: () => any) => {
    const original = next(); // what pi (or the tool) would draw: used on ctrl+o
    const traffic = TRAFFIC[toolName];
    return {
      renderShell: "self",
      renderCall(args: any, theme: any, context: any) {
        if (context?.expanded && original?.renderCall) return original.renderCall(args, theme, context);
        if (!traffic) return new Container(); // ordinary call: nothing (a failure is drawn by renderResult)
        const c = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        c.setText(theme.fg("dim", traffic(args ?? {})));
        return c;
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        if (options?.expanded && original?.renderResult) return original.renderResult(result, options, theme, context);
        const c = new Container();
        if (options?.isPartial) return c;
        if (context?.isError || result?.isError) {
          c.addChild(new Text(theme.fg("warning", failLine(toolName, context?.args ?? {}, result)) + theme.fg("dim", "  (ctrl+o: full output)"), 0, 0));
          return c;
        }
        const lines = traffic ? trafficResult(toolName, result) : [];
        if (lines.length) c.addChild(new Text(lines.map((l) => theme.fg("dim", l)).join("\n"), 0, 0));
        return c;
      },
    };
  });
  return true;
}

// incoming agent traffic (index.ts's hyprpi-talk / hyprpi-talk-reply messages): one dim line, full text on ctrl+o
export function quietIncoming(message: any, expanded: boolean, theme: any): any | null {
  if (expanded) return null;
  const d = message?.details ?? {};
  const who = d?.from?.name || "an agent";
  const body = typeof d?.text === "string" ? d.text : String(message?.content ?? "");
  const kind = message?.customType === "hyprpi-talk-reply" ? "↩ reply from" : d?.mode === "demand" ? "↩ asked by" : "↩ from";
  return new Text(theme.fg("dim", `${kind} ${who} · ${brief(body, 70, who)}`), 1, 0);
}
