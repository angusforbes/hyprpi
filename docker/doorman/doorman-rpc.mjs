#!/usr/bin/env node
// J373 (Angus chose a stateless Doorman): runs the Doorman's pi (RPC mode) and starts a NEW pi session after every turn, so each
// message the drop-box extension hands it is answered in a fresh session that holds only that message and what the relay sent
// with it (docker/doorman/history.mjs). Nothing carries over from one message to the next inside pi.
//
//   DOORMAN_PIRUN='sbx exec -i … pi --mode rpc …' doorman-rpc.mjs     (doorman.sh sets it; stdout = pi's RPC events, unchanged)
//
// It keeps pi's stdin open (as `tail -f /dev/null` did) and writes only {"type":"new_session"} to it, once a turn has settled
// (agent_settled: pi won't continue on its own). It exits with pi, so the unit restarts both.
import { spawn } from "node:child_process";
import readline from "node:readline";

const cmd = process.env.DOORMAN_PIRUN;
if (!cmd) { console.error("doorman-rpc: DOORMAN_PIRUN is not set"); process.exit(2); }
const child = spawn("bash", ["-c", cmd], { stdio: ["pipe", "pipe", "inherit"] });
// Fail closed (review: StatelessReview): a new_session that pi refuses or cancels, or doesn't confirm within 15 s, ends pi (and this
// controller), so the unit restarts it: a restart is a fresh session too. The extension does the same from its side if no new session
// comes after a turn (sbx-dropbox-ext.ts), so a message is never answered in a session that already held another.
let n = 0; const want = new Map();
const die = (why) => { console.error(`doorman-rpc: ${why}; ending pi so the unit restarts it fresh`); try { child.kill("SIGTERM"); } catch { /* */ } setTimeout(() => process.exit(1), 2000).unref(); };
const fresh = () => {
  if (child.stdin.destroyed) return;
  const id = `doorman-fresh-${++n}`;
  want.set(id, setTimeout(() => die(`new session ${id} wasn't confirmed`), 15000));
  child.stdin.write(JSON.stringify({ type: "new_session", id }) + "\n");
};
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  process.stdout.write(line + "\n");
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev?.type === "agent_settled") fresh();
  else if (ev?.type === "response" && ev.command === "new_session" && want.has(ev.id)) {
    clearTimeout(want.get(ev.id)); want.delete(ev.id);
    if (!ev.success || ev.data?.cancelled) die(`new session ${ev.id} was ${ev.success ? "cancelled" : "refused"}`);
  }
});
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { try { child.kill(s); } catch { /* */ } });
process.stdout.on("error", () => { try { child.kill("SIGTERM"); } catch { /* */ } process.exit(1); }); // the logger went away: end, so the unit restarts both
