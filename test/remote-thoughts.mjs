#!/usr/bin/env node
// J530 (Angus: "no local Thoughts or any other local TUIs on remote worlds"). An isolated laptop daemon (temp socket + state, no
// Hyprland, pi = /bin/cat) with world H bound to a "remote machine" whose ssh is a fake that answers like remote.sh thoughts-relay:
//   1. the laptop runs no Thoughts for H: thoughts.send to H is refused; its rooms list marks H remote
//   2. an agent's demand to "Thoughts-H" goes over the relay and its answer comes back as the reply (the relayed JSON is right)
//   3. the remote side's RPCs on a second isolated daemon (as world I's own machine): relayAsk lands as an agent message for
//      Thoughts-I, answer_agent (thoughts.answer) stores it, relayResult hands it back
//   4. the panel launcher refuses a remote world; a normal world isn't refused
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn, spawnSync } from "node:child_process";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { connect } = await import(path.join(ROOT, "lib/client.mjs"));
async function daemon(tag, cfgExtra = () => {}) {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), `j530-${tag}-`)), cfg = path.join(S, "cfg"), sock = path.join(S, "d.sock");
  fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "hyprpi", "config.json"), JSON.stringify({ roomToThoughts: false, pi: "/bin/cat", worldSize: 10 }));
  fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ auth: { enabled: false }, upkeep: { refresh: { enabled: false }, autoReload: { enabled: false } } }));
  cfgExtra(S, cfg);
  const env = { ...process.env, HYPRPI_SOCKET: sock, HYPRPI_STATE: S, XDG_CONFIG_HOME: cfg, HYPRLAND_INSTANCE_SIGNATURE: `j530-${tag}`, HYPRPI_NO_ENSURE: "1", HYPRPI_UPKEEP_MS: "3600000" };
  delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_WORKSPACE;
  const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fs.openSync(path.join(S, "d.log"), "w"), "inherit"] });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(200);
  return { S, cfg, sock, env, d };
}
const laptop = await daemon("lap", (S, cfg) => {
  fs.mkdirSync(path.join(cfg, "hyprpi", "remote"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(S, "rooms"), { recursive: true }); fs.writeFileSync(path.join(S, "rooms", "H.jsonl"), ""); // world H is known
  const fake = path.join(S, "fakessh");
  fs.writeFileSync(fake, `#!/usr/bin/env bash\ncat > "${S}/relayed.json"; echo "\${@: -1}" > "${S}/relayed.cmd"; echo '{"answer":"Thoughts-H here: Browserbox is live"}'\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(cfg, "hyprpi", "remote", "h.json"), JSON.stringify({ ssh: [fake, "omni"] }), { mode: 0o600 });
});
const remote = await daemon("rem");
try {
  const api = await connect({ path: laptop.sock, onEvent: () => {} });
  const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
  // 1
  { const e1 = await err(() => api.call("thoughts.send", { room: "H", text: "hi" })); ok("1 the laptop runs no Thoughts for remote world H", /runs on its remote machine/.test(e1), e1); }
  const sub = await api.call("ui.subscribe", { windows: false }).catch(() => ({}));
  const lst = await api.call("list", {}).catch(() => ({}));
  const thH = (lst.thoughts || []).find((t) => t.room === "H");
  ok("1 the lists mark world H remote", thH?.remote === true && (sub.rooms || []).some((r) => r.id === "H" && r.remote === true), JSON.stringify(thH || null));
  // 2
  const got = [];
  const agent = await connect({ path: laptop.sock, onEvent: (ev, data) => got.push({ ev, data }) });
  await agent.call("agent.hello", { agent_id: "hp-atlas", pid: process.pid, name: "Atlas", want_workspace: 12, cwd: laptop.S });
  const t = await agent.call("talk", { to: ["Thoughts-H"], text: "which agents are live there?", mode: "demand" });
  ok("2 delivered to Thoughts-H on its remote machine", (t.delivered || []).some((x) => /Thoughts-H \(on its remote machine\)/.test(x)), JSON.stringify(t));
  let rep = null; for (let i = 0; i < 50 && !rep; i++) { await sleep(200); rep = got.find((g) => g.ev === "talk.reply"); }
  ok("2 the remote answer comes back as the reply", /Browserbox is live/.test(rep?.data?.text || ""), JSON.stringify(rep?.data || null));
  const relayed = JSON.parse(fs.readFileSync(path.join(laptop.S, "relayed.json"), "utf8"));
  ok("2 the relay sent who asked and the text, through remote.sh thoughts-relay", relayed.from === "Atlas" && /which agents/.test(relayed.text) && /remote\.sh thoughts-relay/.test(fs.readFileSync(path.join(laptop.S, "relayed.cmd"), "utf8")));
  // 3
  const rapi = await connect({ path: remote.sock, onEvent: () => {} });
  const { request_id } = await rapi.call("thoughts.relayAsk", { room: "I", from: "Thoughts-A", text: "how many agents?" });
  ok("3 relayAsk gives a request id", !!request_id);
  ok("3 no answer yet", (await rapi.call("thoughts.relayResult", { request_id })).answer === null);
  await rapi.call("thoughts.answer", { room: "I", request_id, text: "one: hub-alpha" });
  ok("3 answer_agent's text comes back from relayResult", (await rapi.call("thoughts.relayResult", { request_id })).answer === "one: hub-alpha");
  // 4
  const run = (l) => spawnSync(path.join(ROOT, "mockups/search-tui"), [l], { env: { ...laptop.env, PATH: process.env.PATH, HYPRPI_ALLOW_HYPR: "1" }, encoding: "utf8", timeout: 5000 });
  const h = run("H"); ok("4 the laptop's panel launcher refuses remote world H", h.status === 0 && /runs on its remote machine/.test(h.stderr), h.stderr);
  api.close?.(); agent.close?.(); rapi.close?.();
} finally {
  for (const x of [laptop, remote]) { x.d.kill(); await sleep(300); fs.rmSync(x.S, { recursive: true, force: true }); }
}
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
