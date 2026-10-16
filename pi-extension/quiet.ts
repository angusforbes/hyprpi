// Quiet transcript for ONE agent (J637 v3, Angus: "i mainly want a hyprpi agent that can hide its calls and errors
// nicely"). Loaded by index.ts (hyprpi's own extension, loaded first, so its tool-renderer resolver runs before any
// other extension's and its message renderers are the ones pi uses). Off unless THIS agent is switched on:
//   PI_QUIET_TOOLS=1 in its environment, or its hyprpi agent id in ~/.config/hyprpi/quiet-tools.json
//   ({"agents": ["hp-…"]}); PI_QUIET_TOOLS=0 forces it off. Read at start / reload.
// When on (J642 refinement, Angus via Tangle: "nothing important is lost"):
//   - lookups (read, grep, find, ls, read-only bash, *_read/list/search tools …) draw NOTHING, failed or not
//     (a missing file, a grep with no match, a failing test run are harmless probes);
//   - changes (edit, write, a changing bash command, other tools that act) are ONE dim line each: "edited
//     Bar.qml", "wrote TODO.md", "ran git commit …"; a change that FAILED is ONE amber line (ctrl+o: full output);
//   - while working, the status line says what it is doing ("reading NOTES.md…", "waiting on Sweep…");
//   - after the turn, one dim line counts the silent lookups ("ran 12 checks"); ctrl+o lists them;
//   - agent-to-agent traffic is ONE dim line each, Thoughts-style: "↪ to Sweep · test T2", "↩ from Radio · J581
//     installed", kept in the scrollback (they are the transcript's own entries, only drawn differently);
//   - the agent's own replies, and Angus's room posts and prompts, are unchanged (prominent).
// Only the drawing changes: the model still receives every message and tool result in full.
import { scriptLabel } from "./script-label.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

