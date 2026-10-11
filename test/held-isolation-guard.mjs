#!/usr/bin/env node
// J437: lib/held.mjs refuses every write and deciding relay call when HYPRPI_STATE is set without
// XDG_STATE_HOME (it would hit the LIVE sbx-relay state). Safe by design: the child runs with HOME pointed at a
// scratch folder, so even a broken guard would write there, never into Angus's real state.
//   node test/held-isolation-guard.mjs     (exit 0 = pass)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j437h-"));
let fails = 0;
const ok = (c, what) => { console.log(`${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails++; };
const child = (extra) => {
  const env = { ...process.env, HOME: path.join(T, "home"), ...extra };
  for (const k of ["XDG_STATE_HOME", "HYPRPI_STATE", "HYPRPI_SANDBOX_WORLD", "HYPRPI_G_WORLD"]) if (!(k in extra)) delete env[k];
  fs.mkdirSync(env.HOME, { recursive: true });
  const code = `import(${JSON.stringify(path.join(ROOT, "lib/held.mjs"))}).then((h) => {
    const id = "world-g--abc123", out = {};
    out.unsafe = h.relayStateUnsafe();
    h.logHeld({ test: 1 });
    h.logTurn({ room: "C", id, ok: true, turn: "x" });
    out.first = h.firstShow(id);
    out.claim = h.claimReview("C");
    out.review = h.openHeldReview(id);
    out.decide = h.decideHeld(id, "deny");
    out.act = h.actOnHeld(id, { verdict: "deny" }, "test");
    out.revoke = h.rulesCommand("revoke 1");
    out.phone = h.phoneDecision({ sandboxes: [], id, digest: "x", raw: "2", enabled: true });
    console.log(JSON.stringify(out));
  })`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 30000 });
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { console.log(r.stdout, r.stderr); return {}; }
};
const files = (d) => { const out = []; const walk = (x) => { let es = []; try { es = fs.readdirSync(x, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(x, e.name); e.isDirectory() ? walk(f) : out.push(f); } }; walk(d); return out; };

// 1. HYPRPI_STATE without XDG_STATE_HOME: everything refused, nothing written (under the scratch HOME).
const a = child({ HYPRPI_STATE: path.join(T, "dstate") });
ok(a.unsafe === true, "relayStateUnsafe() is true");
for (const k of ["review", "decide", "act", "phone"]) ok(a[k]?.ok === false && /^refused: HYPRPI_STATE/.test(a[k]?.text || ""), `${k}: refused (${a[k]?.text?.slice(0, 40)}…)`);
ok(/^refused: HYPRPI_STATE/.test(a.revoke || ""), "rules revoke: refused");
ok(a.first === false && a.claim === null, "firstShow / claimReview: refused");
const written = files(path.join(T, "home", ".local", "state"));
ok(written.length === 0, `nothing written under the (scratch) live state (${written.length} files)`);

// 2. Control: with XDG_STATE_HOME set as well (a proper isolated run), the log writes go there as before.
const x = path.join(T, "xdg");
const b = child({ HYPRPI_STATE: path.join(T, "dstate"), XDG_STATE_HOME: x });
ok(b.unsafe === false, "with XDG_STATE_HOME set too: not unsafe");
ok(files(path.join(x, "hyprpi", "sbx-relay")).some((f) => f.endsWith("panel.jsonl")), "and logHeld writes into XDG_STATE_HOME's sbx-relay as before");
ok(b.first === true, "and firstShow works there");

// 3. The live case (neither set) is untouched by the guard.
const c = child({});
ok(c.unsafe === false, "neither set (the live daemon and panels): not unsafe");

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
