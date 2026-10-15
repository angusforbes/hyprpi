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
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

// One terminal line, whatever the width: the text is cut to fit (with …), never wrapped (QuietCheck637b).
class OneLine {
  constructor(private text = "", private style: (t: string) => string = (t) => t, private pad = 0) {}
  setText(t: string, style?: (t: string) => string) { this.text = t; if (style) this.style = style; }
  invalidate() {}
  render(width: number): string[] {
    const w = Math.max(1, width - this.pad);
    return [" ".repeat(this.pad) + this.style(truncateToWidth(this.text, w, "…"))];
  }
}
const lines = (rows: Array<[string, (t: string) => string]>, pad = 0) => {
  const c = new Container();
  for (const [t, st] of rows) c.addChild(new OneLine(t, st, pad) as any);
  return c;
};

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
export function brief(text: string, max = 200, who = ""): string {
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
  return one.length > 200 ? one.slice(0, 199) + "…" : one;
}

function failLine(tool: string, a: any, r: any): string {
  const out = outText(r).trim();
  const code = out.match(/exited with code (\d+)/i)?.[1];
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && !/exited with code/i.test(l));
  // the line that says what went wrong: the first that mentions a failure, else the last one
  const first = lines.find((l) => /fail|error|exception|denied|not found|no such|cannot|can't|invalid|refused|timed? ?out/i.test(l)) || lines[lines.length - 1] || "error";
  return `✗ ${callText(tool, a)} failed${code ? ` (exit ${code})` : ""}: ${first.length > 200 ? first.slice(0, 199) + "…" : first}`;
}

// demand / wait_report results: one "↩ from X · …" line per answer or report
// returns [text, warn?] pairs: warn = something didn't arrive (amber), else dim (QuietCheck637b F3)
function trafficResult(tool: string, r: any): Array<[string, boolean]> {
  const d = r?.details ?? {};
  const out: Array<[string, boolean]> = [];
  const t = outText(r);
  if (tool === "talk" || tool === "demand") {
    if (Array.isArray(d.skipped) && d.skipped.length) out.push([`✗ not delivered: ${d.skipped.map((s: any) => `${s.name}${s.reason ? ` (${s.reason})` : ""}`).join(", ")}`, true]);
    else if (/^Nobody received it/.test(t)) out.push([`✗ ${brief(t)}`, true]);
  }
  if (tool === "demand") {
    for (const x of Array.isArray(d.replies) ? d.replies : []) out.push([`↩ from ${x.name} · ${brief(x.text, 200, x.name)}`, false]);
    if (Array.isArray(d.missing) && d.missing.length) out.push([`✗ no answer from ${d.missing.join(", ")}`, true]);
  }
  if (tool === "wait_report") {
    for (const x of Array.isArray(d.reports) ? d.reports : []) out.push([`↩ from ${x.name}${x.final ? " (final)" : ""} · ${brief(x.text, 200, x.name)}`, false]);
    if (d.timed_out) out.push([`✗ time limit reached${Array.isArray(d.still_working) && d.still_working.length ? ` · no report yet from ${d.still_working.map((w: any) => w?.name || w).join(", ")}` : ""}`, true]);
    else if (d.woken && !(d.reports || []).length) out.push([`· woken early, no report yet`, false]);
  }
  if (tool === "talk_reply" && d && d.delivered === false) out.push(["· saved; the sender isn't connected right now", false]);
  return out;
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
        const c = context?.lastComponent instanceof OneLine ? context.lastComponent : new OneLine();
        c.setText(traffic(args ?? {}), (t: string) => theme.fg("dim", t));
        return c as any;
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        if (options?.expanded && original?.renderResult) return original.renderResult(result, options, theme, context);
        const c = new Container();
        if (options?.isPartial) return c;
        if (context?.isError || result?.isError) return lines([[failLine(toolName, context?.args ?? {}, result) + " · ctrl+o: full output", (t) => theme.fg("warning", t)]]);
        const rows = traffic ? trafficResult(toolName, result) : [];
        return rows.length ? lines(rows.map(([t, warn]) => [t, (x: string) => theme.fg(warn ? "warning" : "dim", x)])) : c;
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
  return lines([[`${kind} ${who} · ${brief(body, 200, who)}`, (t) => theme.fg("dim", t)]], 1);
}

// a child's report (orch.ts's hyprpi-orch messages with details.orch_child): one dim line; budget and other notices: null
export function quietOrch(message: any, expanded: boolean, theme: any): any | null {
  const d = message?.details ?? {};
  if (expanded || !d.orch_child) return null;
  const raw = String(message?.content ?? "");
  const who = raw.match(/^\[report from ([^\s(]+)/)?.[1] || d.orch_child;
  const body = raw.replace(/^\[report from[^\n]*\]\n/, "").replace(/\n\n\((Done|Not finished)[^)]*\)\s*$/, "");
  return lines([[`↩ report from ${who}${d.orch_final ? " (final)" : ""} · ${brief(body, 200, who)}`, (t) => theme.fg("dim", t)]], 1);
}
