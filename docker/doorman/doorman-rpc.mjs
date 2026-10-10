#!/usr/bin/env node
// J373 (Angus chose a stateless Doorman): runs the Doorman's pi (RPC mode) and starts a NEW pi session after every turn, so each
// message the drop-box extension hands it is answered in a fresh session that holds only that message and what the relay sent
// with it (docker/doorman/history.mjs). Nothing carries over from one message to the next inside pi.
//
//   DOORMAN_PIRUN='sbx exec -i … pi --mode rpc …' doorman-rpc.mjs     (doorman.sh sets it; stdout = pi's RPC events, unchanged)
//
// It keeps pi's stdin open (as `tail -f /dev/null` did) and writes only {"type":"new_session"} to it, once a turn has settled
// (agent_settled; agent_end as a fallback when a pi build has no agent_settled). It exits with pi, so the unit restarts both.
import { spawn } from "node:child_process";
import readline from "node:readline";

const cmd = process.env.DOORMAN_PIRUN;
if (!cmd) { console.error("doorman-rpc: DOORMAN_PIRUN is not set"); process.exit(2); }
const child = spawn("bash", ["-c", cmd], { stdio: ["pipe", "pipe", "inherit"] });
let settledSeen = false, pending = null, n = 0;
const fresh = (why) => {
  if (child.stdin.destroyed) return;
  child.stdin.write(JSON.stringify({ type: "new_session", id: `doorman-fresh-${++n}` }) + "\n");
  if (process.env.DOORMAN_RPC_DEBUG) console.error(`doorman-rpc: new session (${why})`);
};
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  process.stdout.write(line + "\n");
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev?.type === "agent_settled") { settledSeen = true; clearTimeout(pending); pending = null; fresh("settled"); }
  else if (ev?.type === "agent_end" && !settledSeen) { clearTimeout(pending); pending = setTimeout(() => { pending = null; fresh("agent_end"); }, 3000); }
  else if (ev?.type === "agent_start") { clearTimeout(pending); pending = null; } // pi carried on (retry, follow-up): not yet
});
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { try { child.kill(s); } catch { /* */ } });
process.stdout.on("error", () => { try { child.kill("SIGTERM"); } catch { /* */ } process.exit(1); }); // the logger went away: end, so the unit restarts both
