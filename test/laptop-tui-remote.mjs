#!/usr/bin/env node
// J543: the two ends of a remote panel's back-channel, without a terminal, network or desktop.
//  A) lib/tui/laptop.mjs (the panels' side), each case in a fresh node: in a LOCAL panel nothing is written and the old calls are
//     made (agent.focus to the daemon, clipboardPaste's wl-paste, openTarget's gio); in a REMOTE panel with the relay's nonce the
//     right request is written (and agent.focus / wl-paste / gio are not run); in a remote panel without a relay nothing is written
//     and the panel is told why.
//  B) omnistation/laptop-act.mjs (the laptop's side) with stub hyprctl / gio / notify-send / world / panels: a parked window comes
//     to this workspace before it's focused; a panel open on a normal workspace is jumped to; a file that could run something is
//     copied but only its folder opened; `world X focus NAME` runs the same focus.
//   node test/laptop-tui-remote.mjs   (exit 0 = pass)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j543t-")), B = path.join(T, "bin"); fs.mkdirSync(B);
const F = (n) => path.join(T, n), read = (n) => { try { return fs.readFileSync(F(n), "utf8"); } catch { return ""; } };
const exe = (f, s) => fs.writeFileSync(f, s, { mode: 0o755 });
for (const t of ["gio", "xdg-open", "notify-send", "wl-paste"]) exe(path.join(B, t), `#!/bin/sh\necho "${t} $*" >> ${F("ran.log")}\n`);
const base = { ...process.env, PATH: `${B}:${process.env.PATH}`, HOME: T, XDG_RUNTIME_DIR: T, HYPRPI_ALLOW_HYPR: "1" }; // (only the stubs on PATH can run; no Hyprland signature)
for (const k of ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_AGENT_ID", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HYPRPI_REMOTE_PANEL", "HYPRPI_LAPTOP_RELAY"]) delete base[k];
const NONCE = "abcdef0123456789abcd";

