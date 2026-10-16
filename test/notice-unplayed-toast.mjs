import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
// J722 (nss5): a remote world's bonks/dings that are too old, or whose play fails, give ONE toast per world per spell.
//   node test/run.mjs test/notice-unplayed-toast.mjs   (pure: fake notices, fake player, fake toast sink; no process, sound or notify-send)
import { pickNotices, noticeSpell } from "../omnistation/auto-open.mjs";
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const toasts = [], logs = [], ctx = { world: "H", toast: (t) => toasts.push(t), log: (l) => logs.push(l) };
const player = { fail: false, play(st, n) { noticeSpell(st, this.fail ? { failed: 1, why: "bonk exited 1" } : { played: 1 }, ctx); } };
const pass = (list, st, now) => { const p = pickNotices(list, st, now); noticeSpell(st, {}, ctx); for (const n of p) player.play(st, n); return p; };
const t0 = 1e12, st = {};
pass([], st, t0); // first look
const old = (i, kind = "bonk") => ({ ts: t0 - 200e3 - i, kind, id: "h-a", text: "x" + i });
pass([old(1), old(2), old(3, "chime")], st, t0 + 1000);
ok("old notices: one toast, N=2 (chime not counted), world named", toasts.length === 1 && /^World H: 2 bonks\/dings from world H weren't played \(too old\)/.test(toasts[0]), JSON.stringify(toasts));
ok("a log line too", logs.length === 1);
pass([old(1), old(2), old(4), old(5)], st, t0 + 2000);
ok("more skipped in the same spell: log only, no new toast", toasts.length === 1 && logs.length === 2, JSON.stringify(toasts));
const fresh = { ts: t0 + 3000, kind: "bonk", id: "h-a", text: "now" };
ok("a fresh one plays", pass([fresh], st, t0 + 3500).length === 1);
pass([old(9)], st, t0 + 4000);
ok("play ok, then a skip: a new toast", toasts.length === 2 && /1 bonk\/ding from world H/.test(toasts[1]), JSON.stringify(toasts));
player.fail = true;
const st2 = {}; pass([], st2, t0);
pass([{ ts: t0 + 10, kind: "ding", id: "h-a", text: "q" }], st2, t0 + 20);
ok("a play failure counts, with its reason", toasts.length === 3 && /failed: bonk exited 1/.test(toasts[2]) && /1 bonk\/ding from world H/.test(toasts[2]), JSON.stringify(toasts));
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
