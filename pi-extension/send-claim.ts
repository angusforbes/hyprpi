// J704 (Angus: 78a): an agent may say it "sent", "posted", "emailed" … only when a send tool actually ran successfully;
// otherwise it says "drafted". Enforced here, not just in the prompt: at the end of every agent run the assistant's
// text is scanned for a first-person / passive send claim; if no send tool ran OK in that run (or, for "earlier" /
// "already" claims, in the session), a visible amber line is shown and the agent gets one nudge to correct itself.
// It never blocks or alters a send. Off with HYPRPI_SEND_CLAIM=0. Pure helpers are exported for the test.
const DRAFT_OR_READ = /(^|_)(draft|get|list|search|find|read|lookup|history|my|is)(_|$)/;
const SEND_NAME = /(^|_)(send|post|reply|forward|publish|schedule|add_reaction|react)(_|$)/;
const OWN_TOOLS = new Set(["talk", "talk_reply", "demand", "room_post", "room_reply", "mail_send", "report_to_parent", "subagent_send", "steer_subagent", "steer_agent"]);

// Which tool calls count as a real send. Bash: the commands that put text in front of someone else.
export function isSendCall(tool: string, args: any): boolean {
  const name = String(tool || "");
  if (OWN_TOOLS.has(name)) return true;
  if (name.startsWith("mcp__")) {
    const tail = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
    return SEND_NAME.test(tail) && !DRAFT_OR_READ.test(tail.replace(/(^|_)(reply|replies)(_|$)/, "$1$3"));
  }
  if (name === "bash") {
    const c = String(args?.command ?? "");
    return /\bgh\s+(issue|pr)\s+(comment|create|edit|review|close|reopen)\b/.test(c)
      || /\bgh\s+api\b[^|;&]*(-X|--method)\s*(POST|PUT|PATCH)\b/i.test(c)
      || /\bcurl\b[^|;&]*(ntfy|hooks\.slack|discord(app)?\.com\/api\/webhooks)[^|;&]*(-d|--data|-X\s*POST|-H)/i.test(c)
      || /\bcurl\b[^|;&]*(-d|--data|-X\s*POST)[^|;&]*(ntfy|hooks\.slack)/i.test(c)
      || /\bhyprpi\s+(say|post|prompt|room-post|talk|send|thoughts|reply|tell|ask)\b/.test(c)
      || /\b(site-put|notify-send|ding|bonk)\b/.test(c)
      || /\bgit\s+push\b/.test(c);
  }
  return false;
}

const VERB = "sent|posted|emailed|e-mailed|mailed|messaged|published|replied|forwarded|slacked|dm'?d";
// First-person ("I sent", "I've posted", "we emailed"), a leading "Sent …"/"Posted in room", or passive ("the email was sent",
// "has been posted") — not "Pocket sent me", "when it's sent", "not sent", "will send", "draft to be sent".
const FIRST = new RegExp(`\\b(?:I|I've|I have|I'd|we|we've|we have|just|now|already|then|and)\\s+(?:(?:also|just|now|already|have|successfully|then)\\s+)*(?:${VERB})\\b`, "i");
const LEAD = new RegExp(`(?:^|[.!?:]\\s+|\\n\\s*(?:[-*•]\\s*)?)(?:\\*\\*)?(?:${VERB})(?:\\*\\*)?(?=\\s+(?:to|in|on|via|it|the|your|an?|that|this|them|him|her|\\(|#|[—–-]|:|\\.|$)|[.!:]|$)`, "i");
const PASSIVE = new RegExp(`\\b(?:email|e-mail|message|reply|comment|post|note|dm|report|review|issue|pr|it|that|they|both|all|everything)\\s+(?:was|were|has been|have been|is now|are now|got)\\s+(?:successfully\\s+)?(?:${VERB})\\b`, "i");
const NEGATED = /\b(?:not|n't|never|no|nothing|none|without|unable to|couldn't|can't|cannot|didn't|haven't|hasn't|wasn't|isn't|yet to|if|whether|unless|once|when|until|before|should be|to be|will be|would be|can be|could be|must be|needs? to be|ready to be|not yet|drafted?)\s+(?:\w+\s+){0,2}$/i;
const EARLIER = /\b(already|earlier|previously|before|yesterday|last (?:turn|time|week|night)|ago|had been)\b/i;