// ---- A) the panels' side
const probe = `
const L = await import(${JSON.stringify(path.join(ROOT, "lib/tui/laptop.mjs"))});
const { clipboardPaste } = await import(${JSON.stringify(path.join(ROOT, "lib/tui/input-box.mjs"))});
const { openTarget } = await import(${JSON.stringify(path.join(ROOT, "lib/tui/markdown.mjs"))});
const wrote = []; L.setLaptopWriter((s) => wrote.push(s));
const calls = []; const api = { call: (m, p) => { calls.push([m, p]); return Promise.resolve({}); } };
const out = {};
out.focus = await L.focusAgent(api, "h-omni-alpha").then(() => "ok", (e) => "err " + e.message);
clipboardPaste(() => {});
out.open = openTarget("https://example.com/a");
out.panel = L.laptopPanel("board");
out.file = L.laptopOpen("file:///home/u/x.txt");
await new Promise((r) => setTimeout(r, 600));
console.log(JSON.stringify({ out, calls, wrote: wrote.map((w) => { const m = /^\\x1b\\]5379;hyprpi;([A-Za-z0-9+/=]+)\\x07$/.exec(w); return m ? JSON.parse(Buffer.from(m[1], "base64").toString()) : "BAD " + JSON.stringify(w); }) }));
process.exit(0);
`;
const runProbe = (env) => { fs.rmSync(F("ran.log"), { force: true }); const o = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8" })); o.ran = read("ran.log").split("\n").filter(Boolean); return o; };

let r = runProbe(base);
ok("local panel: agent.focus goes to the daemon as before", r.calls.length === 1 && r.calls[0][0] === "agent.focus" && r.calls[0][1].agent === "h-omni-alpha", JSON.stringify(r.calls));
ok("local panel: no request is written", r.wrote.length === 0, JSON.stringify(r.wrote));
ok("local panel: paste reads the clipboard with wl-paste, a link opens with gio, as before", r.ran.some((l) => l.startsWith("wl-paste --list-types")) && r.ran.includes("gio open https://example.com/a") && r.out.open === true, JSON.stringify(r.ran));
ok("local panel: laptopPanel is not for it", r.out.panel === "", JSON.stringify(r.out));

r = runProbe({ ...base, HYPRPI_REMOTE_PANEL: "1", HYPRPI_LAPTOP_RELAY: NONCE });
const acts = r.wrote.map((w) => w.act);
ok("remote panel: no agent.focus to the remote daemon, no wl-paste / gio there", r.calls.length === 0 && r.ran.length === 0, JSON.stringify({ calls: r.calls, ran: r.ran }));
ok("remote panel: focus · paste · open · panel · file requests, each with the nonce", JSON.stringify(acts) === JSON.stringify(["focus", "paste", "open", "panel", "file"]) && r.wrote.every((w) => w.n === NONCE), JSON.stringify(r.wrote));
ok("remote panel: what each carries", r.wrote[0].agent === "h-omni-alpha" && r.wrote[2].url === "https://example.com/a" && r.wrote[3].kind === "board" && r.wrote[4].path === "/home/u/x.txt", JSON.stringify(r.wrote));

r = runProbe({ ...base, HYPRPI_REMOTE_PANEL: "1" });
ok("remote panel, no relay (an older laptop): nothing written, and the panel says why", r.wrote.length === 0 && /^err .*laptop/.test(r.out.focus) && r.out.panel.startsWith("✗"), JSON.stringify(r.out));

// ---- B) the laptop's side
const sleeper = spawn("python3", ["-c", "import time; time.sleep(120)", "/x/omnistation/remote-client.mjs", "H", "omni-alpha"], { stdio: "ignore" });
const win = (address, pid, ws, cls, title) => ({ address, pid, class: cls, title, workspace: { id: ws, name: String(ws) } });
exe(path.join(B, "hyprctl"), `#!/bin/sh\ncase "$1 $2" in "-j clients") cat ${F("clients.json")};; "-j activeworkspace") echo '{"id":74}';; "-j "*) echo '[]';; *) echo "$*" >> ${F("hypr.log")};; esac\n`);
exe(F("world"), `#!/bin/sh\necho "world $*" >> ${F("ran.log")}\n[ "$2" = binding ] && echo '{"ssh":["${F("ssh")}","h"]}'\nexit 0\n`);
exe(F("ssh"), `#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n`);
exe(F("panels"), `#!/bin/sh\necho "panels $*" >> ${F("ran.log")}\n`);
const AENV = { ...base, HYPRPI_TEST: "1", HYPRPI_ALLOW_HYPR: "1", HYPRPI_TEST_WORLD_CMD: F("world"), HYPRPI_TEST_PANELS_CMD: F("panels") };
const act = (...a) => { fs.rmSync(F("ran.log"), { force: true }); fs.rmSync(F("hypr.log"), { force: true }); try { return execFileSync(process.execPath, [path.join(ROOT, "omnistation/laptop-act.mjs"), "H", ...a], { env: AENV, encoding: "utf8", timeout: 20000 }); } catch (e) { return e.stdout || ""; } };
try {
  await sleep(200);
  fs.writeFileSync(F("clients.json"), JSON.stringify([win("0xa1", sleeper.pid, -99, "hyprpi.h-agent", "📡 H: π - omni-alpha"), win("0xb1", process.pid, 75, "hyprpi.h-panel", "hyprpi-board H")]));
  act("focus", "omni-alpha");
  const h = read("hypr.log");
  ok("focus: a parked window comes to this workspace (74), then is focused", /hl\.dsp\.window\.move.*address:0xa1.*workspace = "74"/.test(h) && h.indexOf("window.move") < h.indexOf("hl.dsp.focus") && /hl\.dsp\.focus.*address:0xa1/.test(h), h);
  act("panel", "board");
  ok("panel: one open on a normal workspace is jumped to (no mockups/panels)", /hl\.dsp\.focus.*address:0xb1/.test(read("hypr.log")) && !/panels/.test(read("ran.log")), read("hypr.log") + read("ran.log"));
  act("panel", "search");
  ok("panel: one not open → mockups/panels H --only 3", read("ran.log").includes("panels H --only 3"), read("ran.log"));
  fs.writeFileSync(F("evil.desktop"), "[Desktop Entry]\nExec=touch /tmp/pwned\n");
  const o = act("file", F("evil.desktop"));
  const copied = path.join(T, "Downloads/hyprpi-h/evil.desktop");
  ok("file: a .desktop is copied (600) but only its folder is opened", fs.existsSync(copied) && (fs.statSync(copied).mode & 0o777) === 0o600 && read("ran.log").includes(`gio open ${path.dirname(copied)}`) && !read("ran.log").includes(`gio open ${copied}`), read("ran.log") + o);
  act("open", "javascript:alert(1)");
  ok("open: only http(s)", !/gio open javascript/.test(read("ran.log")), read("ran.log"));
  act("focus", "x;rm -rf ~");
  ok("focus: a bad name does nothing but say so", !read("hypr.log") && /notify-send/.test(read("ran.log")), read("ran.log"));
  fs.rmSync(F("hypr.log"), { force: true });
  fs.writeFileSync(F("binding.json"), JSON.stringify({ ssh: [F("ssh"), "h"] }));
  execFileSync(path.join(ROOT, "omnistation/world"), ["H", "focus", "omni-alpha"], { env: { ...AENV, HYPRPI_REMOTE_CONF: F("binding.json") }, encoding: "utf8" });
  ok("world H focus omni-alpha: the same jump", /hl\.dsp\.focus.*address:0xa1/.test(read("hypr.log")), read("hypr.log"));
} finally { sleeper.kill(); fs.rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `laptop-tui-remote: ${fails} FAILED` : "laptop-tui-remote: all pass");
process.exit(fails ? 1 : 0);
