// J363 / J365: what hyprpi plugs into pi-doorman's window (the generic review hook, PI_DOORMAN_REVIEW_MODULE). The window is an ARCHIVE plus the
// place where Angus decides what the Doorman's sandbox holds for him; nothing else can be typed there and nothing typed reaches the Doorman model.
//   - current(): the relay's OWN pending record (lib/held.mjs), oldest first, never text from the Doorman model.
//   - decide(id, choice, edited?): the same guarded host path as the Thoughts panel (actOnHeld -> sbx-relay.mjs approve | deny: a real terminal and
//     no agent ancestor). With an edited text ("approve with modifications"), the relay's CLI re-checks the edit on the host (a research plan's
//     searches go through the research runner's planCheck; a message is cleaned and size-limited) and keeps the original and the edit.
//   - edit(id): the editable text of the item on screen (a research plan's searches, a message's text), for the window's editor.
//   (J363's "Research: ..." typed in the window was removed in J365: nothing but a decision is typed there.)
import { heldForSandboxes, parseChoice, actOnHeld, heldStatus, trackHeld } from "../../lib/held.mjs";
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
    edit(id) { const h = first(); if (!h || h.id !== id || !h.editable) return null; return { text: h.editText, hint: h.editHint }; },
    decide(id, k, edited, note) { // J370: note = Angus's note for r (send it back) or his reason for 2 (deny)
      const h = first();
      if (!h || h.id !== id) return { ok: false, text: "that request is no longer the one waiting; nothing was decided" };
      if (!h.choices.includes(k) || k === "e") return { ok: false, text: `${k} isn't a decision for this request` };
      if (note !== undefined && k !== "r" && k !== "2" && k !== "a") return { ok: false, text: "only r (send back), 2 (deny) or a (answer) carries a note" };
      if (k === "a") { // J385: Angus's answer to a host agent's question (the Doorman bridge): his words, through the guarded CLI
        if (!h.answer) return { ok: false, text: "a (answer) only fits a host agent's question" };
        if (!note || !String(note).trim()) return { ok: false, text: "a needs your answer" };
        if (heldStatus(id, Date.now(), { fresh: true }).state !== "pending") return { ok: false, text: "that request was already decided" };
        return actOnHeld(id, { verdict: "answer" }, "doorman window", undefined, String(note));
      }
      if (k === "r") { if (!note || !String(note).trim()) return { ok: false, text: "r needs your note" }; if (heldStatus(id, Date.now(), { fresh: true }).state !== "pending") return { ok: false, text: "that request was already decided" }; return actOnHeld(id, { verdict: "return" }, "doorman window", undefined, String(note)); }
      if (edited !== undefined && (!h.editable || k !== "1")) return { ok: false, text: "only approve can carry an edit, and only for an editable request" };
      if (heldStatus(id, Date.now(), { fresh: true }).state !== "pending") return { ok: false, text: "that request was already decided" };
      const choice = parseChoice(k);
      if (!choice || !["approve", "deny", "allow"].includes(choice.verdict)) return { ok: false, text: "not a choice" };
      return actOnHeld(id, choice, "doorman window", edited, note && k === "2" ? String(note) : "");
    },
    // J372: what is in effect for the sandbox this Doorman serves: search provider and models, report model, Doorman model, mode, level (one dim line under the header)
    info() { const now = Date.now(); if (infoCache.t && now - infoCache.t < 5000) return infoCache.v; let v = ""; try { const served = own.find((x) => x !== name) || name, c = researchConf(served); v = `${served}: ${summaryLine(c.gateway)}`; } catch { /* no line */ } infoCache = { t: now, v }; return v; },
    track(id) { return trackHeld(id); }, // where the decided request is now (pinned under the conversation)
  };
}
