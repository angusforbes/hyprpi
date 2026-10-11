import fs from "node:fs";
import path from "node:path";

// J467 (Angus: "make all of it the same"): a G panel gets the same key and mouse options its HOST launcher gives kitty
// (mockups/<panel>: Ctrl+Enter / Ctrl+Tab / Ctrl+Shift+Tab / Shift+Space as CSI-u, Shift+click and Shift-selection to the
// panel, Ctrl+Shift-selection to kitty), read from that launcher so the two never drift. Host-chosen text (the sandbox's request
// names only the panel kind), and only options that change how a key or click reaches the program are taken: mouse_map with
// no action or a kitty selection, and map … send_text all <one CSI-u sequence>. Never clipboard or paste maps (G's paste stays
// the g_paste kitten) and never the launchers' Ctrl+click lines (sandbox-kitty.conf's kitten passes Ctrl+click to a panel).
export const PANEL_LAUNCHER = { router: "agents-tui", room: "room-tui", board: "board-tui", search: "search-tui" };
const OPT_OK = [/^mouse_map=(shift|ctrl\+shift)\+left (click|press|doublepress|triplepress) grabbed( mouse_selection (normal|word|line))?$/,
  /^map (ctrl|shift|alt|ctrl\+shift|alt\+shift)\+(enter|tab|space) send_text all \\x1b\[[0-9]{1,3};[0-9]u$/,
  /^map (ctrl|shift|alt|ctrl\+shift|alt\+shift)\+[a-z0-9_]{1,12} no_op$/]; // (a key the host panel turns off, e.g. the search panel's Shift+Insert)
export function panelOpts(H, kind) {
  const f = PANEL_LAUNCHER[kind]; if (!f) return [];
  let t = ""; try { t = fs.readFileSync(path.join(H, "mockups", f), "utf8"); } catch { return []; }
  const out = [];
  for (const m of t.matchAll(/-o (?:'([^'\n]*)'|"([^"\n]*)")/g)) { const v = m[1] ?? m[2]; if (OPT_OK.some((re) => re.test(v)) && !out.includes(v)) out.push(v); }
  return out;
}
