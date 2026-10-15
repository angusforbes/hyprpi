// J650 (Angus: "for important decisions like this i may need a repeated bonk. If i miss it, i want you to remind me
// every ... 10 minutes"; his answers 43a 44b 45 46a 47a 48b): repeated reminders for IMPORTANT Decide items.
//
// Levels (43a): normal = the one phone push a Decide item already gets (J528); important = that push, then a reminder
// every remindEveryMin (10) minutes until it's answered, its reminders are stopped or snoozed, or remindRounds (12, so
// 2 h) have gone by, which ends with one last "still waiting, no more reminders" push (47a). No quiet hours (46a).
// Who sets it (44b): the agent filing the item (board_update importance), a project default in hyprpi.jsonc
// (decisions.projects: { "mathbac": "important" }), and Angus on the card (/important D6, /normal D6). An item's own
// level wins over the project's.
// How it stops (45): answering it (it leaves the Decide section), or on Angus's word, the asking agent (board_update
// edit reminders: "stop" / "snooze" + minutes / "resume") or Thoughts (decision_reminders). No phone buttons.
// One reminder per round, never one per item: a round lists every open important decision with its options. It goes to
// the phone (ntfy, kind "decision") and, with decisions.toast, as a desktop notification (48b). While the laptop sleeps
// nothing goes out; the first tick after waking sends ONE round, not the ones it missed.
// Per-item bookkeeping (rounds, last reminder) lives in STATE/decision-reminders.json, not on the board, so a round
// doesn't rewrite every card; stop / snooze / level live on the item itself (remindOff, snoozeUntil, importance).

import fs from "node:fs";

export const LEVELS = ["normal", "important"];
export const REMIND_DEFAULTS = { remindEveryMin: 10, remindRounds: 12, toast: true, projects: {} };

// An item's level: its own (set by the filing agent or Angus) wins, else its project's default, else normal.
export function levelOf(it, project, conf = REMIND_DEFAULTS) {
  if (LEVELS.includes(it?.importance)) return it.importance;
  const d = project && (conf.projects || {})[String(project.name || "").replace(/^@/, "")];
  return LEVELS.includes(d) ? d : "normal";
}

// The open important decisions across the boards: [{ key, room, project|null, it }].
export function openImportant(boardList, conf = REMIND_DEFAULTS, skipRoom = () => false) {
  const out = [];
  for (const b of boardList) {
    if (skipRoom(b.room)) continue;
    for (const p of b.projects || []) {
      if (p.status === "archived") continue;
      for (const it of p.items || []) if (it.sec === "decide" && !it.archived && levelOf(it, p, conf) === "important") out.push({ key: `${b.room}:${p.id}:${it.h}`, room: b.room, project: p, it });
    }
    for (const it of b.unfiled || []) if (levelOf(it, null, conf) === "important") out.push({ key: `${b.room}:unfiled:${it.h}`, room: b.room, project: null, it });
  }
  return out;
}

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
// One line per decision, then its options (lettered as on the card, the recommended one marked).
export function roundText(list, { final = false } = {}) {
  const lines = [];
  for (const x of list) {
    lines.push(`${x.room} @${x.project?.name || "unfiled"} ${x.it.h}: ${clip(x.it.text, 300)}`);
    for (const o of x.it.options || []) lines.push(`  ${o.key}. ${clip(o.text, 100)}${x.it.recommend === o.key ? " (recommended)" : ""}`);
  }
  lines.push(final ? "No more reminders for these. Answer on the board (Projects panel or the phone app), or tell the asking agent or Thoughts." : "Answer on the board (Projects panel or the phone app). To stop these reminders, tell the asking agent or Thoughts.");
  return lines.join("\n");
}

