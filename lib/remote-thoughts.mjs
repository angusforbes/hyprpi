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
try { ({ request_id: id } = await request("thoughts.relayAsk", { room, from: String(msg.from || "").replace(/[\r\n\[\]]+/g, " ").slice(0, 80), text: String(msg.text || ""), mode: msg.mode === "talk" ? "talk" : "demand", fromThoughts: /^[A-I]$/.test(String(msg.fromThoughts || "")) ? msg.fromThoughts : "" })); }
catch (e) { out({ error: `this machine's daemon: ${e.message}` }); }
const end = Date.now() + 30 * 60e3;
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, 3000));
  try { const r = await request("thoughts.relayResult", { request_id: id }); if (r.answer != null) out({ answer: r.answer }); }
  catch (e) { if (/unknown or expired/.test(e.message)) out({ error: e.message }); } // anything else (a daemon restart, a closed connection): keep waiting
}
out({ error: "no answer within 30 min" });
