#!/usr/bin/env node
// J663 (no silent success): report_to_parent says what really happened (lib/orch.mjs report()). The parent is a stand-in send seam.
//  O1 parent connected: "to your parent as a message (handed to its window)"
//  O2 parent NOT connected: "kept, and given to it when it reconnects" (it used to say "to your parent as a message"), and it is
//     given on redeliver
//  O3 a closing child's progress note: says it isn't sent (it used to claim "to your parent as a message")
//   node test/run.mjs test/msg-orch-report.mjs   (exit 0 = pass)
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
import { createOrch } from "../lib/orch.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j663o-"));
const kid = (id) => ({ id, name: id, parent: "hp-mom", parentName: "Mom", room: "B", prompt: "x", model: "m", thinking: "", budget: {}, used: { tokens: 0 }, startedAt: Date.now(), status: "running", reports: [], escalations: 0, depth: 1 });
fs.writeFileSync(path.join(T, "orch.json"), JSON.stringify({ children: { k1: kid("k1"), k2: kid("k2"), k3: { ...kid("k3"), status: "closing" } } }));
const sent = []; let connected = true;
const orch = createOrch({ stateDir: T, deps: { send: (to, ev, d) => { if (!connected) return false; sent.push({ to, ev, d }); return true; }, note: () => {}, liveAgent: () => null, agentName: () => "", thoughtsReport: () => {}, roomOf: () => "B" } });
const r1 = orch.report("k1", { text: "progress" });
ok("O1 connected parent: handed to its window", r1.delivered === "to your parent as a message (handed to its window)" && sent.length === 1, JSON.stringify(r1));
connected = false;
const r2 = orch.report("k2", { text: "the result", final: true });
ok("O2 parent not connected: says kept until it reconnects", /isn't connected right now: kept, and given to it when it reconnects/.test(r2.delivered), JSON.stringify(r2));
connected = true;
ok("O2 … and it is given when the parent is back", orch.redeliver("hp-mom") === 1 && sent.at(-1).d.child === "k2" && /delivered late/.test(sent.at(-1).d.text));
const n = sent.length;
const r3 = orch.report("k3", { text: "late progress" });
ok("O3 a closing child's progress note: says it isn't sent to the parent", /isn't sent to your parent/.test(r3.delivered) && sent.length === n, JSON.stringify(r3));
fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `msg-orch-report: ${fails} FAILED` : "msg-orch-report: all pass");
process.exit(fails ? 1 : 0);
