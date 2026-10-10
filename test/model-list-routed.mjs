#!/usr/bin/env node
// J397: a ROUTED model (no model given; the routing config picks it) that is not on the host's scoped list is refused too.
// Isolated daemon with its own hyprpi.jsonc whose "simple" kind routes to an unlisted model. node test/model-list-routed.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../lib/client.mjs";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j397-")), sock = path.join(T, "d.sock"), state = path.join(T, "state"), cfg = path.join(T, "cfg");
fs.mkdirSync(state); fs.mkdirSync(path.join(cfg, "hyprpi"), { recursive: true });
fs.writeFileSync(path.join(cfg, "hyprpi", "hyprpi.jsonc"), JSON.stringify({ routing: { default: "ordinary", ladder: ["openrouter/acme/unlisted-1:low", "anthropic/claude-sonnet-5-5:medium"], kinds: { simple: 0, ordinary: 1 } } }));
const env = { ...process.env, XDG_CONFIG_HOME: cfg, HYPRPI_SOCKET: sock, HYPRPI_STATE: state, HYPRPI_TEST: "1", HYPRPI_ORCH_LAUNCH: "/bin/true", HYPRPI_MODELCHECK: "0" };
delete env.HYPRPI_AGENT_ID; delete env.HYPRPI_ALLOW_HYPR;
const logf = path.join(T, "daemon.log"), fd = fs.openSync(logf, "w");
const d = spawn(process.execPath, [path.join(ROOT, "bin/hyprpi"), "daemon"], { env, stdio: ["ignore", fd, fd] });
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const refused = async (fn) => { try { await fn(); return ""; } catch (e) { return e.message; } };
try {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const c = await connect({ path: sock });
  const a = await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "RoutedA", complexity: "simple" }));
  ok("a routed unlisted model is refused (kind simple -> openrouter/acme/unlisted-1)", /scoped model list/.test(a) && /unlisted-1/.test(a), a.slice(0, 180));
  const fk = await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "RoutedF", complexity: "simple", fork: true }));
  ok("a fork whose kind routes to an unlisted model is refused too", /scoped model list/.test(fk), fk.slice(0, 120));
  const b = await refused(() => c.call("orch.spawn", { thoughts: "A", prompt: "x", name: "RoutedB", complexity: "ordinary" }));
  ok("a routed listed model passes (kind ordinary -> anthropic sonnet)", !b, b);
  const audit = await c.call("models.audit", {}); ok("models.audit names the unlisted routing model", audit.notOnList.some((x) => /unlisted-1/.test(x.model)), JSON.stringify(audit.notOnList));
  c.close();
} finally { d.kill("SIGTERM"); await sleep(400); try { d.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
