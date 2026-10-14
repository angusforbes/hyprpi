#!/usr/bin/env node
// lib/remote-thoughts.mjs: runs ON a remote world's machine (J530), started by `omnistation/world X thoughts-relay` through remote.sh.
// Reads { from, text } (JSON) on stdin: a message for this world's Thoughts from another world's agent or Thoughts on the laptop.
// Hands it to this machine's daemon (thoughts.relayAsk), waits for the answer (thoughts.relayResult, up to 30 min), and prints
// { answer } or { error } as one JSON line. The laptop daemon passes the answer back to whoever asked.
import { request } from "./client.mjs";
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let raw = ""; for await (const c of process.stdin) raw += c;
let msg; try { msg = JSON.parse(raw); } catch { out({ error: "bad input" }); }
const room = String(process.env.HYPRPI_REMOTE_WORLD || process.argv[2] || "").toUpperCase();
if (!/^[A-I]$/.test(room)) out({ error: "no world letter" });
let id;
try { ({ request_id: id } = await request("thoughts.relayAsk", { room, from: String(msg.from || "").replace(/[\r\n\[\]]+/g, " ").slice(0, 80), text: String(msg.text || ""), mode: msg.mode === "talk" ? "talk" : "demand", fromThoughts: /^[A-I]$/.test(String(msg.fromThoughts || "")) ? msg.fromThoughts : "", ...(msg.origin && typeof msg.origin === "object" ? { origin: msg.origin } : {}) })); } // J603: who asked, and from which world
catch (e) { out({ error: `this machine's daemon: ${e.message}` }); }
// (J603) after this the asker is told "no answer yet"; a later answer goes back to it over the world's panel link (tests: shorter).
// Letting go is explicit (thoughts.relayDetach, OriginCheck): an answer already there is taken; else the link gets any later one.
// The same when the ssh ends under us (SIGHUP / SIGTERM / SIGPIPE).
let detaching = false;
async function letGo(why) {
  if (detaching) return; detaching = true;
  try { const r = id ? await request("thoughts.relayDetach", { request_id: id }) : null; if (r?.answer != null) out({ answer: r.answer }); } catch { /* below */ }
  out({ error: why });
}
for (const sig of ["SIGHUP", "SIGTERM", "SIGPIPE"]) process.on(sig, () => letGo("the relay ended"));
const WAIT = Number(process.env.HYPRPI_RELAY_WAIT_MS) || 30 * 60e3, end = Date.now() + WAIT;
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, Math.min(3000, WAIT / 4)));
  try { const r = await request("thoughts.relayResult", { request_id: id }); if (r.answer != null) out({ answer: r.answer }); if (r.late) out({ error: "answered over the panel link" }); }
  catch (e) { if (/unknown or expired/.test(e.message)) out({ error: e.message }); } // anything else (a daemon restart, a closed connection): keep waiting
}
await letGo(`no answer within ${Math.round(WAIT / 60e3)} min`);
