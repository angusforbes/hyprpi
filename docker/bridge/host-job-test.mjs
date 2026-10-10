#!/usr/bin/env node
// J432: the host-job test for world G, ready-made. Run it on the host:  node docker/bridge/host-job-test.mjs
// It checks the setup, prompts Alpha (inside G) to ask the Doorman for a host request that only a host agent can do
// (a new file in a folder that is NOT shared into G), waits for Angus's "1" in the Doorman-G window, and then confirms every hop:
//   draft held for the bridge -> approved -> claimed by <who> -> job done -> the file exists on the host with the exact text ->
//   G's gate delivered the outcome -> Alpha's session holds it as a visible message -> Alpha answered it.
// It decides nothing, changes nothing but the one new test file (made by the host agent), and prints PASS/FAIL per hop.
//   --no-send   don't prompt Alpha; print the prompt for you to paste into Alpha's window
//   --wait N    seconds to wait for your 1 (default 600)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const STATE = path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "hyprpi", "sbx-relay");
const H = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const args = process.argv.slice(2), has = (f) => args.includes(f), val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const WAIT = Number(val("--wait", 600)) * 1000;
const DIR = path.join(HOME, "Documents", "doorman-g-jobs");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(8, 14);
const FILE = path.join(DIR, `hello-from-g-${stamp}.md`), TEXT = `host-job test ${stamp}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, t = 30) => { try { return execFileSync("bash", ["-c", cmd], { encoding: "utf8", timeout: t * 1000, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return (e.stdout || "") + (e.stderr || ""); } };
// (G sees the live checkout at G_HOST_HYPRPI, written to host.env by world.sh; not necessarily this tree)
const inG = (cmd) => { try { return execFileSync("sbx", ["exec", "world-g", "bash", "-c", `. "$HOME/.hyprpi-g/host.env"; . "$G_HOST_HYPRPI/docker/world/g-env.sh"; ${cmd}`], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return (e.stdout || "") + (e.stderr || ""); } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const logLines = (from) => { let l = []; try { l = fs.readFileSync(path.join(STATE, "log.jsonl"), "utf8").split("\n").filter(Boolean); } catch { /* */ } return l.slice(from).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean); };
const t0 = () => new Date().toISOString().slice(11, 19);
let failed = 0, sessPath = "";
const ok = (m) => console.log(`${t0()}  PASS  ${m}`);
const bad = (m) => { failed++; console.log(`${t0()}  FAIL  ${m}`); };
const info = (m) => console.log(`${t0()}        ${m}`);
const step = (cond, pass, fail) => (cond ? ok(pass) : bad(fail)) || cond;


// Is the job's outcome in Alpha's own session as a visible message, and did Alpha answer it? (polls up to 80 s)
async function proveAlpha(jobId, from, tries = 40) {
  let answered = false;
  for (let i = 0; i < tries && !answered; i++) {
    if (i) await sleep(2000);
    const recv = inG(`python3 - <<'E'\nimport json\nout=[]\nfor i,l in enumerate(open(${JSON.stringify(sessPath)})):\n    if i<${from}: continue\n    d=json.loads(l)\n    if d.get('type')=='custom_message' and ${JSON.stringify(jobId)} in str(d.get('content')) and 'ended' in str(d.get('content')): out.append(['outcome',d.get('display'),i,d.get('timestamp','')[11:19]])\n    if d.get('type')=='message' and d['message'].get('role')=='assistant' and out and i>out[0][2]:\n        c=d['message'].get('content'); t=c if isinstance(c,str) else ' '.join(x.get('text','') for x in c if x.get('type')=='text')\n        if t.strip(): out.append(['answer',t[:140].replace('\\n',' '),i,d.get('timestamp','')[11:19]])\nprint(json.dumps(out))\nE`).trim().split("\n").pop();
    let r = []; try { r = JSON.parse(recv); } catch { /* */ }
    const o = r.find((x) => x[0] === "outcome"), an = r.find((x) => x[0] === "answer");
    answered = !!an;
    if (answered) { ok(`G's gate delivered the outcome to Alpha as a visible message (display: ${o[1]}, at ${o[3]}Z)`); ok(`Alpha answered it at ${an[3]}Z: "${an[1]}"`); }
    else if (i === tries - 1) { if (o) bad("Alpha received the outcome but has not answered it (it may be busy: look at Alpha's window)"); else bad("the outcome did NOT reach Alpha's session (gate delivery failed: see G's gate log, ~/.hyprpi-g/gate.log inside G)"); }
  }
}
// ---- 1. setup ----
console.log("J432 host-job test for world G\n");
const relayUp = sh("systemctl --user is-active hyprpi-sbx-relay.service").trim() === "active";
step(relayUp, "relay is running", "relay is NOT running (systemctl --user status hyprpi-sbx-relay)");
const doormanUp = sh("systemctl --user is-active hyprpi-doorman-doorman-g.service").trim() === "active";
step(doormanUp, "Doorman-G is running", "Doorman-G is NOT running");
const runnerOn = sh("systemctl --user is-active doorman-bridge-runner.path").trim() === "active";
const mode = readJson(path.join(STATE, "bridge", "mode.json"))?.sandboxes?.["world-g"];
info(`host agents for G: ${mode?.mode || "?"} ${JSON.stringify(mode?.agents || [])}`);
step(mode?.mode === "host agent available", "a host agent is available (a free-form request will not be refused)", "no host agent: the request would be refused as agent-free");
info(runnerOn ? "the per-job runner is installed: IT will claim and do the job (within a second of your 1). A Doorman-Host window, if open, gets nothing." : "no runner: a registered host agent such as Doorman-Host must claim the job itself");
const pend0 = fs.existsSync(path.join(STATE, "pending")) ? fs.readdirSync(path.join(STATE, "pending")) : [];
step(pend0.length === 0, "nothing else is held right now", `something is already held: ${pend0.join(", ")} (decide it first, then rerun)`);
fs.mkdirSync(DIR, { recursive: true });
step(!fs.existsSync(FILE), `the test file does not exist yet: ${FILE}`, `the test file already exists: ${FILE}`);
let alpha = {}; try { alpha = JSON.parse(inG("hyprpi list --json")); } catch { /* shown as "Alpha is not live" */ }
const agents = (alpha.agents || alpha || []);
const a = (Array.isArray(agents) ? agents : Object.values(agents)).find((x) => x && x.name === "Alpha");
step(!!a, `Alpha is live in G (${a?.id || "?"})`, "Alpha is not live in G (open it, then rerun)");
if (has("--check-alpha")) { // read-only: was an earlier job's outcome delivered to Alpha?  --check-alpha doorman-g--0ab4f2
  sessPath = (inG(`python3 - <<'E'\nimport json\nd=json.load(open('/home/agent/.hyprpi-g/state/agents.json'))\nprint(d['${a?.id}']['session'])\nE`).trim().split("\n").pop());
  failed = 0; await proveAlpha(val("--check-alpha", ""), 0, 1); process.exit(failed ? 1 : 0);
}
if (failed) { console.log("\nSetup problems above; nothing was started."); process.exit(1); }

