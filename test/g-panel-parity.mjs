#!/usr/bin/env node
// J467 v2 (Angus: G's panels "the same as in regular worlds"): the parts of G panel parity that can be checked offline.
//   1. docker/world/panel-opts.mjs reads each HOST panel launcher (mockups/agents-tui, room-tui, board-tui, search-tui) and gives a
//      G panel the same key and mouse options: Ctrl+Enter / Ctrl+Tab / Ctrl+Shift+Tab / Shift+Space as CSI-u, Shift+click and the
//      selection gestures, never a clipboard or paste map and never the launchers' Ctrl+click lines (G's kitten handles those).
//   2. A launcher line outside the allowlist (a launch, a paste, an open_url, another mapping) is never passed on.
//   3. world-helper's open() adds them to a panel window only (not an agent window), and sandbox-kitty.conf routes Ctrl+click to
//      the kitten in both modes (panel: on to the panel; agent: focus-word), with links still through open_url_with.
//   node test/g-panel-parity.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { panelOpts, PANEL_LAUNCHER } = await import(path.join(ROOT, "docker/world/panel-opts.mjs"));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const launcherOpts = (f) => [...fs.readFileSync(path.join(ROOT, "mockups", f), "utf8").matchAll(/-o (?:'([^'\n]*)'|"([^"\n]*)")/g)].map((m) => m[1] ?? m[2]);
for (const [kind, f] of Object.entries(PANEL_LAUNCHER)) {
  const host = launcherOpts(f), g = panelOpts(ROOT, kind);
  const want = host.filter((v) => /^map \S+ send_text all /.test(v) || /^mouse_map=(shift|ctrl\+shift)\+left /.test(v) || / no_op$/.test(v));
  ok(`${kind} (${f}): every host key/mouse routing option is applied in G`, want.every((v) => g.includes(v)) && g.length === want.length, JSON.stringify({ want, g }));
  ok(`${kind}: no clipboard/paste map and no Ctrl+click line`, !g.some((v) => /paste|copy|clipboard|ctrl\+left/.test(v)));
}
ok("Ctrl+Enter, Ctrl+Tab and Ctrl+Shift+Tab reach the G room and projects panels as on the host", ["room", "board"].every((k) => ["map ctrl+enter send_text all \\x1b[13;5u", "map ctrl+tab send_text all \\x1b[9;5u", "map ctrl+shift+tab send_text all \\x1b[9;6u"].every((v) => panelOpts(ROOT, k).includes(v))));
ok("an agent window and an unknown kind get nothing", panelOpts(ROOT, "agent").length === 0 && panelOpts(ROOT, "nope").length === 0);
// a launcher with hostile or unrelated lines: none passes
const T = fs.mkdtempSync(path.join(os.tmpdir(), "j467p-")); fs.mkdirSync(path.join(T, "mockups"));
fs.writeFileSync(path.join(T, "mockups", "room-tui"), [`exec kitty -o 'map ctrl+t launch sh' \\`, `-o 'map ctrl+v paste_from_clipboard' \\`, `-o "mouse_map=ctrl+left release grabbed" \\`, `-o 'open_url_with xterm' \\`,
  `-o 'map ctrl+enter send_text all \\x1b[13;5u; rm -rf ~' \\`, `-o "mouse_map=shift+left press grabbed mouse_handle_click link" \\`, `-o 'map ctrl+enter send_text all \\x1b[13;5u'`].join("\n"));
ok("hostile launcher lines are dropped; only the plain CSI-u map passes", JSON.stringify(panelOpts(T, "room")) === JSON.stringify(["map ctrl+enter send_text all \\x1b[13;5u"]), JSON.stringify(panelOpts(T, "room")));
fs.rmSync(T, { recursive: true, force: true });
const helper = fs.readFileSync(path.join(ROOT, "docker/world/world-helper.mjs"), "utf8"), conf = fs.readFileSync(path.join(ROOT, "docker/world/sandbox-kitty.conf"), "utf8");
ok("world-helper's open() adds the options to panels only", /const popts = kind === "agent" \? \[\] : panelOpts\(H, kind\)/.test(helper) && /"kitty", `--class=\$\{cls\}`, \.\.\.kconf, \.\.\.popts/.test(helper));
ok("sandbox-kitty.conf: Ctrl+click goes to the kitten (panel / agent), the press is discarded, links still open via open_url_with",
  /mouse_map ctrl\+left release grabbed kitten @G_AGENTCLICK@ panel/.test(conf) && /mouse_map ctrl\+left release ungrabbed kitten @G_AGENTCLICK@ agent/.test(conf) && /mouse_map ctrl\+left press grabbed,ungrabbed discard_event/.test(conf) && /open_url_with @G_OPEN@/.test(conf));
console.log(fails ? `g-panel-parity: ${fails} FAILED` : "g-panel-parity: all pass");
process.exit(fails ? 1 : 0);
