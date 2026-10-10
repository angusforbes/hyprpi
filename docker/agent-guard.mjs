// J372: the one "is this a real owner terminal?" guard, shared by the relay's approve CLI (decideAsAngus) and the gateway settings admin command.
// Accident prevention, not authentication (a same-user process can still write the files): it refuses a process that has a tty-less stdin or any
// agent / pi ancestor, so a well-behaved agent can't change settings or approve things by calling the command.
import fs from "node:fs";
export function agentAncestor() {
  if (process.env.HYPRPI_AGENT_ID || process.env.PI_CODING_AGENT || process.env.PI_SESSION_FILE || process.env.HYPRPI_THOUGHTS_ROOM) return "called from an agent"; // (J274: Thoughts too)
  let pid = process.ppid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    let env = "", stat = "", comm = "";
    // J274: the user's systemd manager (the root of every desktop process) can't be read (not dumpable) and is
    // no agent: stop there. Before this, every panel and terminal under it failed closed ("can't check").
    try { if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] === "/usr/lib/systemd/systemd" && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[1] === "--user") return ""; } catch { /* checked below */ }
    try { env = fs.readFileSync(`/proc/${pid}/environ`, "utf8"); stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return `can't check process ${pid}`; } // fail closed
    if (/(^|\0)(HYPRPI_AGENT_ID|PI_CODING_AGENT|PI_SESSION_FILE|HYPRPI_THOUGHTS_ROOM)=/.test(env) || comm === "pi" || comm === "script") return `under an agent (pid ${pid})`;
    pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0;
  }
  if (pid > 1) return "its ancestry is too deep to check (J372 review: running out of levels must refuse, not pass)"; // fail closed
  return "";
}

// "" when this process may act as the owner; else why not.
export function ownerTtyProblem() { const why = agentAncestor(); return why || (!process.stdin.isTTY ? "no terminal" : ""); }
