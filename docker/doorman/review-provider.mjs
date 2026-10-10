// J363: what hyprpi plugs into pi-doorman's window (the generic review hook, PI_DOORMAN_REVIEW_MODULE). The window is where Angus
//   - decides what the Doorman's sandbox holds for him: current() is the relay's OWN pending record (lib/held.mjs), oldest first, never
//     text from the Doorman model; decide() goes through the same guarded host path as the Thoughts panel (actOnHeld → sbx-relay.mjs
//     approve | deny: a real terminal and no agent ancestor); the choice never reaches the model.
//   - SUGGESTS requests when nothing is held: "Research: …" / "Research (deep): …" starts the sandbox's research flow on the host as
//     Angus's own request (a drop-box message exactly like the gateway's; the relay's usual checks, the Doorman's plan and vetting, and the
//     review of the deliverable all apply). Anything else he types is chat with the Doorman (which can draft tasks, GPU leases, requests).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { heldForSandboxes, parseChoice, actOnHeld, heldStatus, trackHeld } from "../../lib/held.mjs";

const HOME = os.homedir();
const CONF = process.env.HYPRPI_RELAY_CONF || path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi", "sbx-relay.json");
const tilde = (p) => String(p || "").replace(/^~(?=\/|$)/, HOME);
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
export const RESEARCH_RE = /^\s*research\s*(?:\(\s*(deep|quick)\s*\))?\s*:[ \t]*([\s\S]+)$/i;

function entries(name) {
  let c = {}; try { c = JSON.parse(fs.readFileSync(CONF, "utf8")); } catch { /* */ }
  const list = Array.isArray(c.sandboxes) ? c.sandboxes : [], me = list.find((x) => x?.name === name) || {};
  const served = list.find((x) => x?.name === me.doorman_for) || null;
  return { me, served, names: [name, me.doorman_for].filter(Boolean) };
}

// Write `file` into a directory the SANDBOX controls without ever following one of its symlinks: every component is opened with
// O_NOFOLLOW (the directory inode is pinned by fd), and the file is created exclusively under the pinned directory.
function writeInto(dir, file, data) {
  const parts = path.resolve(dir).split("/").filter(Boolean);
  let fd = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    for (const name of parts) { const nfd = fs.openSync(`/proc/self/fd/${fd}/${name}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); fs.closeSync(fd); fd = nfd; }
    const base = `/proc/self/fd/${fd}`, tmp = `${base}/.${file}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, `${base}/${file}`);
  } finally { fs.closeSync(fd); }
}

export default function createReview(name) {
  const { served, names } = entries(name);
  const first = () => heldForSandboxes(names)[0] || null;
  return {
    current() { const h = first(); return h ? { id: h.id, text: h.text, choices: h.choices } : null; },
    decide(id, k) {
      const h = first();
      if (!h || h.id !== id) return { ok: false, text: "that request is no longer the one waiting; nothing was decided" };
      if (!h.choices.includes(k)) return { ok: false, text: `${k} isn't offered for this request` };
      if (heldStatus(id, Date.now(), { fresh: true }).state !== "pending") return { ok: false, text: "that request was already decided" };
      const choice = parseChoice(k);
      if (!choice || !["approve", "deny", "allow"].includes(choice.verdict)) return { ok: false, text: "not a choice" };
      return actOnHeld(id, choice, "doorman window");
    },
    track(id) { return trackHeld(id); }, // where the decided request is now (pinned under the conversation)
    suggest(line) {
      const m = RESEARCH_RE.exec(String(line ?? ""));
      if (!m) return null; // not a request: chat with the Doorman
      const want = clean(m[2]), depth = (m[1] || "quick").toLowerCase();
      if (!want) return { ok: false, text: 'say what you are looking for after "Research:"' };
      if (Buffer.byteLength(want) > 1000) return { ok: false, text: "not sent: a research request is at most 1000 bytes" };
      const ws = served && tilde(served.workspace);
      if (!ws) return { ok: false, text: "no sandbox is configured for this Doorman" };
      try {
        const file = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`;
        writeInto(path.join(ws, ".hyprpi-dropbox", "outbox"), file, JSON.stringify({ op: "research", looking_for: want, depth, from: "Angus (window)" }));
      } catch (e) { return { ok: false, text: `couldn't reach the relay's drop-box: ${e.code || e.message}` }; }
      return { ok: true, text: `research (${depth}) sent for ${served.name} as your own request; its plan or deliverable will appear here when held for you` };
    },
  };
}
