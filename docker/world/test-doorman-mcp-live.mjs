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
const [MCP, H, STEPS = "ask,message", STAY_MIN = "0", NAME = "J462Test"] = process.argv.slice(2); // J464: STAY_MIN > 0 keeps the agent joined after pi
const LOG = path.join(os.homedir(), ".hyprpi-g", "j464-live.log"), say = (t) => { console.log(t); try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${t}\n`); } catch { /* */ } };
const { connect } = await import(path.join(H, "lib", "client.mjs"));
const ID = NAME.toLowerCase().replace(/[^a-z0-9]/g, "-"), dir = fs.mkdtempSync(path.join(os.homedir(), ".hyprpi-g", "j462-")), agent = path.join(dir, "agent");
fs.mkdirSync(agent, { recursive: true });
const real = path.join(os.homedir(), ".pi", "agent");
for (const f of ["auth.json", "models.json"]) if (fs.existsSync(path.join(real, f))) fs.symlinkSync(path.join(real, f), path.join(agent, f));
let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(real, "settings.json"), "utf8")); } catch { /* */ }
fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify(Object.fromEntries(["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"].filter((k) => k in s).map((k) => [k, s[k]]))));
const env = Object.fromEntries(["HYPRPI_AGENT_ID", "HYPRPI_DROPBOX", "HYPRPI_INBOX", "HYPRPI_STATE", "HYPRPI_SOCKET", "G_HOST_HYPRPI"].map((k) => [k, `\${${k}}`]));
fs.writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { doorman: { command: "node", args: [MCP], env, exposure: "direct", timeout: 660 } } }));
const pushed = []; // talks this agent gets from Doorman-G (the mailbox's push); a host message is answered by replying to the talk
let c = null, decided = false;
c = await connect({ path: process.env.HYPRPI_SOCKET, onClose: () => {}, onEvent: (ev, d) => {
  if (ev !== "talk" || d?.from?.id !== "g-doorman") return;
  const t = String(d.text || ""); pushed.push(t); say(`PUSHED: ${t.replace(/\s+/g, " ").slice(0, 400)}`);
  if (/\(Answer it with the doorman tool reply/.test(t)) c.call("talk.reply", { request_id: d.request_id, text: `${NAME} got your message (J464 live test): RECEIVED-HOST` }).then(() => say("REPLIED to the host message by replying to the talk"), (e) => say(`reply failed: ${e.message}`));
  if (/Angus (approved|denied) your research request/.test(t)) decided = true;
} });
const me = await c.call("agent.hello", { agent_id: ID, name: NAME, icon: "🧪", pid: process.pid, cwd: dir, model: "test", acks: false, container: "world-g J462 test" });
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
await new Promise((x) => setTimeout(x, 5000));
if (Number(STAY_MIN) > 0) { say(`staying joined up to ${STAY_MIN} min, until the research is decided`); const until = Date.now() + Number(STAY_MIN) * 60000; while (!decided && Date.now() < until) await new Promise((x) => setTimeout(x, 5000)); say(decided ? "research decided: leaving" : "time up: leaving"); }
console.log(`--- pushed to this agent by Doorman-G (the mailbox): ${pushed.length} ---`); for (const t of pushed) console.log(t.replace(/\s+/g, " ").slice(0, 300));
c.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
