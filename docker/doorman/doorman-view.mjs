#!/usr/bin/env node
// The Doorman's log and window now live in the pi-doorman package (github.com/angusforbes/pi-doorman, a hyprpi requirement,
// J331). This thin wrapper keeps hyprpi's paths and commands working and supplies what's hyprpi's: its state folder, the
// "[Angus · developer window" marker (the sandbox extension checks it), the unit name prefix, and the world's colour
// (world G = the 7th palette entry of the Omarchy theme, same as the panels).
//   doorman-view.mjs log NAME | view NAME [--write] | fifo-line TEXT
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const candidates = [process.env.PI_DOORMAN_DIR, path.join(HOME, "Harness", "pi-doorman"), path.join(HOME, ".pi", "agent", "git", "github.com", "angusforbes", "pi-doorman")].filter(Boolean);
const pkg = candidates.find((d) => fs.existsSync(path.join(d, "src", "view.mjs")));
if (!pkg) { console.error("doorman-view: pi-doorman isn't installed (run: hyprpi integration install pi-packages)"); process.exit(3); }

function worldHex() {
  try { const t = {}; for (const l of fs.readFileSync(path.join(HOME, ".local", "state", "omarchy", "current", "theme", "colors.toml"), "utf8").split("\n")) { const m = l.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?#([0-9A-Fa-f]{6})/); if (m) t[m[1]] = m[2]; } return t.orange || t.color11 || "e08a2e"; } catch { return "e08a2e"; }
}
process.env.PI_DOORMAN_STATE ||= process.env.HYPRPI_DOORMEN_DIR || path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "hyprpi", "doormen");
process.env.PI_DOORMAN_MARKER ||= "[Angus · developer window";
process.env.PI_DOORMAN_UNIT_PREFIX ||= "hyprpi-doorman-";
process.env.PI_DOORMAN_LABEL ||= process.env.DOORMAN_LABEL || "";
if (!process.env.PI_DOORMAN_LABEL) delete process.env.PI_DOORMAN_LABEL;
process.env.PI_DOORMAN_COLOR ||= worldHex();

const { runView } = await import(pathToFileURL(path.join(pkg, "src", "view.mjs")).href);
const [cmd, a, b] = process.argv.slice(2);
runView(cmd, a, b);
