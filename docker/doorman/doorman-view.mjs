#!/usr/bin/env node
// The Doorman's log and window now live in the pi-doorman package (github.com/angusforbes/pi-doorman, a hyprpi requirement,
// J331). This thin wrapper keeps hyprpi's paths and commands working and supplies what's hyprpi's: its state folder, the
// state folder, and the world's colour and labels (below).
//   doorman-view.mjs log NAME | view NAME [--write]   (J365: the window is an archive + decisions; nothing typed there reaches the Doorman)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { worldHex } from "../../lib/tui/term.mjs";

const HOME = os.homedir();
const candidates = [process.env.PI_DOORMAN_DIR, path.join(HOME, "Harness", "pi-doorman"), path.join(HOME, ".pi", "agent", "git", "github.com", "angusforbes", "pi-doorman")].filter(Boolean);
const pkg = candidates.find((d) => fs.existsSync(path.join(d, "src", "view.mjs")));
if (!pkg) { console.error("doorman-view: pi-doorman isn't installed (run: hyprpi integration install pi-packages)"); process.exit(3); }

// J533 (Angus): the window looks like the world's other panels: "doorman G" at the top, "hyprpi doorman [G]" in the footer with the
// letter on the world's colour. The world is the doorman's name's letter (doorman-g -> G); its colour comes from the panels' own
// lib/tui/term.mjs, so it always matches them.
const WORLD = (String(process.argv[3] || "").match(/-([a-i])$/i)?.[1] || "G").toUpperCase();
process.env.PI_DOORMAN_STATE ||= process.env.HYPRPI_DOORMEN_DIR || path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "hyprpi", "doormen");
process.env.PI_DOORMAN_LABEL ||= process.env.DOORMAN_LABEL || "";
if (!process.env.PI_DOORMAN_LABEL) delete process.env.PI_DOORMAN_LABEL;
process.env.PI_DOORMAN_COLOR ||= worldHex(WORLD) || "e08a2e";
process.env.PI_DOORMAN_PROMPT ||= WORLD; // the prompt letter, like the world's other panels ("G ❯")
process.env.PI_DOORMAN_TITLE ||= `doorman ${WORLD}`; // like "thoughts G" (no icon: Angus, J533; the 🚪 stays on its reply lines)
process.env.PI_DOORMAN_FOOTER ||= "hyprpi doorman";
process.env.PI_DOORMAN_BADGE ||= WORLD;
process.env.PI_DOORMAN_REVIEW_MODULE ||= path.join(path.dirname(new URL(import.meta.url).pathname), "review-provider.mjs"); // J363: held items are reviewed in this window

const { runView } = await import(pathToFileURL(path.join(pkg, "src", "view.mjs")).href);
const [cmd, a, b] = process.argv.slice(2);
runView(cmd, a, b);
