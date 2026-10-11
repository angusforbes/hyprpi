#!/usr/bin/env node
// J462 live test INSIDE world G (manual; run by docker/world/test-doorman-mcp-live.sh from the host): a temporary agent "J462Test" joins
// world G's inner daemon (this process, so its pid is the one the daemon knows), and a real `pi -p` started under it, with a private
// agent dir whose only MCP server is "doorman" (the given doorman-mcp.mjs), uses the tools against the real relay and Doorman-G.
//   node test-doorman-mcp-live.mjs <doorman-mcp.mjs> <hyprpi checkout> <steps: ask,message,research>
// Prints pi's answer and this agent's doorman-mcp state (what came back). The agent leaves when pi ends.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const [MCP, H, STEPS = "ask,message"] = process.argv.slice(2);
const { connect } = await import(path.join(H, "lib", "client.mjs"));
const ID = "j462-test", dir = fs.mkdtempSync(path.join(os.homedir(), ".hyprpi-g", "j462-")), agent = path.join(dir, "agent");
fs.mkdirSync(agent, { recursive: true });
const real = path.join(os.homedir(), ".pi", "agent");
for (const f of ["auth.json", "models.json"]) if (fs.existsSync(path.join(real, f))) fs.symlinkSync(path.join(real, f), path.join(agent, f));
let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(real, "settings.json"), "utf8")); } catch { /* */ }
fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify(Object.fromEntries(["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"].filter((k) => k in s).map((k) => [k, s[k]]))));
const env = Object.fromEntries(["HYPRPI_AGENT_ID", "HYPRPI_DROPBOX", "HYPRPI_INBOX", "HYPRPI_STATE", "HYPRPI_SOCKET", "G_HOST_HYPRPI"].map((k) => [k, `\${${k}}`]));
fs.writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { doorman: { command: "node", args: [MCP], env, exposure: "direct", timeout: 660 } } }));
const c = await connect({ path: process.env.HYPRPI_SOCKET, onEvent: () => {}, onClose: () => {} });
const me = await c.call("agent.hello", { agent_id: ID, name: "J462Test", icon: "🧪", pid: process.pid, cwd: dir, model: "test", acks: false, container: "world-g J462 test" });
console.log(`joined as ${me.name} (${me.agent_id})`);
const steps = STEPS.split(",");
const prompt = ["You are testing world G's doorman MCP tools. Do exactly these steps, each with the doorman tools, and report each tool's full result:",
  ...(steps.includes("ask") ? ["- ask_doorman with the question: \"J462 test: please reply with the single word PONG and nothing else; no request for Angus.\""] : []),
  ...(steps.includes("message") ? ["- message with to \"Doorman-G\" and text \"J462 test message: reply with the word RECEIVED; nothing else.\""] : []),
  ...(steps.includes("research") ? ["- research with the question \"How does damp-heat testing at 85 C and 85% humidity affect perovskite solar module encapsulation?\" (quick, not deep)"] : []),
  "- then call wait with seconds 120, and again with seconds 120 if the Doorman's replies haven't both come back yet; then inbox with all true.",
  "Report what each call returned. Don't do anything else."].join("\n");
const r = await new Promise((done) => {
  const ch = spawn("pi", ["-p", "--no-session", "--no-skills", "--no-context-files", "--no-approve", "--tools", "mcp__doorman__research,mcp__doorman__ask_doorman,mcp__doorman__message,mcp__doorman__reply,mcp__doorman__inbox,mcp__doorman__wait"],
    { cwd: dir, env: { ...process.env, HYPRPI_AGENT_ID: ID, G_HOST_HYPRPI: H, PI_CODING_AGENT_DIR: agent }, stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (out += d)); ch.stdin.end(prompt);
  const t = setTimeout(() => ch.kill("SIGTERM"), 600000); ch.on("exit", (code) => { clearTimeout(t); done({ code, out }); });
});
console.log(`--- pi (exit ${r.code}) ---\n${r.out.slice(-6000)}`);
const AG = path.join(process.env.HYPRPI_STATE, "doorman-mcp", "agents"), st = fs.readdirSync(AG).map((f) => path.join(AG, f)).find((f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")).owner === ID; } catch { return false; } });
try { if (!st) throw new Error("none for " + ID); const j = JSON.parse(fs.readFileSync(st, "utf8")); fs.unlinkSync(st); /* the test agent's state goes with it */ console.log("--- doorman-mcp state: notices ---"); for (const x of j.notices) console.log(`${x.n} [${x.kind}] ${x.text.replace(/\s+/g, " ").slice(0, 300)}`); } catch (e) { console.log(`no state (${e.message})`); }
c.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
