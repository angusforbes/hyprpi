#!/usr/bin/env node
// doorman-view.mjs (J327): the Doorman's visibility, host side. The Doorman's Pi runs in RPC mode inside its sandbox;
// its stdout (JSON events) is piped through `log`, and its stdin is a FIFO that only `view --write` feeds.
//   doorman-view.mjs log NAME                  stdin events -> state/events.jsonl (+ status.json: state, last question/answer)
//   doorman-view.mjs view NAME [--write]       live render of events.jsonl; with --write (developer mode) a prompt line whose
//                                              text is sent to the Doorman marked as Angus's own, never as a sandbox request
//   doorman-view.mjs fifo-line TEXT            (test helper) print the RPC line a typed text becomes
// Everything here is host-side: the sandbox can't see these files. Typed text only reaches the Doorman's stdin; the
// extension in the sandbox blocks the three tools that reach anyone else for turns that start with the marker.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const MARKER = "[Angus · developer window";
export const stateDir = (name) => path.join(process.env.HYPRPI_DOORMEN_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "hyprpi", "doormen"), name);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const plain = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "text").map((c) => c.text).join("") : String(m?.content ?? ""));

// What Angus typed becomes ONE prompt line for Pi's RPC stdin, opening with the marker. followUp: if the Doorman is
// mid-turn the text waits for it instead of being refused.
export function promptLine(typed) {
  const t = plain(typed).replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!t) return null;
  const message = `${MARKER} · from Angus, the owner, typing directly to you; not a sandbox request, no request_id. Answer him in plain text here.]\n${t}`;
  return JSON.stringify({ type: "prompt", message, streamingBehavior: "followUp" }) + "\n";
}

// One RPC event -> a short display line (or null). Shared by the viewer and the status writer's idea of a Q and A.
export function render(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.type === "agent_start") return "── turn ──";
  if (ev.type === "message_end" && ev.message) {
    const m = ev.message, t = plain(textOf(m)).trim();
    if (m.role !== "assistant" && m.role !== "toolResult") return t ? `❓ ${clip(t.replace(/\[your host card[\s\S]*?\[end of host card\]\s*/, "[card] "), 1200)}` : null;
    if (m.role === "assistant") {
      const calls = (m.content || []).filter((c) => c?.type === "toolCall").map((c) => `🔧 ${c.name}(${clip(JSON.stringify(c.arguments ?? {}), 300)})`);
      return [t && `💬 ${t}`, ...calls, m.stopReason === "error" && `⚠ ${clip(m.errorMessage, 200)}`].filter(Boolean).join("\n") || null;
    }
    if (m.role === "toolResult") return `   ↳ ${clip(plain(textOf(m)), 300)}`;
  }
  return null;
}

function log(name) {
  const d = stateDir(name); fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const ev = fs.openSync(path.join(d, "events.jsonl"), "a", 0o600), sf = path.join(d, "status.json");
  let st = { state: "idle", question: "", answer: "", at: "" };
  const save = () => { st.at = new Date().toISOString(); fs.writeFileSync(sf + ".tmp", JSON.stringify(st), { mode: 0o600 }); fs.renameSync(sf + ".tmp", sf); };
  save();
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let j; try { j = JSON.parse(line); } catch { return; }
    if (j.type === "message_update" || j.type === "tool_execution_update") return; // streaming deltas: not kept
    fs.writeSync(ev, line + "\n");
    if (j.type === "agent_start") { st.state = "working"; save(); }
    else if (j.type === "agent_end") { st.state = "idle"; save(); }
    else if (j.type === "message_end" && j.message?.role !== "assistant" && j.message?.role !== "toolResult") { const t = plain(textOf(j.message)).replace(/\[your host card[\s\S]*?\[end of host card\]\s*/, "").replace(/\s+/g, " ").trim(); if (t) { st.question = clip(t, 300); st.answer = ""; save(); } }
    else if (j.type === "message_end" && j.message?.role === "assistant") { const t = plain(textOf(j.message)).trim(); if (t) { st.answer = clip(t, 300); save(); } }
  });
}

function view(name, write) {
  const d = stateDir(name), f = path.join(d, "events.jsonl"), fifo = path.join(d, "input.fifo");
  const out = (s) => process.stdout.write(s.replace(/\n/g, "\r\n") + "\r\n");
  out(`Doorman ${name} — ${write ? "DEVELOPER: you can type to it (your text is marked as yours; it reaches only the Doorman)" : "OBSERVER: read-only"}`);
  let pos = 0;
  try { pos = Math.max(0, fs.statSync(f).size - 20000); } catch { /* none yet */ }
  let buf = "";
  const pump = () => {
    let fd; try { fd = fs.openSync(f, "r"); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size; if (size < pos) pos = 0;
      const b = Buffer.alloc(Math.min(size - pos, 1 << 20)); const n = fs.readSync(fd, b, 0, b.length, pos); pos += n; buf += b.toString("utf8", 0, n);
      let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const r = render(JSON.parse(line)); if (r) out(r); } catch { /* */ } }
    } finally { fs.closeSync(fd); }
  };
  setInterval(pump, 500); pump();
  if (!write) { process.stdin.resume(); if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.on("data", (b) => { if (b[0] === 3 || b[0] === 4) process.exit(0); }); return; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  rl.prompt();
  rl.on("line", (l) => {
    const pl = promptLine(l);
    if (pl) {
      try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, pl); fs.closeSync(fd); out(`🧑 you: ${clip(plain(l), 300)}`); }
      catch (e) { out(`(not sent: the Doorman's input isn't open: ${e.code || e.message})`); }
    }
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "log" && a) log(a);
  else if (cmd === "view" && a) view(a, b === "--write");
  else if (cmd === "fifo-line") process.stdout.write(promptLine(a) || "");
  else { console.error("usage: doorman-view.mjs log NAME | view NAME [--write]"); process.exit(2); }
}