function stripCode(t: string): string {
  return t.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/^\s*>.*$/gm, " ").replace(/"[^"\n]{0,300}"/g, " ").replace(/“[^”\n]{0,300}”/g, " ");
}

// the claims in a text: [{sentence, earlier}]
export function findClaims(text: string): Array<{ sentence: string; earlier: boolean }> {
  const out: Array<{ sentence: string; earlier: boolean }> = [];
  const clean = stripCode(String(text ?? ""));
  for (const sentence of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s || /\?\s*$/.test(s)) continue;
    for (const re of [FIRST, LEAD, PASSIVE]) {
      const g = new RegExp(re.source, "gi");
      let m: RegExpExecArray | null;
      let hit = false;
      while ((m = g.exec(s))) {
        const before = s.slice(0, m.index + (m[0].search(new RegExp(`(?:${VERB})`, "i")) < 0 ? 0 : m[0].search(new RegExp(`(?:${VERB})`, "i"))));
        if (NEGATED.test(before.slice(-40))) continue;
        hit = true; break;
      }
      if (hit) { out.push({ sentence: s.slice(0, 160), earlier: EARLIER.test(s) }); break; }
    }
  }
  return out;
}

export function assess(texts: string[], sentThisRun: boolean, sentEarlier: boolean) {
  if (sentThisRun) return { flagged: false, claims: [] as string[] };
  const claims = texts.flatMap((t) => findClaims(t)).filter((c) => !(c.earlier && sentEarlier)).map((c) => c.sentence);
  return { flagged: claims.length > 0, claims };
}

export const CORRECTION = (claims: string[]) =>
  `⚠ not sent: no send tool ran successfully this turn, yet you wrote: “${claims[0]}”. Nothing reached anyone. Say "drafted" (or actually send it, with Angus's OK where required) and correct that in one short line.`;

export function sendClaim(pi: any, env: NodeJS.ProcessEnv = process.env) {
  if (env.HYPRPI_SEND_CLAIM === "0") return;
  const calls = new Map<string, boolean>(); // toolCallId -> is a send call
  let sentRun = false, sentSession = false, correcting = false;
  pi.on("agent_start", async () => { sentRun = false; calls.clear(); });
  pi.on("tool_call", async (e: any) => { try { calls.set(String(e?.toolCallId), isSendCall(String(e?.toolName), e?.input ?? e?.args)); } catch { /* never block a tool */ } return undefined; });
  pi.on("tool_execution_end", async (e: any) => { if (calls.get(String(e?.toolCallId)) && !e?.isError) { sentRun = true; sentSession = true; } });
  pi.on("agent_end", async (e: any, ctx: any) => {
    const msgs: any[] = Array.isArray(e?.messages) ? e.messages : [];
    const texts = msgs.filter((m) => (m?.role ?? m?.message?.role) === "assistant").map((m) => {
      const c = m?.content ?? m?.message?.content;
      return Array.isArray(c) ? c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : String(c ?? "");
    });
    const wasCorrecting = correcting; correcting = false;
    const r = assess(texts, sentRun, sentSession);
    if (!r.flagged) return;
    const msg = CORRECTION(r.claims);
    try { (ctx?.ui ?? undefined)?.notify?.(msg, "warning"); } catch { /* best effort */ }
    if (wasCorrecting) return; // one nudge per claim: no loops
    correcting = true;
    setTimeout(() => { try { pi.sendMessage({ customType: "hyprpi-sendcheck", content: msg, display: true }, { triggerTurn: true }); } catch { correcting = false; } }, 50);
  });
}
