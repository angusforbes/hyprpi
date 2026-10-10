// J363 / J412: what hyprpi plugs into pi-doorman's window (the generic review hook, PI_DOORMAN_REVIEW_MODULE). The window is an ARCHIVE plus the
// place where Angus decides what the Doorman's sandbox holds for him; nothing else can be typed there and nothing typed reaches the Doorman model.
//   - current(): the relay's OWN pending record (lib/held.mjs), oldest first, never text from the Doorman model.
//   - decide(id, key, text?, { minutes }?): 1 / 1+ / 2 through the same guarded host path as the Thoughts panel (actOnHeld -> sbx-relay.mjs
//     approve | deny: a real terminal and no agent ancestor). (J412: the edit "e", send-back "r", "3" and answer "a" are gone.)
import { heldForSandboxes, actOnHeld, heldStatus, trackHeld } from "../../lib/held.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { conf as researchConf } from "../research/research.mjs";
import { summaryLine } from "../research/gateway.mjs";
const HOME = os.homedir();
const CONF = process.env.HYPRPI_RELAY_CONF || path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi", "sbx-relay.json");

function names(name) {
  let c = {}; try { c = JSON.parse(fs.readFileSync(CONF, "utf8")); } catch { /* */ }
  const me = (Array.isArray(c.sandboxes) ? c.sandboxes : []).find((x) => x?.name === name) || {};
  return [name, me.doorman_for].filter(Boolean);
}

export default function createReview(name) {
  const own = names(name); let infoCache = { t: 0, v: "" };
  const first = () => heldForSandboxes(own)[0] || null;
  return {
    current() { const h = first(); return h ? { id: h.id, text: h.text, title: h.title, choices: h.choices, reason: h.reason === true, answer: h.answer === true } : null; },
    // J412 (spec 2): k is "1" (approve; with text: the asker is told it), "1+" (approve and allow similar; opts.minutes, default 60), or "2"
    // (back to the asker with why it was held, plus the text). A host agent's question: "1 text" answers it, a bare 1 is refused, 2 declines.
    decide(id, k, note = "", opts = {}) {
      const h = first();
      if (!h || h.id !== id) return { ok: false, text: "that request is no longer the one waiting; nothing was decided" };
      if (!h.choices.includes(k)) return { ok: false, text: k === "1+" ? "1+ (allow similar) fits only a plain message to a peer; type 1" : `${k} isn't a decision for this request` };
      const text = String(note ?? "").trim();
      if (h.answer && k === "1" && !text) return { ok: false, text: "say what to answer: 1 followed by your answer" };
      if (heldStatus(id, Date.now(), { fresh: true }).state !== "pending") return { ok: false, text: "that request was already decided" };
      const choice = k === "1" ? { verdict: "approve" } : k === "1+" ? { verdict: "allow", minutes: Math.round(Number(opts.minutes) || 60) } : k === "2" ? { verdict: "deny" } : null;
      if (!choice) return { ok: false, text: "not a choice" };
      return actOnHeld(id, choice, "doorman window", text);
    },
    // J372: what is in effect for the sandbox this Doorman serves: search provider and models, report model, Doorman model, mode, level (one dim line under the header)
    info() { const now = Date.now(); if (infoCache.t && now - infoCache.t < 5000) return infoCache.v; let v = ""; try { const served = own.find((x) => x !== name) || name, c = researchConf(served); v = `${served}: ${summaryLine(c.gateway)}`; } catch { /* no line */ } infoCache = { t: now, v }; return v; },
    track(id) { return trackHeld(id); }, // where the decided request is now (pinned under the conversation)
  };
}
