#!/usr/bin/env node
// J492 proof (Angus: "1 yes"): a changed thoughtsModel / thoughtsThinking in config starts Thoughts on a
// fresh session on the new model (pi would resume the old one on its old model and ignore --model); the
// old session is archived with a handoff; an unchanged model resumes as before.
//   node test/thoughts-model-switch.mjs   (exit 0 = pass; no model runs: pi is a fake that records its args)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createThoughts } from "../lib/thoughts.mjs";

let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = fs.mkdtempSync(path.join(os.tmpdir(), "j492-")), LOG = path.join(S, "pi-args.log");
// Fake pi: logs its argv; like pi, it keeps the session it finds in --session-dir (with ITS model) and only
// a new session gets --model; it reads RPC lines until stdin closes.
const FAKE = path.join(S, "fake-pi.mjs");
fs.writeFileSync(FAKE, `import fs from "node:fs"; import path from "node:path";
const a = process.argv.slice(2), at = (k) => a[a.indexOf(k) + 1];
const sdir = at("--session-dir"), m = at("--model"), th = a.includes("--thinking") ? at("--thinking") : "medium";
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(a) + "\\n");
const have = fs.readdirSync(sdir).filter((f) => f.endsWith(".jsonl"));
const file = have.length ? path.join(sdir, have[0]) : path.join(sdir, "s_" + at("--session-id") + ".jsonl");
if (!have.length) { const [p, ...id] = m.includes("/") ? m.split("/") : ["anthropic", m];
  fs.writeFileSync(file, [{ type: "session", id: at("--session-id") }, { type: "model_change", provider: p, modelId: id.join("/") }, { type: "thinking_level_change", thinkingLevel: th }].map((e) => JSON.stringify(e)).join("\\n") + "\\n"); }
let buf = ""; // one RPC line = one message (several can come in one chunk)
process.stdin.on("data", (d) => { buf += d.toString(); let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; fs.appendFileSync(file, JSON.stringify({ type: "message", text: l.slice(0, 4000) }) + "\\n"); process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"); } });
process.stdin.on("end", () => process.exit(0));
`);
let conf = { pi: "", thoughtsModel: "anthropic/claude-haiku-4-5" };
const notes = [];
// createThoughts spawns cfg().pi with pi's args: a tiny shell shim runs the fake script
const SHIM = path.join(S, "pi"); fs.writeFileSync(SHIM, `#!/bin/sh\nexec ${process.execPath} ${FAKE} "$@"\n`); fs.chmodSync(SHIM, 0o755);
conf.pi = SHIM;
const T2 = createThoughts({ stateDir: S, cfg: () => conf, log: (...x) => notes.push(x.join(" ")) });
const runs = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const sdir = path.join(S, "thoughts", "Z"), archives = () => fs.readdirSync(path.join(S, "thoughts", "archive")).filter((f) => !f.endsWith(".md"));
const sessionModel = () => { const f = fs.readdirSync(sdir).find((x) => x.endsWith(".jsonl")); return f ? JSON.parse(fs.readFileSync(path.join(sdir, f), "utf8").split("\n")[1]) : null; };
const stop = async () => { T2.restart("Z"); for (let i = 0; i < 50 && T2.running("Z"); i++) await sleep(100); };

// 1. first start: a session on the configured model, marker written
T2.send("Z", "hello one"); await sleep(400);
ok("1 first start uses the configured model", runs().at(-1).includes("anthropic/claude-haiku-4-5"));
ok("1 marker written", JSON.parse(fs.readFileSync(path.join(S, "thoughts", "Z.model.json"), "utf8")).model === "anthropic/claude-haiku-4-5");
await stop();
// 2. W4: unchanged config -> same session resumed, nothing archived
T2.send("Z", "hello two"); await sleep(400);
ok("W4 unchanged model: started again", runs().length === 2);
ok("W4 unchanged model: no archive", !fs.existsSync(path.join(S, "thoughts", "archive")));
ok("W4 unchanged model: same session kept", sessionModel()?.modelId === "claude-haiku-4-5" && fs.readFileSync(path.join(sdir, fs.readdirSync(sdir)[0]), "utf8").includes("hello one"));
await stop();
// 3. W1/W2: config changes model -> old session archived with a handoff, new session on the new model
conf = { ...conf, thoughtsModel: "anthropic/claude-sonnet-4-6" };
T2.send("Z", "hello three"); await sleep(600);
const arch = fs.existsSync(path.join(S, "thoughts", "archive")) ? archives() : [];
ok("W1 new model passed to pi", runs().at(-1).includes("anthropic/claude-sonnet-4-6"));
ok("W1 the live session is a new one on the new model", sessionModel()?.modelId === "claude-sonnet-4-6");
ok("W2 old session archived (moved, not deleted)", arch.length === 1 && fs.readdirSync(path.join(S, "thoughts", "archive", arch[0])).some((f) => f.endsWith(".jsonl") && fs.readFileSync(path.join(S, "thoughts", "archive", arch[0], f), "utf8").includes("claude-haiku-4-5")));
const hf = fs.readdirSync(path.join(S, "thoughts", "archive")).find((f) => f.endsWith(".md"));
ok("W2 handoff written from the thread", !!hf && fs.readFileSync(path.join(S, "thoughts", "archive", hf), "utf8").includes("hello two"));
const sess = fs.readFileSync(path.join(sdir, fs.readdirSync(sdir).find((f) => f.endsWith(".jsonl"))), "utf8");
ok("W2 the new session got the handoff and the reason first", sess.indexOf("model changed") > 0 && sess.indexOf("model changed") < sess.indexOf("hello three"));
ok("W1 Angus's message still delivered after the switch", sess.includes("hello three"));
ok("W1 thread shows a 'new model' divider", T2.get("Z").entries.some((e) => e.session && /new model/.test(e.text)));
await stop();
// 4. thinking change alone also switches; then unchanged again keeps it
conf = { ...conf, thoughtsThinking: "high" };
T2.send("Z", "hello four"); await sleep(600);
ok("W1 thinking change -> fresh session with --thinking high", runs().at(-1).join(" ").includes("--thinking high") && archives().length === 2);
await stop();
T2.send("Z", "hello five"); await sleep(400);
ok("W4 unchanged again: no new archive", archives().length === 2);
await stop();
// 5. a session from before J492 (no marker) on the configured model resumes; on another model it switches
fs.rmSync(path.join(S, "thoughts", "Z.model.json"));
T2.send("Z", "hello six"); await sleep(400);
ok("W4 pre-J492 session on the configured model resumes", archives().length === 2);
await stop();
fs.rmSync(path.join(S, "thoughts", "Z.model.json"));
conf = { ...conf, thoughtsModel: "nv-inference/azure/anthropic/claude-opus-5-5", thoughtsThinking: "" };
T2.send("Z", "hello seven"); await sleep(600);
ok("W1 pre-J492 session on another model switches", archives().length === 3 && sessionModel()?.provider === "nv-inference" && sessionModel()?.modelId === "azure/anthropic/claude-opus-5-5");
await stop();
T2.send("Z", "hello eight"); await sleep(400);
ok("W4 provider/model with slashes resumes", archives().length === 3);
await stop();
T2.stopAll();
console.log(fails ? `${fails} FAILED (state ${S})` : "all passed");
if (!fails) fs.rmSync(S, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
