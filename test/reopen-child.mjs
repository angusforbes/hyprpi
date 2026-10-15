#!/usr/bin/env node
// J652 (Angus: "after a reboot restore the children know their parents, so reopening should too"). An isolated daemon (own
// socket/state/config, no Hyprland, HYPRPI_ORCH_LAUNCH=/bin/true so no real agent starts); fake agents connect as the extension
// does. Never the live daemon; no real agent is reopened.
//   W1 a child spawned by a live parent, closed with close_agent (its window then goes away), reopened on the same id: status
//      running, linkOf shows its parent again, report_to_parent reaches the parent.
//   W2 a child whose parent is not live, reopened: stays closed and unlinked (no crash, no bogus link; report says "no parent"
//      is not claimed: its reports aren't delivered to anyone live).
//   W3 close_agent still closes (closing → closed when the window goes) and a never-reopened closed child stays closed.
//   node test/run.mjs test/reopen-child.mjs   (exit 0 = pass)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "j652-")), sock = path.join(T, "d.sock"), state = path.join(T, "state"), cfg = path.join(T, "cfg");
fs.mkdirSync(state); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10, topics: false }));
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, XDG_CONFIG_HOME: cfg, HYPRPI_TEST: "1", HYPRPI_ORCH_LAUNCH: "/bin/true", HYPRLAND_INSTANCE_SIGNATURE: "j652-bogus", HYPRPI_NO_ENSURE: "1" };
for (const k of ["HYPRPI_AGENT_ID", "HYPRPI_ALLOW_HYPR", "HYPRPI_WORKSPACE"]) delete env[k];
const fd = fs.openSync(path.join(T, "daemon.log"), "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
  const ev = {}; const fake = async (id, name, ws) => { ev[id] = []; const c = await connect({ path: sock, onEvent: (e, x) => ev[id].push({ e, x }) }); await c.call("agent.hello", { agent_id: id, pid: process.pid, name, want_workspace: ws, cwd: T }); await c.call("orch.me", {}).catch(() => null); return c; };
  const api = await connect({ path: sock, onEvent: () => {} });
  const kidOf = async (id) => (await api.call("orch.all", {})).children.find((c) => c.id === id);
  const whoami = async (c) => c.call("whoami", {});

  // W1/W3: Mom spawns Kid; Mom closes it; its window goes away
  const mom = await fake("hp-mom", "Mom", 32);
  const sp = await mom.call("orch.spawn", { prompt: "do a thing", name: "Kid" });
  let kid = await fake(sp.id, sp.name, 33); await sleep(300);
  const linked = async (parent, id) => (await parent.call("orch.children", {})).children.some((c) => c.id === id); // linkOf/childrenOf: only live (unclosed) children
  ok("W1 setup: the child is running and linked to Mom", (await kidOf(sp.id)).status === "running" && await linked(mom, sp.id));
  const cl = await mom.call("orch.close", { id: sp.id, reason: "done" });
  ok("W3 close_agent: closing, as before", /Kid/.test(cl.name || "") && (await kidOf(sp.id)).status === "closing", JSON.stringify(cl));
  kid.close(); await sleep(11500); // the window went away: the daemon's 6 s check marks it closed
  ok("W3 … and closed once its window went away, as before (and unlinked)", (await kidOf(sp.id)).status === "closed" && !(await linked(mom, sp.id)));
  // reopened on the same id (agent-reopen / hyprpi new --id … -- --session …): the extension connects again
  ev["hp-mom"].length = 0;
  kid = await fake(sp.id, sp.name, 33); await sleep(2500);
  const k1 = await kidOf(sp.id);
  ok("W1 reopened: status running", k1.status === "running", k1.status);
  ok("W1 reopened: its parent link is back (Mom's my_children lists it; its record names Mom)", await linked(mom, sp.id) && k1.parent === "hp-mom" && k1.parent_name === "Mom", JSON.stringify({ p: k1.parent, n: k1.parent_name }));
  await kid.call("orch.report", { text: "back again: the result", final: false }); await sleep(800);
  ok("W1 reopened: report_to_parent reaches Mom", ev["hp-mom"].some((x) => /back again: the result/.test(JSON.stringify(x.x))));

  // W2: Dad spawns Kid2, Kid2 is closed, Dad goes away, Kid2 is reopened
  const dad = await fake("hp-dad", "Dad", 34);
  const sp2 = await dad.call("orch.spawn", { prompt: "another", name: "Kid2" });
  let kid2 = await fake(sp2.id, sp2.name, 35); await sleep(300);
  await dad.call("orch.close", { id: sp2.id }); kid2.close(); await sleep(11500);
  ok("W2 setup: Kid2 closed", (await kidOf(sp2.id)).status === "closed");
  dad.close(); await sleep(11500); // Dad's window goes away too
  kid2 = await fake(sp2.id, sp2.name, 35); await sleep(2500);
  const k2 = await kidOf(sp2.id);
  ok("W2 reopened with its parent gone: stays closed, no link", k2.status === "closed" && !(await api.call("orch.all", {})).children.some((c) => c.parent === "hp-dad" && c.status !== "closed"), JSON.stringify({ s: k2.status }));
  const rr = await kid2.call("orch.report", { text: "anyone?" }).then((r) => JSON.stringify(r), (e) => "error: " + e.message);
  ok("W2 … report_to_parent doesn't crash the daemon", typeof rr === "string" && (await api.call("ping", {})).ok !== false, rr);
  // W3 again: a child closed and never reopened stays closed
  const sp3 = await mom.call("orch.spawn", { prompt: "third", name: "Kid3" });
  const kid3 = await fake(sp3.id, sp3.name, 36); await sleep(300); await mom.call("orch.close", { id: sp3.id }); kid3.close(); await sleep(11500);
  ok("W3 a closed child that isn't reopened stays closed", (await kidOf(sp3.id)).status === "closed");
  // (ReopenCheck F2) the daemon's own hello path, with no orch.me: closed, then reopened by hello alone
  const sp5 = await mom.call("orch.spawn", { prompt: "fifth", name: "Kid5" });
  let k5 = await fake(sp5.id, sp5.name, 38); await sleep(300); await mom.call("orch.close", { id: sp5.id }); k5.close(); await sleep(11500);
  k5 = await connect({ path: sock, onEvent: () => {} }); await k5.call("agent.hello", { agent_id: sp5.id, pid: process.pid, name: sp5.name, want_workspace: 38, cwd: T }); await sleep(2800);
  ok("W1 the daemon's hello alone (no orch.me) reopens it and relinks it to Mom", (await kidOf(sp5.id)).status === "running" && await linked(mom, sp5.id));
  k5.close();
  // (ReopenCheck) a child that said hello and dropped before the 2 s timer, then was closed while offline: it stays closed
  const sp4 = await mom.call("orch.spawn", { prompt: "fourth", name: "Kid4" });
  const k4 = await connect({ path: sock, onEvent: () => {} }); await k4.call("agent.hello", { agent_id: sp4.id, pid: process.pid, name: sp4.name, want_workspace: 37, cwd: T });
  k4.close(); await sleep(300); await mom.call("orch.close", { id: sp4.id }).catch(() => {}); await sleep(11500);
  ok("W3 a child that dropped right after hello and was closed while offline is not reopened by the stale hello timer", (await kidOf(sp4.id)).status === "closed", (await kidOf(sp4.id)).status);
  const log = fs.readFileSync(path.join(T, "daemon.log"), "utf8");
  api.close(); mom.close(); kid.close(); kid2.close();
} catch (e) { fails++; console.log("FAIL", e.stack); }
finally { d.kill("SIGTERM"); await sleep(300); try { d.kill("SIGKILL"); } catch { /* gone */ } }
console.log(fails ? `reopen-child: ${fails} FAILED (state ${T})` : "reopen-child: all pass"); process.exit(fails ? 1 : 0);
