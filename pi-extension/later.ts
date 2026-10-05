/**
 * /notnow and /discuss (Angus 2026-10-02, brief J46, @hyprpi N100): think about an instruction
 * without implementing it, and file it on the project board for later.
 *
 *   /notnow TEXT   one turn: read it, think briefly, file a "later (not now)" Next item, reply in one line.
 *   /discuss TEXT  one turn too (J46 v2, Angus: "/discuss is also jsut one turn", no go / off): think it
 *                  through (issues, options, a rough plan, questions), file / update a "discussing" item.
 * The next message is ordinary work; to keep discussing, send /discuss again.
 *
 * "Don't implement" is enforced, not just asked: during that turn a tool_call guard lets only
 * read-only tools through (reads, searches, board/room/talk) and bash only for read-only commands;
 * anything else is blocked with a reason the model sees. The footer shows "🕒 not now" / "💬 discuss"
 * while the turn runs (status key "later"). Loaded by index.ts for hyprpi agent windows (filing needs the board).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "notnow" | "discuss" | null;


// Tools that only read or talk (board updates allowed: filing is the point).
const READ_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "board_read", "board_update", "project",
  "room_read", "room_post", "room_reply", "talk", "talk_reply", "demand",
  "web_search", "fetch_content", "get_search_content", "source_check",
  "vcc_recall", "jev_find_tools", "jev_find_skill", "jev_evaluate",
  "nim_usage", "nim_catalog", "whatsapp_chats", "whatsapp_read", "get_subagent_result",
]);

// Read-only shell commands (the first word of every segment of a pipeline / list).
const SAFE_CMDS = new Set([
  "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "find", "fd", "ls", "eza", "tree",
  "pwd", "cd", "echo", "printf", "wc", "sort", "uniq", "diff", "cmp", "comm", "file", "stat", "du", "df",
  "which", "whereis", "type", "whoami", "id", "date", "cal", "uptime", "ps", "free", "jq", "sed", "awk",
  "cut", "tr", "column", "nl", "paste", "fold", "fmt", "rev", "tac", "seq", "basename", "dirname",
  "realpath", "readlink", "strings", "od", "xxd", "hexdump", "md5sum", "sha256sum", "bat",
  "uname", "hostname", "nproc", "lscpu", "lsusb", "lspci", "lsblk", "true", "false", "test", "[", "sleep",
  "git", "hyprctl", "hyprpi", "curl", "systemctl", "journalctl", "pacman", "ip", "ss",
]);

/** Why a bash command isn't read-only, or "" if it is. */
export function bashBlockReason(command: string): string {
  const raw = String(command || "");
  if (/\$\(|`|<\(|>\(/.test(raw)) return "command substitution ($( ), backticks, <( )) isn't allowed";
  // Structure is checked with quoted text blanked out (a ">" or ";" inside a pattern is fine).
  const s = raw.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const noNull = s.replace(/\d?>&\d/g, " ").replace(/&>\s*\/dev\/null/g, " ").replace(/\d?>>?\s*\/dev\/null/g, " ");
  if (/>/.test(noNull)) return "writing to a file (>, >>) isn't allowed";
  if (/<</.test(s)) return "here-documents aren't allowed";
  for (const seg0 of noNull.split(/\|\||&&|[|;&\n]/)) {
    const seg = seg0.trim().replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "");
    if (!seg) continue;
    if (/^\w+=/.test(seg)) return `environment-prefixed commands aren't allowed (${seg.split(/\s+/)[0]})`;
    const words = seg.split(/\s+/), cmd = words[0].replace(/^.*\//, ""), rest = words.slice(1).join(" ");
    if (!SAFE_CMDS.has(cmd)) return `"${cmd}" isn't on the read-only list`;
    if (cmd === "find" && /(^|\s)-(exec|execdir|ok|okdir|delete|fprint\w*|fls)\b/.test(rest)) return "find -exec / -delete isn't allowed";
    if (cmd === "sed" && /(^|\s)(-i|--in-place|-[a-zA-Z]*i)/.test(rest)) return "sed -i isn't allowed";
    // Blink's holes (J46 v2 test): commands that write through an option or argument.
    if (cmd === "sed" && /(?:^|[;'"{}\s])[wW]\s*\S|\/[gpiIme0-9]*[wW]\s/.test(raw.slice(raw.indexOf("sed")))) return "sed's w command (write to a file) isn't allowed";
    if (cmd === "sort" && /(^|\s)(-o\S*|--output\S*|-[a-zA-Z]*o\S*)/.test(rest)) return "sort -o (write to a file) isn't allowed";
    if (cmd === "uniq" && words.slice(1).filter((w) => w && !w.startsWith("-")).length >= 2) return "uniq IN OUT (writes OUT) isn't allowed";
    if (cmd === "tree" && /(^|\s)(-o|--output)/.test(rest)) return "tree -o (write to a file) isn't allowed";
    if (cmd === "git" && /(^|\s)--output\b/.test(rest)) return "git --output (write to a file) isn't allowed";
    if (cmd === "journalctl" && /(^|\s)--(vacuum|rotate|flush|sync|relinquish|setup-keys|update-catalog)/.test(rest)) return "journalctl maintenance options aren't allowed";
    if (cmd === "awk" && /system\s*\(|\|\s*""|print\s*>/.test(raw)) return "awk system() / output redirection isn't allowed";
    if (cmd === "git" && !/^(-C\s+\S+\s+)?(--no-pager\s+)?(status|log|diff|show|grep|blame|ls-files|rev-parse)\b/.test(rest)) return `git ${words[1] || ""} isn't read-only here (status, log, diff, show, grep, blame, ls-files, rev-parse)`;
    if (cmd === "hyprctl" && !/^(-j\s+)?(clients|activewindow|activeworkspace|workspaces|monitors|cursorpos|version|devices|layers|binds)\b/.test(rest)) return "only hyprctl queries (clients, workspaces, monitors, …) are allowed";
    if (cmd === "hyprpi" && !/^(list|whoami|find|help)\b/.test(rest)) return "only hyprpi list / whoami / find / help are allowed";
    if (cmd === "curl" && /(^|\s)(-X|--request|-d|--data\S*|-F|--form|-T|--upload-file|-o|-O|--output|--remote-name)\b/.test(rest)) return "only plain curl GETs to stdout are allowed";
    if (cmd === "systemctl" && !/^(--user\s+)?(status|is-active|is-enabled|is-failed|list-units|list-timers|show|cat)\b/.test(rest)) return "only systemctl status / show / list-* are allowed";
    if (cmd === "pacman" && !/^-Q/.test(rest)) return "only pacman -Q… is allowed";
    if (cmd === "ip" && /\b(add|del|delete|set|flush|change|replace)\b/.test(rest)) return "only ip queries are allowed";
  }
  return "";
}

const LABEL: Record<string, string> = { notnow: "🕒 not now", discuss: "💬 discuss" };

export function laterModes(pi: ExtensionAPI) {
  let mode: Mode = null; // only for the one turn a /notnow or /discuss starts
  const show = (ctx: any) => { try { ctx?.ui?.setStatus?.("later", mode ? LABEL[mode] : undefined); } catch { /* no footer */ } };

  const fileIt = "file it with board_update (add, section next) on the card of the project it belongs to (the one you're on, else the best fit; " +
    "if none fits, your world's catch-all card: Loose jobs / inbox / misc / general)";
  const PROMPT: Record<string, (t: string) => string> = {
    notnow: (t) =>
      `[/notnow] Angus, NOT NOW, for later:\n«${t}»\n\n` +
      `Don't implement this. Read it and think briefly about what it would involve (you may read files to judge). Then ${fileIt}. ` +
      `Item text: \`later (not now): "<his words above, verbatim>" — <one or two lines on what it would take>\`. ` +
      `Then reply with ONE line saying where you filed it (@project and the handle). ` +
      `For this turn, tools that change files or the system are blocked (board updates, reads, searches and talk still work).`,
    discuss: (t) =>
      `[/discuss] Angus wants to DISCUSS this, not build it yet:\n«${t}»\n\n` +
      `Don't implement anything. Think it through in your reply: the issues, the options, ideas, a rough plan, and the questions you need answered. ` +
      `Then ${fileIt}; if this continues an earlier "discussing" item, edit that item instead of adding one. ` +
      `Item text: \`discussing: "<his words above, verbatim>" — plan gist: <one or two lines>\`. ` +
      `For this turn, tools that change files or the system are blocked (board updates, reads, searches and talk still work). ` +
      `What Angus means by /discuss (his words, 2026-10-04: "be intelligent and interpret what i mean like would be normal"): ` +
      `we are talking this through, the way two people would. It stays a discussion until something clearly tells you otherwise; ` +
      `his answers to your questions, his opinions and his "yes, that sounds good" are more discussion, not a go-ahead. ` +
      `Keep answering, refining the plan and editing the same "discussing" item; build nothing. If you're unsure whether he wants it built, ` +
      `ask him (you're welcome to ask "shall I build it?"). Don't make him repeat /discuss every turn, and don't add ceremony (no build commands or modes).`,
  };
  const DESC: Record<string, string> = {
    notnow: "Not now: the agent reads and briefly considers it, implements nothing, and files it on the project board for later (one turn)",
    discuss: "Discuss: the agent thinks it through (issues, options, plan, questions) and files it on the board, implementing nothing (one turn)",
  };
  for (const m of ["notnow", "discuss"] as const) {
    pi.registerCommand(m, {
      description: DESC[m],
      handler: async (args: any, ctx: any) => {
        const t = String(args ?? "").trim();
        if (!t) { ctx.ui.notify(`Usage: /${m} ${m === "notnow" ? "what to do later" : "what to think through"}`, "warning"); return; }
        if (!ctx.isIdle()) { ctx.ui.notify(`/${m}: the agent is busy; send it when it's idle (or Esc first)`, "warning"); return; }
        mode = m; show(ctx);
        pi.sendUserMessage(PROMPT[m](t));
      },
    });
  }

  pi.on("tool_call", async (e: any) => {
    if (!mode) return;
    const name = String(e?.toolName || ""), input = e?.input || {};
    let why = "";
    if (READ_TOOLS.has(name)) return;
    if (name === "bash") { why = bashBlockReason(String(input.command || "")); if (!why) return; }
    else if (name === "Agent" && /^(Explore|Plan)$/.test(String(input.subagent_type || "")) && !input.isolation) return;
    else if (name === "mcp" && !input.tool && !input.action) return; // status / search / describe only
    else why = `${name} can change files or the system`;
    return { block: true, reason: `Not done on purpose (/${mode} turn): ${why}. Nothing is implemented in a /${mode} turn; reads, searches, board updates and talk still work, so carry on without it.` };
  });

  // The turn is over (finished or Esc): back to normal.
  pi.on("agent_end", async (_e: any, ctx: any) => { if (mode) { mode = null; show(ctx); } });
  pi.on("session_start", async (_e: any, ctx: any) => { mode = null; show(ctx); });
}