// deps: boards() -> [board], policy() -> decisions conf, push(kind, info), toast({ title, body }), log, now(), skipRoom(room)
export function createReminders({ stateFile, boards, policy = () => REMIND_DEFAULTS, push = () => ({}), toast = () => {}, log = () => {}, now = () => Date.now(), skipRoom = () => false }) {
  let st = { items: {} };
  try { st = { items: {}, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch { /* first run */ }
  const save = () => { try { fs.writeFileSync(stateFile + ".tmp", JSON.stringify(st)); fs.renameSync(stateFile + ".tmp", stateFile); } catch (e) { log("decision reminders: state not saved:", e.message); } };
  const conf = () => ({ ...REMIND_DEFAULTS, ...(policy() || {}) });

  // One pass: send a round if any important decision is due. -> null, or { sent: [keys], final: [keys] }
  function tick() {
    const t = now(), C = conf(), every = (Number(C.remindEveryMin) > 0 ? Number(C.remindEveryMin) : 10) * 60e3, max = Math.max(1, Number(C.remindRounds) || 12);
    const list = openImportant(boards(), C, skipRoom), keys = new Set(list.map((x) => x.key));
    let changed = false;
    for (const k of Object.keys(st.items)) if (!keys.has(k)) { delete st.items[k]; changed = true; } // answered, dropped or no longer important
    const active = list.filter((x) => !x.it.remindOff && !(Number(x.it.snoozeUntil) > t) && !st.items[x.key]?.capped);
    // A round goes out when some item's last push (its own first push, or the last round) is an interval old. It takes
    // every item whose last push is at least HALF an interval old, so items filed at different times fall into step
    // (no item is pushed twice within half an interval: J650check, items filed a minute apart got rounds at +10 and +11).
    const since = (x) => t - (st.items[x.key]?.last || x.it.ts || t);
    if (!active.some((x) => since(x) >= every)) { if (changed) save(); return null; }
    const inRound = active.filter((x) => since(x) >= every / 2);
    const final = [];
    for (const x of inRound) if ((st.items[x.key]?.rounds || 0) + 1 >= max) final.push(x);
    const more = inRound.filter((x) => !final.includes(x)), n = inRound.length, plural = n === 1 ? "decision" : "decisions";
    const title = !more.length ? `🔔 Still waiting, no more reminders: ${n} ${plural}` : `🔔 Reminder: ${n} important ${plural} waiting`;
    const text = !more.length ? roundText(final, { final: true })
      : roundText(more) + (final.length ? `\n\nLast reminder (no more after this): ${final.map((x) => `@${x.project?.name || "unfiled"} ${x.it.h}`).join(", ")}` : "");
    const r = push("decision", { key: `remind:${t}`, title, text, world: [...new Set(inRound.map((x) => x.room))].join(" "), agent: "", project: "", options: [], hint: "" }) || {};
    // Dropped by the phone's hourly cap (or the push failed to start): this round didn't happen. Nothing is counted, no
    // toast, and the next tick tries again, so the cap can't eat rounds, or the last "no more reminders" push (J650check).
    // (Phone pushes switched off, or no topic: the round still counts, as a toast.)
    if (r.sent === false && !/enabled is false|no phone\.ntfy\.topic|isn't in phone\.ntfy\.kinds/.test(r.why || "")) {
      if (st.heldWhy !== r.why) { st.heldWhy = r.why; save(); log(`decision reminders: round held back (${r.why}); trying again next minute`); }
      return { held: r.why || "not sent", sent: [], final: [] };
    }
    if (st.heldWhy) delete st.heldWhy;
    for (const x of inRound) { const s = (st.items[x.key] ||= { rounds: 0, last: 0 }); s.rounds++; s.last = t; if (final.includes(x)) s.capped = true; }
    save();
    if (C.toast) { try { toast({ title, body: text }); } catch (e) { log("decision reminders: toast:", e.message); } }
    log(`decision reminders: round for ${inRound.map((x) => x.key).join(", ")}${final.length ? `; last for ${final.map((x) => x.key).join(", ")}` : ""}${r.sent === false ? ` (phone: ${r.why || "not sent"})` : ""}`);
    return { sent: inRound.map((x) => x.key), final: final.map((x) => x.key) };
  }
  // A stopped / snoozed item started again, or its level changed: count its rounds from zero.
  function reset(key) { if (st.items[key]) { delete st.items[key]; save(); } }
  const state = () => JSON.parse(JSON.stringify(st));
  return { tick, reset, state };
}
