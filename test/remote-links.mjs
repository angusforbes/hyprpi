#!/usr/bin/env node
// J553 (2): a link a REMOTE agent prints in its laptop window (omnistation/remote-client.mjs in kitty) names something on the remote
// machine (file:///home/aforbes/work/x.png). The window's kitty hands every Ctrl+clicked link to `laptop-act.mjs X url` (its
// open_url_with, set by `world X open`), which opens http(s) here and copies a file:// path over from the machine (as the remote
// panels do), and refuses anything else. Without a network or a desktop:
//   A) `world H open NAME` (stub hyprctl / pi / setsid; a throwaway binding and client deps): the kitty line it dispatches gives the
//      window that opener (and only for its own letter)
//   B) laptop-act H url …: a remote file (spaces / %-escapes, a #fragment) is copied to ~/Downloads/hyprpi-h/ (600) and opened; an
//      executable type only gets its folder opened; http(s) opens with gio; another host, another scheme, a control character or a
//      bad escape is refused (a notification, nothing run)
//   node test/remote-links.mjs   (exit 0 = pass)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x && !c ? ": " + x : ""}`); };
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j553l-")), B = path.join(T, "bin"); fs.mkdirSync(B);
const F = (n) => path.join(T, n), read = (n) => { try { return fs.readFileSync(F(n), "utf8"); } catch { return ""; } };
const exe = (f, s) => fs.writeFileSync(f, s, { mode: 0o755 });
for (const t of ["gio", "xdg-open", "notify-send", "setsid"]) exe(path.join(B, t), `#!/bin/sh\necho "${t} $*" >> ${F("ran.log")}\n`);
exe(path.join(B, "hyprctl"), `#!/bin/sh\ncase "$1 $2" in "-j "*) echo '[]';; *) printf '%s\\n' "$*" >> ${F("hypr.log")};; esac\n`);
exe(path.join(B, "pi"), "#!/bin/sh\nexit 1\n");
const base = { ...process.env, PATH: `${B}:${process.env.PATH}`, HOME: T, XDG_RUNTIME_DIR: T, XDG_CACHE_HOME: path.join(T, "cache"), HYPRPI_ALLOW_HYPR: "1" };
for (const k of ["HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "DISPLAY", "HYPRPI_AGENT_ID", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "KITTY_CONFIG_DIRECTORY", "HYPRPI_OPEN_WS"]) delete base[k];
try {
  // ---- A) world H open: the window's kitty gets laptop-act's `url` as its link opener
  exe(F("ssh"), `#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n`);
  fs.writeFileSync(F("binding.json"), JSON.stringify({ ssh: [F("ssh"), "h"], workspace: 71 }));
  const deps = path.join(T, "deps"), pj = path.join(deps, "node_modules/@earendil-works/pi-coding-agent");
  fs.mkdirSync(pj, { recursive: true }); fs.writeFileSync(path.join(pj, "package.json"), '{"version": "0.0.0"}');
  const name = `zzlinks${process.pid}`;
  const out = execFileSync(path.join(ROOT, "omnistation/world"), ["H", "open", name], { env: { ...base, HYPRPI_REMOTE_CONF: F("binding.json"), HYPRPI_REMOTE_DEPS: deps }, encoding: "utf8" });
  const disp = read("hypr.log");
  const kline = /exec_cmd\(\[\[(.*)\]\]/.exec(disp)?.[1] || "";
  ok("world H open dispatches the window's kitty line", /kitty --class=hyprpi\.h-agent/.test(kline) && kline.includes(`remote-client.mjs H ${name}`), out + disp);
  // the -o argument, as kitty gets it (the line is run by a shell): split it the way bash does
  const argv = JSON.parse(execFileSync("bash", ["-c", `f() { node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"; }; f ${kline.replace(/ -- .*$/, "")}`], { encoding: "utf8" }));
  const o = argv[argv.indexOf("-o") + 1] || "";
  ok("… with laptop-act's `url` as its open_url_with, for world H", /^open_url_with=\S*node \S*\/omnistation\/laptop-act\.mjs H url$/.test(o) && argv.indexOf("-o") > argv.lastIndexOf("--config"), JSON.stringify(argv));
  ok("… and its path is this checkout's", o.includes(path.join(ROOT, "omnistation/laptop-act.mjs")), o);
  let kittyOk = null; // kitty's own parser (no window: kitty +runpy), when kitty is installed
  try { kittyOk = JSON.parse(execFileSync("kitty", ["+runpy", `import json, sys; from kitty.cli import parse_override; from kitty.config import load_config; print(json.dumps(load_config(${JSON.stringify(path.join(ROOT, "terminal-helpers/kitty/pi.conf"))}, overrides=[parse_override(sys.argv[-1])]).open_url_with))`, o], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] })); } catch { /* no kitty */ }
  if (kittyOk) ok("… which kitty reads as node laptop-act.mjs H url (over pi.conf's gio open)", kittyOk.length === 4 && kittyOk[1].endsWith("/omnistation/laptop-act.mjs") && kittyOk[2] === "H" && kittyOk[3] === "url", JSON.stringify(kittyOk));
  else console.log("skip  kitty's own parse (no kitty here)");

  // ---- B) laptop-act H url
  exe(F("world"), `#!/bin/sh\n[ "$2" = binding ] && echo '{"ssh":["${F("ssh")}","h"]}'\nexit 0\n`);
  const AENV = { ...base, HYPRPI_TEST: "1", HYPRPI_TEST_WORLD_CMD: F("world") };
  const act = (u) => { fs.rmSync(F("ran.log"), { force: true }); try { return execFileSync(process.execPath, [path.join(ROOT, "omnistation/laptop-act.mjs"), "H", "url", u], { env: AENV, encoding: "utf8", timeout: 20000 }); } catch (e) { return e.stdout || ""; } };
  const R = path.join(T, "remote dir"); fs.mkdirSync(R);
  fs.writeFileSync(path.join(R, "plot #1.png"), "PNGDATA");
  const dl = path.join(T, "Downloads/hyprpi-h");
  let r = act(`file://${encodeURI(R)}/plot%20%231.png#frag`);
  const got = path.join(dl, "plot__1.png");
  ok("a remote file:// link (escapes, a #fragment): copied to ~/Downloads/hyprpi-h (600) and opened", fs.existsSync(got) && fs.readFileSync(got, "utf8") === "PNGDATA" && (fs.statSync(got).mode & 0o777) === 0o600 && read("ran.log").includes(`gio open ${got}`), r + read("ran.log"));
  r = act(`file://localhost${encodeURI(R)}/plot%20%231.png`);
  ok("file://localhost/… is the same", read("ran.log").includes(`gio open ${got}`), r + read("ran.log"));
  fs.writeFileSync(path.join(R, "run.sh"), "#!/bin/sh\ntouch /tmp/pwned\n");
  r = act(`file://${encodeURI(R)}/run.sh`);
  ok("an executable type: copied, only its folder opened", fs.existsSync(path.join(dl, "run.sh")) && read("ran.log").includes(`gio open ${dl}`) && !read("ran.log").includes(`gio open ${path.join(dl, "run.sh")}`), r + read("ran.log"));
  act("https://example.com/x?y=1");
  ok("an http(s) link opens with gio", read("ran.log").includes("gio open https://example.com/x?y=1"), read("ran.log"));
  const refused = (u, why) => { const o2 = act(u); ok(`refused: ${why}`, !/^gio |^xdg-open /m.test(read("ran.log")) && /notify-send/.test(read("ran.log")) && /"error"/.test(o2), read("ran.log") + o2); };
  refused(`file://evil.example${encodeURI(R)}/plot%20%231.png`, "a file link naming another host");
  refused("javascript:alert(1)", "another scheme (javascript:)");
  refused("ssh://h/x", "another scheme (ssh:)");
  refused("kitty://x", "another scheme (kitty:)");
  refused(`file://${encodeURI(R)}/a%0Ab`, "a control character in the path");
  refused("file:///a%E0%A4%A", "a bad %-escape");
  refused("file://relative", "no path");
} finally { fs.rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `remote-links: ${fails} FAILED` : "remote-links: all pass");
process.exit(fails ? 1 : 0);