// ---- 2. the prompt ----
const PROMPT = `Please ask the Doorman to draft a host request: create the file ${FILE} containing exactly: ${TEXT}`;
const logStart = fs.readFileSync(path.join(STATE, "log.jsonl"), "utf8").split("\n").filter(Boolean).length;
const alphaSession = () => inG(`python3 - <<'E'\nimport json\nd=json.load(open('/home/agent/.hyprpi-g/state/agents.json'))\nprint(d['${a.id}']['session'])\nE`).trim().split("\n").pop();
sessPath = alphaSession();
const sessLen0 = Number(inG(`wc -l < ${JSON.stringify(sessPath)}`).trim()) || 0;
if (has("--no-send")) { console.log(`\nPaste this into Alpha's window:\n\n${PROMPT}\n`); } else {
  const r = inG(`hyprpi send Alpha ${JSON.stringify(PROMPT)}`); info(`prompted Alpha: ${r.trim().slice(0, 100) || "sent"}`);
}

// ---- 3. watch the hops ----
const seen = {}; let cursor = logStart, jobId = "", claimer = "", told = false;
console.log(`\nNow waiting (up to ${WAIT / 1000} s). WHEN THE DOORMAN-G WINDOW SHOWS THE REQUEST, PRESS 1 THERE.\n`);
const until = Date.now() + WAIT;
while (Date.now() < until && !seen.done) {
  await sleep(2000);
  for (const e of logLines(cursor)) {
    cursor++;
    if (e.held && e.op === "talk" && /host-agent bridge/.test(JSON.stringify(e.to || "")) && !seen.held) { seen.held = e.held; jobId = e.held; ok(`Doorman-G drafted the request; held as ${e.held} for the host-agent bridge (not Thoughts-A)`); info("-> PRESS 1 in the Doorman-G window now"); }
    if (e.op === "host_job" && e.decision === "approved" && !seen.approved) { seen.approved = true; jobId = e.id || jobId; ok(`you approved it; host job ${jobId} created (waiting for a host agent)`); }
    if (e.op === "bridge" && e.req === "claim" && e.ok && !seen.claimed) { seen.claimed = true; claimer = e.by; ok(`claimed by ${claimer}`); }
    if (e.op === "host_job" && e.state === "done" && !seen.done) { seen.done = true; ok(`the host agent reported the job done: ${String(e.outcome || "").slice(0, 120)}`); }
    if (e.op === "host_job" && e.state === "failed") { seen.failed = true; bad(`the job FAILED: ${String(e.outcome || "").slice(0, 200)}`); seen.done = true; }
  }
}
if (!seen.held) bad("the Doorman never drafted the request (Alpha or the Doorman may have declined: read Alpha's window)");
else if (!seen.approved) bad("not approved within the wait time (press 1 in the Doorman-G window, then rerun)");
if (seen.done && !seen.failed) {
  // ---- 4. the proof ----
  const exists = fs.existsSync(FILE) && fs.readFileSync(FILE, "utf8").trim() === TEXT;
  step(exists, `the file exists on the host with the exact text: ${FILE}`, `the file is missing or its text differs: ${FILE}`);
  await proveAlpha(jobId, sessLen0);
}
console.log(failed ? `\nRESULT: ${failed} step(s) FAILED. Details above.` : `\nRESULT: PASS. The request went from Alpha through the Doorman and your 1 to ${claimer}, the file was made on the host, and Alpha showed the outcome.`);
process.exit(failed ? 1 : 0);
