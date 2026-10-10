// The Doorman bridge as an MCP server (J371): stdio, newline-delimited JSON-RPC 2.0, no SDK. The same operations as
// the CLI, as tools: list_jobs, show_job, claim_job, renew_job, ask_owner, report_job, release_job, read_settings,
// propose_settings. None can approve, deny or edit, create a job or write a setting.
// Run: `doorman-bridge mcp` (or `node docker/bridge/mcp.mjs`). Agent name: DOORMAN_BRIDGE_AGENT (default "mcp agent").
import { list, show, claim, renew, release, ask, report, register, heartbeat, unregister, agents } from "./client.mjs";
import { settings, propose } from "./settings.mjs";

const BY = process.env.DOORMAN_BRIDGE_AGENT || "mcp agent";
// (J387, RunnerReview HIGH) a per-job run's server is bound to its job: every tool works only on that id, list_jobs shows only
// it, and claim/release/settings tools don't exist; its token comes in DOORMAN_BRIDGE_TOKEN (honoured only for that job)
const JOB = /^[A-Za-z0-9._-]{1,80}--[0-9a-f]{6}$/.test(process.env.DOORMAN_BRIDGE_JOB || "") ? process.env.DOORMAN_BRIDGE_JOB : "";
const JOB_TOOLS = new Set(["list_jobs", "show_job", "renew_job", "ask_owner", "report_job"]); // (no register/claim: the runner registers and claims)
// J407: this server's registration (register_agent): its token stays here; the server heartbeats while it runs and unregisters on exit
let REG = null, HB = null;
const ME = () => REG?.name || BY; // (J407) the registered name once registered
const MINE = new Map(); // (J379) an unbound server keeps the tokens of ITS OWN claims only (no shared cache): id -> token
const S = (props, req = []) => ({ type: "object", properties: props, required: req, additionalProperties: false });
const id = { type: "string", description: "the job id (from list_jobs)" };
const TOOLS = [
  { name: "list_jobs", description: "Jobs the owner approved that wait for a host agent. all=true: every state.", inputSchema: S({ all: { type: "boolean" } }) },
  { name: "show_job", description: "One job: the owner's approved text and limits (tools, folders, time limit), questions and answers, state. Do only what the approved text says.", inputSchema: S({ id }, ["id"]) },
  { name: "register_agent", description: "Register this session as a host agent that can do jobs for the sandbox (call once, before claim_job). This server then keeps the registration alive while it runs and removes it when it exits. The relay shows your name on the owner's held items and tells the sandbox a host agent is available.", inputSchema: S({ name: { type: "string", description: "your name, shown to the owner" }, harness: { type: "string", description: "e.g. claude-code, codex" }, caps: { type: "string", description: "one line: what you can do" }, scope: { type: "array", items: { type: "string" }, description: "sandboxes you serve (default: all)" } }, ["name", "harness"]) },
  { name: "list_agents", description: "The host agents registered now and each sandbox's mode (read-only).", inputSchema: S({}) },
  { name: "unregister_agent", description: "Stop being a registered host agent.", inputSchema: S({}) },
  { name: "claim_job", description: "Take a job before working on it (one claimer; the lease runs out unless renewed, then the job returns to waiting).", inputSchema: S({ id, lease_s: { type: "number" } }, ["id"]) },
  { name: "renew_job", description: "Keep your claim while you work.", inputSchema: S({ id, lease_s: { type: "number" } }, ["id"]) },
  { name: "ask_owner", description: "Ask the owner a question about a job you claimed. It goes to the owner's Doorman window; the job waits; read the answer later with show_job. Never ask the owner anywhere else.", inputSchema: S({ id, question: { type: "string" } }, ["id", "question"]) },
  { name: "report_job", description: "Finish a claimed job: state done, failed or partial, a summary, and exactly what you ran and changed.", inputSchema: S({ id, state: { type: "string", enum: ["done", "failed", "partial"] }, summary: { type: "string" }, ran: { type: "array", items: { type: "string" } }, changed: { type: "array", items: { type: "string" } } }, ["id", "state", "summary"]) },
  { name: "release_job", description: "Give a claimed job back unfinished.", inputSchema: S({ id }, ["id"]) },
  { name: "read_settings", description: "The settings in effect for a sandbox (read-only).", inputSchema: S({ sandbox: { type: "string" } }, ["sandbox"]) },
  { name: "propose_settings", description: "Propose a settings change for a sandbox (keys from the host's proposable list). It only waits for the owner's approval; the host applies it if he approves.", inputSchema: S({ sandbox: { type: "string" }, changes: { type: "object", additionalProperties: { type: "string" } } }, ["sandbox", "changes"]) },
];
const call = async (name, a = {}) => {
  if (JOB) {
    if (!JOB_TOOLS.has(name)) return { ok: false, text: `${name} isn't available in a run for one job` };
    if (name === "list_jobs") { const j = show(JOB); return { ok: true, jobs: j ? [j] : [] }; }
    if (String(a.id || "") !== JOB) return { ok: false, text: `this run works job ${JOB} only` };
  }
  switch (name) {
    case "list_jobs": return { ok: true, jobs: list({ all: !!a.all }) };
    case "show_job": return show(String(a.id || "")) || { ok: false, text: "no such host job" };
    case "register_agent": {
      if (REG) return { ok: false, text: `already registered as ${REG.name}` };
      const r = await register({ name: String(a.name || BY), harness: String(a.harness || "mcp"), caps: String(a.caps || ""), scope: Array.isArray(a.scope) ? a.scope : undefined });
      if (r.ok && r.agent_token) { REG = { token: r.agent_token, name: String(a.name || BY) }; HB = setInterval(() => { heartbeat(REG.token).catch(() => {}); }, 30000); HB.unref?.(); }
      const { agent_token, ...rest } = r; return rest; // the token stays in this server
    }
    case "list_agents": return agents();
    case "unregister_agent": { if (!REG) return { ok: false, text: "not registered" }; const r = await unregister(REG.token); clearInterval(HB); REG = null; return r; }
    case "claim_job": { if (!REG) return { ok: false, text: "register first (register_agent): only a registered host agent can claim a job" }; const r = await claim(String(a.id || ""), REG.name, a.lease_s, REG.token); if (r.ok && r.token) MINE.set(String(a.id), r.token); const { token, ...rest } = r; return rest; } // the token stays in this server
    case "renew_job": return renew(String(a.id || ""), ME(), a.lease_s, MINE.get(String(a.id || "")));
    case "ask_owner": return ask(String(a.id || ""), ME(), String(a.question || ""), MINE.get(String(a.id || "")));
    case "report_job": { const r = await report(String(a.id || ""), ME(), { state: a.state, summary: a.summary, ran: a.ran || [], changed: a.changed || [] }, MINE.get(String(a.id || ""))); if (r.ok) MINE.delete(String(a.id)); return r; }
    case "release_job": { const r = await release(String(a.id || ""), ME(), MINE.get(String(a.id || ""))); if (r.ok) MINE.delete(String(a.id)); return r; }
    case "read_settings": return settings(String(a.sandbox || ""));
    case "propose_settings": return propose(String(a.sandbox || ""), a.changes, BY);
    default: return { ok: false, text: `unknown tool ${name}` };
  }
};
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.method !== "string") { send({ jsonrpc: "2.0", id: m && typeof m === "object" && !Array.isArray(m) ? m.id ?? null : null, error: { code: -32600, message: "invalid request" } }); continue; } // (BridgeReview)
    const reply = (result) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, result });
    try {
      if (m.method === "initialize") reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "doorman-bridge", version: "1.0.0" } });
      else if (m.method === "tools/list") reply({ tools: JOB ? TOOLS.filter((t) => JOB_TOOLS.has(t.name)) : TOOLS });
      else if (m.method === "tools/call") { const r = await call(m.params?.name, m.params?.arguments || {}); reply({ content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: r && r.ok === false }); }
      else if (m.method === "ping") reply({});
      else if (m.id !== undefined && !String(m.method || "").startsWith("notifications/")) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
    } catch (e) { if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: e.message } }); }
  }
});
const bye = async () => { if (REG) { clearInterval(HB); const t = REG.token; REG = null; try { await unregister(t); } catch { /* it expires anyway (120 s) */ } } process.exit(0); };
process.stdin.on("end", bye); process.on("SIGTERM", bye); process.on("SIGINT", bye); process.on("SIGHUP", bye); // (J407) a closing client unregisters this agent