// One terminal line, whatever the width: the text is cut to fit (with …), never wrapped (QuietCheck637b).
class OneLine {
  private text: string; private style: (t: string) => string; private pad: number;
  constructor(text = "", style: (t: string) => string = (t) => t, pad = 0) { this.text = text; this.style = style; this.pad = pad; } // (no parameter properties: node's strip-only TS loader in the tests rejects them)
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

// ---- change vs lookup (J642 W3). The rule, and its limits, are in spikes/quiet-tools/README.md. ----
const LOOKUP_TOOLS = new Set(["read", "grep", "find", "ls"]);
const LOOKUP_NAME = /(^|_)(read|list|search|get|find|status|show|check|catalog|usage|children|world|history|screenshot|desktop|zoom|marks|binds|notes|ui)(_|$)/i;
const RO_CMD = new Set(["ls", "cat", "head", "tail", "less", "grep", "rg", "egrep", "fgrep", "find", "fd", "wc", "stat", "file", "du", "df",
  "echo", "printf", "pwd", "which", "type", "whereis", "date", "uptime", "free", "id", "whoami", "hostname", "uname", "env", "printenv",
  "ps", "pgrep", "top", "lsof", "ss", "ip", "jq", "yq", "sort", "uniq", "cut", "tr", "awk", "sed", "diff", "cmp", "comm", "md5sum",
  "sha256sum", "basename", "dirname", "realpath", "readlink", "tree", "column", "nl", "fold", "strings", "xxd", "od", "test", "[", "true",
  "false", "sleep", "journalctl", "coredumpctl", "lsusb", "lspci", "lsblk", "pactl", "wpctl", "busctl", "nproc", "getent", "tesseract",
  "identify", "ffprobe", "node", "python3", "python", "go", "npm", "cargo", "pytest", "make", "bash", "sh", "timeout", "curl", "wget",
  "hyprctl", "systemctl", "git", "gh", "docker", "pacman", "hyprpi", "tmux", "pi", "sqlite3", "man", "xargs", "nice", "env", "for", "while",
  "if", "do", "done", "then", "fi", "cd", "export", "local", "set"]);
// a word that is read-only only with some subcommands / flags: (args) => true when it CHANGES something
const SUB_CHANGE: Record<string, (rest: string) => boolean> = {
  sed: (r) => /(^|\s)(-i|--in-place)/.test(r),
  git: (r) => !/^\s*((-C|-c)\s+\S+\s+|--no-pager\s+|--git-dir[= ]\S+\s+|--work-tree[= ]\S+\s+)*(status|log|diff|show|branch(\s+-[avlr]+)*\s*$|rev-parse|ls-files|grep|blame|remote(\s+-v)?\s*$|describe|config\s+--get|worktree\s+list|stash\s+list|tag\s*$|merge-base|cat-file|check-ignore|shortlog|reflog|count-objects|for-each-ref|name-rev|var)\b/.test(r),
  gh: (r) => !/^\s*(issue|pr|repo|run|api)\s+(view|list|status|diff|checks)\b|^\s*auth\s+status|^\s*search\b/.test(r) && !/^\s*api\s+[^-]*$/.test(r),
  systemctl: (r) => /\b(start|stop|restart|reload|enable|disable|mask|unmask|kill|daemon-reload|set-property|edit)\b/.test(r),
  hyprctl: (r) => /\b(dispatch|keyword|reload|setcursor|notify|kill|switchxkblayout)\b/.test(r),
  docker: (r) => !/^\s*(ps|images|inspect|logs|version|info|stats)\b/.test(r) && !(/zricethezav\/gitleaks/.test(r) && !/--report-path/.test(r)),
  wpctl: (r) => /\bset-/.test(r),
  pacman: (r) => /(^|\s)-(S|R|U)/.test(r),
  npm: (r) => !/^\s*(test|run\s+(test|lint|check|build)|ls|view|outdated|audit)\b/.test(r),
  go: (r) => !/^\s*(test|vet|version|env|list|doc)\b/.test(r) && !/^\s*build\b(?!.*\s-o\s+\/(home|usr|etc))/.test(r),
  cargo: (r) => !/^\s*(test|check|build|clippy|tree)\b/.test(r),
  make: (r) => /\binstall\b/.test(r),
  curl: (r) => /(^|\s)-[a-zA-Z]*[dFTOo]|(^|\s)-X\s*(POST|PUT|DELETE|PATCH)|--request\s+(POST|PUT|DELETE|PATCH)|--data|--form|--upload|--output|--remote-name/.test(r),
  wget: () => true,
  hyprpi: (r) => !/^\s*(list|status|help|search|world\s+status)\b/.test(r),
  tmux: (r) => !/^\s*(-L\s+\S+\s+)?(ls|list-\w+|capture-pane|display|has-session|show)/.test(r),
  pactl: (r) => /\b(load-module|unload-module|set-|move-|suspend)/.test(r),
  sqlite3: (r) => /\b(insert|update|delete|create|drop|alter|replace|vacuum)\b/i.test(r),
};
const CHANGE_CMD = /^(rm|rmdir|mv|cp|mkdir|touch|ln|chmod|chown|install|tee|kill|pkill|killall|truncate|shred|dd|patch|notify-send|sudo|su|systemd-run|setsid|nohup|wtype|ydotool|pip|pip3|uv|yay|paru|brev|ssh|scp|rsync|trash|unzip|tar|zip|grim|crontab|chsh|usermod|passwd|ding|bonk)$/;

// one shell command line -> "change" | "lookup"
export function bashKind(command: string): "change" | "lookup" {
  const raw = String(command ?? "");
  // quoted text can't redirect or run anything (unless it is a -c script: those are looked at below)
  let cmd = "", last = 0;
  for (const m of raw.matchAll(/'[^']*'|"(?:[^"\\]|\\.)*"/g)) {
    const before = raw.slice(0, m.index).trimEnd();
    const code = /(\b(bash|sh|zsh)\s+(-\w+\s+)*-c|\bawk(\s+-\w+(\s+\S+)?)*)$/.test(before); // a script: its text counts
    const query = /\bsqlite3(\s+\S+)?$/.test(before); // a query: stays an argument of sqlite3
    const subst = m[0][0] === '"' ? [...m[0].matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].map((x) => x[1] ?? x[2]) : []; // "$(…)" runs
    cmd += raw.slice(last, m.index) + (code ? " ; " + m[0].slice(1, -1) + " ; " : query ? m[0].replace(/[;|&]/g, " ") : "''") + subst.map((x) => " ; " + x + " ; ").join("");
    last = m.index! + m[0].length;
  }
  cmd += raw.slice(last);
  // writes through redirection (not to /dev/null, not a fd dup) or here-doc into a file
  if (/(^|[^0-9&<>])>>?\s*(?!&|\/dev\/null)[^\s|&;]/.test(cmd.replace(/2>&1|>&2|&>\s*\/dev\/null|\d?>\s*\/dev\/null/g, ""))) return "change";
  // python/node inline that writes files
  if (/\b(open\([^)]*['"][wa]['"]|write_text|writeFileSync|appendFileSync|unlink|rmSync|os\.remove|shutil\.(move|copy|rmtree))/.test(raw)) return "change";
  if (/(^|\s)find\s.*\s-(delete|exec(dir)?\s+(rm|mv|cp|chmod|sed\s+-i)|ok)\b/.test(cmd)) return "change";
  for (const seg of cmd.split(/\|\||&&|[;|\n]|\$\(|`/)) {
    const words = seg.trim().replace(/^(\w+=\S*\s+)+/, "").split(/\s+/).filter(Boolean);
    if (words[0] === "sudo") return "change";
    // wrappers: skip them and their options / assignments, then look at the real command
    while (words.length && /^(timeout|nice|env|xargs|command|exec|time|ionice|stdbuf)$/.test(words[0])) {
      words.shift();
      while (words.length && (/^-/.test(words[0]) || /^\w+=/.test(words[0]) || /^\d+(\.\d+)?[smh]?$/.test(words[0]) || /^\{\}$/.test(words[0]))) {
        const o = words.shift()!;
        if (/^-(I|n|P|L|s|k|c)$/.test(o) && words.length && !/^-/.test(words[0])) words.shift(); // option with a value
      }
    }
    if (!words.length) continue;
    const w = words[0].split("/").pop()!;
    const rest = words.slice(1).join(" ");
    if (CHANGE_CMD.test(w)) return "change";
    if (SUB_CHANGE[w]?.(rest)) return "change";
    if (!RO_CMD.has(w) && !/^\.?\.?\//.test(words[0]) && !SUB_CHANGE[w]) continue; // unknown word: neutral
    if (/^\.?\.?\//.test(words[0]) && !/test|check|lint|verify|probe|status|list|show/i.test(w)) return "change"; // a local script: assume it acts
  }
  return "lookup";
}

export function toolKind(tool: string, args: any): "change" | "lookup" | "traffic" {
  if (TRAFFIC[tool]) return "traffic";
  if (LOOKUP_TOOLS.has(tool)) return "lookup";
  if (tool === "bash") return bashKind(args?.command);
  if (tool === "edit" || tool === "write") return "change";
  return LOOKUP_NAME.test(tool.replace(/^mcp__[^_]+__/, "")) ? "lookup" : "change";
}

const base = (p: unknown) => String(p ?? "").split("/").filter(Boolean).pop() || String(p ?? "");
export function changeLine(tool: string, a: any): string {
  if (tool === "edit") return `edited ${base(a?.path ?? a?.file_path)}`;
  if (tool === "write") return `wrote ${base(a?.path ?? a?.file_path)}`;
  if (tool === "bash") return scriptLabel(String(a?.command ?? "")) ?? `ran ${String(a?.command ?? "").split("\n")[0].replace(/\s+/g, " ")}`; // J660: an inline script says what it changed
  const what = a?.project || a?.action || a?.path || a?.name || a?.target || "";
  return `${tool.replace(/^mcp__([^_]+)__/, "$1/")}${what ? ` ${String(what)}` : ""}`;
}
export function statusFor(tool: string, a: any): string {
  const k = toolKind(tool, a);
  if (tool === "read") return `reading ${base(a?.path)}…`;
  if (tool === "grep" || tool === "find" || tool === "ls") return "searching…";
  if (tool === "edit" || tool === "write") return `${tool === "edit" ? "editing" : "writing"} ${base(a?.path)}…`;
  if (tool === "demand") return `waiting on ${names(a?.recipients)}…`;
  if (tool === "wait_report") return "waiting for reports…";
  if (tool === "talk" || tool === "talk_reply") return `messaging${a?.recipients ? " " + names(a.recipients) : ""}…`;
  if (tool === "spawn_agent") return `starting ${a?.name || "a helper"}…`;
  if (tool === "bash") return k === "change" ? `running ${String(a?.command ?? "").trim().split(/\s+/)[0].split("/").pop()}…` : "checking…";
  return k === "lookup" ? "looking…" : `${tool.replace(/^mcp__([^_]+)__/, "$1/")}…`;
}
function lookupLine(tool: string, a: any, failed: boolean): string {
  return `${callText(tool, a)}${failed ? "  (failed)" : ""}`;
}

export function quietMode(pi: any) {
  if (!quietOn()) return false;
  let ui: any = null;
  // J642 v3: hidden thinking keeps pi's own dim "Thinking..." line (J641's empty label left blank rows instead)
  pi.on("session_start", async (_e: any, ctx: any) => { ui = ctx?.ui; });
  // V2: the status line while working (pi's own working indicator; its message only)
  const turnArgs = new Map<string, { tool: string; args: any }>();
  let silent: string[] = [];
  pi.on("tool_execution_start", async (e: any, ctx: any) => {
    if (e?.parentToolCallId) return; // nested (codemode) calls: the caller reports them
    turnArgs.set(e.toolCallId, { tool: e.toolName, args: e.args });
    try { (ctx?.ui ?? ui)?.setWorkingMessage?.(statusFor(e.toolName, e.args ?? {})); } catch { /* best effort */ }
  });
  pi.on("tool_execution_end", async (e: any) => {
    const t = turnArgs.get(e?.toolCallId); turnArgs.delete(e?.toolCallId);
    if (!t || toolKind(t.tool, t.args) !== "lookup") return;
    silent.push(lookupLine(t.tool, t.args ?? {}, !!e?.isError));
  });
  // V3: one dim tail line per turn; the list on ctrl+o (a display-only entry: never sent to the model)
  pi.on("agent_end", async (_e: any, ctx: any) => {
    try { (ctx?.ui ?? ui)?.setWorkingMessage?.(undefined); } catch { /* best effort */ }
    if (silent.length) { try { pi.appendEntry("hyprpi-quiet-tail", { checks: silent }); } catch { /* best effort */ } }
    silent = [];
  });
  pi.registerEntryRenderer?.("hyprpi-quiet-tail", (entry: any, opts: any, theme: any) => {
    const list: string[] = entry?.data?.checks ?? [];
    if (!list.length) return undefined;
    const head = `· ran ${list.length} check${list.length === 1 ? "" : "s"}${opts?.expanded ? "" : " · ctrl+o: list"}`;
    const rows: Array<[string, (t: string) => string]> = [[head, (t) => theme.fg("dim", t)]];
    if (opts?.expanded) for (const l of list) rows.push([`   ${l}`, (t) => theme.fg("dim", t)]);
    return lines(rows, 1);
  });
  pi.registerToolRenderer((toolName: string, next: () => any) => {
    const original = next(); // what pi (or the tool) would draw: used on ctrl+o
    const traffic = TRAFFIC[toolName];
    return {
      renderShell: "self",
      renderCall(args: any, theme: any, context: any) {
        if (context?.expanded && original?.renderCall) return original.renderCall(args, theme, context);
        const kind = toolKind(toolName, args ?? {});
        if (kind === "lookup") return new Container(); // lookups: nothing
        const c = context?.lastComponent instanceof OneLine ? context.lastComponent : new OneLine();
        c.setText(traffic ? traffic(args ?? {}) : changeLine(toolName, args ?? {}), (t: string) => theme.fg("dim", t));
        if (!traffic && context?.isError) return new Container(); // a change that failed: only the amber result line
        return c as any;
      },
      renderResult(result: any, options: any, theme: any, context: any) {
        if (options?.expanded && original?.renderResult) return original.renderResult(result, options, theme, context);
        const c = new Container();
        if (options?.isPartial) return c;
        const kind = toolKind(toolName, context?.args ?? {});
        if (kind === "lookup") return c; // a lookup, failed or not: nothing (harmless probe)
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
  const who = raw.match(/^\[report from (.+?) \(/)?.[1] || d.orch_child;
  const body = raw.replace(/^\[report from[^\n]*\]\n/, "").replace(/\n\n\((Done|Not finished)[^)]*\)\s*$/, "");
  return lines([[`↩ report from ${who}${d.orch_final ? " (final)" : ""} · ${brief(body, 200, who)}`, (t) => theme.fg("dim", t)]], 1);
}
