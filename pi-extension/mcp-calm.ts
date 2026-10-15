// J653 (Angus: "Stop the startup warning from flagging a short MaaS outage, since pi reconnects on the next call
// anyway"). pi's MCP startup (builtin:mcp, reportProblems) shows an amber "MCP servers need attention" warning for
// every server that didn't connect. When a server failed only because the network hiccuped (socket closed, timeout,
// connection refused/reset, DNS, 502/503/504), its line becomes one dim status line naming it, and this extension
// reconnects it quietly in the background. Real problems (sign-in needed, auth errors, bad config, a command that
// doesn't start) keep pi's warning, unchanged.
//
// Why the background reconnect: pi does NOT retry a server that failed at startup on its own. Its deferred tools were
// never listed, so tool_search can't find them and nothing ever calls getClient() again (checked on pi 1.0.2: 63
// tool_search calls, no new connection). So we run pi's own `/mcp reconnect <name>` (via sendUserMessage with
// expandPromptTemplates, which runs an extension command without a model turn) after 20 s, 1, 3, 10 and 30 min, and
// at the start of each user prompt (waiting up to 10 s for it), until the server connects.
//
// How the warning is caught: the shared extension UI object (ctx.ui, one per runner, used by every extension
// including the builtins) gets its notify wrapped once per session. Only "MCP servers need attention:" warnings and
// the messages of our own reconnects are touched; everything else passes through as it was.
const TRANSIENT = /socket connection was closed|unable to connect|socket hang up|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|getaddrinfo|fetch failed|timed? ?out|connection (refused|reset|closed|lost)|network|unreachable|\b50[234]\b|bad gateway|service unavailable|gateway time/i;
const REAL = /needs? (sign-?in|auth)|unauthori[sz]ed|forbidden|\b40[13]\b|invalid|token|oauth|config|ENOENT|EACCES|spawn|not found: |command/i;
const PROMPT_WAIT_MS = 10_000;
const RETRY_MS = [20_000, 60_000, 180_000, 600_000, 1_800_000];

export const isTransient = (why: string) => TRANSIENT.test(why) && !REAL.test(why);

export function splitMcpWarning(message: string): { transient: string[]; rest: string[] } | null {
  const m = /^MCP servers need attention:\n([\s\S]*?)(\nRun \/mcp to fix\.)?\s*$/.exec(String(message ?? ""));
  if (!m) return null;
  const transient: string[] = [], rest: string[] = [];
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(": ");
    const name = i > 0 ? line.slice(0, i) : "";
    const why = i > 0 ? line.slice(i + 2) : line;
    if (name && name !== "config" && isTransient(why)) transient.push(name);
    else rest.push(line);
  }
  return { transient, rest };
}

const warning = (lines: string[]) => `MCP servers need attention:\n${lines.map((l) => `  ${l}`).join("\n")}\nRun /mcp to fix.`;
const MARK = Symbol.for("hyprpi.mcpCalm");

export function mcpCalm(pi: any, opts: { retryMs?: number[] } = {}) {
  const retryMs = opts.retryMs ?? RETRY_MS;
  // name -> retries so far, its next timer, and when our last `/mcp reconnect` for it was sent (its notifies are ours)
  const pending = new Map<string, { tries: number; timer?: ReturnType<typeof setTimeout>; sentAt?: number; waiting?: boolean; done?: () => void; answered?: Promise<void> }>();
  let live = false;
  const OURS_MS = 120_000; // pi's reconnect (its own connect retries + timeout) answers well within this

  const clear = () => { for (const p of pending.values()) if (p.timer) clearTimeout(p.timer); pending.clear(); };
  const schedule = (name: string) => {
    const p = pending.get(name);
    if (!p || !live) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = undefined;
    if (p.tries >= retryMs.length) return; // timers given up; a user prompt still retries
    p.timer = setTimeout(() => { p.timer = undefined; retry(name); }, retryMs[p.tries]);
    (p.timer as any)?.unref?.();
  };
  // pi.sendUserMessage doesn't wait for the command, so the answer comes back through notify (see wrapped below).
  const retry = (name: string) => {
    const p = pending.get(name);
    if (!p || !live) return;
    if (p.waiting && Date.now() - (p.sentAt ?? 0) < OURS_MS) return; // one in flight already
    if (p.timer) { clearTimeout(p.timer); p.timer = undefined; }
    p.tries++;
    p.sentAt = Date.now();
    p.waiting = true;
    p.answered = new Promise<void>((resolve) => { p.done = resolve; });
    try { pi.sendUserMessage(`/mcp reconnect ${name}`, { expandPromptTemplates: true }); }
    catch { p.waiting = false; p.done?.(); schedule(name); /* busy (compaction): try again later */ }
  };

  pi.on("session_start", async (_e: any, ctx: any) => {
    live = true;
    clear();
    const ui = ctx?.ui;
    if (!ui || typeof ui.notify !== "function" || ui.notify[MARK]) return;
    const orig = ui.notify.bind(ui);
    const wrapped = (message: string, type?: string) => {
      const text = String(message ?? "");
      const ours = (/^(?:Reconnected to MCP server|MCP server) "([^"]+)"/.exec(text) || [])[1];
      const p = ours !== undefined ? pending.get(ours) : undefined;
      if (ours && p?.waiting && Date.now() - (p.sentAt ?? 0) < OURS_MS) { // only the answer to our own reconnect
        p.waiting = false;
        p.done?.();
        if (text.startsWith("Reconnected")) {
          if (p.timer) clearTimeout(p.timer);
          pending.delete(ours);
          return orig(`MCP: ${ours} connected`, "info");
        }
        if (type === "error") {
          const why = text.replace(/^MCP server "[^"]+"\s*/, ""); // the server's name is not evidence (token-api, config-x)
          if (isTransient(why)) { schedule(ours); return; } // still down: stay quiet, try again later
          if (p.timer) clearTimeout(p.timer);
          pending.delete(ours); // now a real problem (sign-in, config): pi's own warning, in full
          return orig(warning([`${ours}: ${text}`]), "warning");
        }
      }
      const s = type === "warning" ? splitMcpWarning(text) : null;
      if (!s || !s.transient.length) return orig(message, type);
      for (const name of s.transient) if (!pending.has(name)) { pending.set(name, { tries: 0 }); schedule(name); }
      orig(`MCP: ${s.transient.join(", ")} not reachable at startup (network); reconnecting in the background`, "info");
      if (s.rest.length) orig(warning(s.rest), "warning");
    };
    (wrapped as any)[MARK] = true;
    try { ui.notify = wrapped; } catch { /* a frozen UI object: leave pi's warning as it is */ }
  });
  // A user prompt is the "next call": try any server still down before the model needs its tools (not awaited).
  // Waits up to PROMPT_WAIT_MS, like pi's own wait for direct servers, so the model's first call can find the tools.
  pi.on("before_agent_start", async () => {
    if (!pending.size) return;
    const answers = [...pending.keys()].map((name) => { retry(name); return pending.get(name)?.answered; }).filter(Boolean);
    let timer: any;
    await Promise.race([Promise.all(answers), new Promise((r) => { timer = setTimeout(r, PROMPT_WAIT_MS); })]);
    clearTimeout(timer);
  });
  pi.on("session_shutdown", async () => { live = false; clear(); });
}
