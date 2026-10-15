#!/usr/bin/env node
// J593 (Angus: "i cant think of any reason to change the filename!"): SUPER+V / Ctrl+V of the same clipboard image reuses
// one file. A throwaway HOME, config and fake wl-paste on PATH (no real clipboard, no daemon, no windows).
//   W1 panels: the input box's paste (lib/tui/input-box.mjs clipboardPaste, as the Thoughts/room/board panels use it):
//      the same image twice -> the same ~/Screenshots path and one file; a different image -> a new path.
//   W1 agent windows: the hyprpi pi extension's Shift+Insert (SUPER+V) handler, with stub pi packages: the same.
//   Also: text still pastes as text; an existing file of the right name is reused, not rewritten; the file is 0600.
//   node test/run.mjs test/paste-dedupe.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };

const T = fs.mkdtempSync(path.join(os.tmpdir(), "j593-"));
const H = path.join(T, "home"), BIN = path.join(T, "bin"), CLIP = path.join(T, "clip");
fs.mkdirSync(path.join(H, "Screenshots"), { recursive: true }); fs.mkdirSync(BIN); fs.mkdirSync(path.join(T, "cfg", "hyprpi"), { recursive: true });
process.env.HOME = H; process.env.XDG_CONFIG_HOME = path.join(T, "cfg"); process.env.XDG_STATE_HOME = path.join(T, "state");
process.env.PATH = `${BIN}:${process.env.PATH}`;
// fake wl-paste: CLIP/type holds the mime type (or "text"), CLIP/data the bytes; every call is logged
fs.writeFileSync(path.join(BIN, "wl-paste"), `#!/bin/sh
echo "$@" >> "${T}/calls"
t=$(cat "${CLIP}/type")
case "$*" in
  *--list-types*) if [ "$t" = text ]; then echo text/plain; else echo "$t"; echo text/plain; fi ;;
  *text/plain*) [ "$t" = text ] && cat "${CLIP}/data" ;;
  *) cat "${CLIP}/data" ;;
esac
`, { mode: 0o755 });
fs.mkdirSync(CLIP);
const setClip = (type, data) => { fs.writeFileSync(path.join(CLIP, "type"), type); fs.writeFileSync(path.join(CLIP, "data"), data); };
const shots = () => fs.readdirSync(path.join(H, "Screenshots")).filter((f) => f.startsWith("pi-clipboard-")).sort();
const IMG1 = Buffer.from("\x89PNG\r\n\x1a\nfirst-image-bytes".repeat(50)), IMG2 = Buffer.from("\x89PNG\r\n\x1a\nsecond-image".repeat(50));

const { clipboardPaste } = await import("../lib/tui/input-box.mjs");
const paste = () => new Promise((res) => { const t = setTimeout(() => res(null), 5000); clipboardPaste((p, o) => { clearTimeout(t); res({ p, o }); }); });

// --- panels (clipboardPaste, what the input box's paste() calls)
setClip("image/png", IMG1);
const a = await paste(), b = await paste();
ok("panel: an image pastes as a ~/Screenshots path", a && a.o?.image && /^~\/Screenshots\/pi-clipboard-[0-9a-f]{16}\.png$/.test(a.p), JSON.stringify(a));
ok("panel W1: the same image twice -> the same path", a && b && a.p === b.p, `${a?.p} / ${b?.p}`);
ok("panel W1: … and one file", shots().length === 1, JSON.stringify(shots()));
const f1 = path.join(H, a.p.slice(2));
ok("panel: the file holds the image, 0600", fs.readFileSync(f1).equals(IMG1) && (fs.statSync(f1).mode & 0o777) === 0o600);
const m0 = fs.statSync(f1).mtimeMs; await new Promise((r) => setTimeout(r, 30)); await paste();
ok("panel: a third paste reuses the file without rewriting it", fs.statSync(f1).mtimeMs === m0 && shots().length === 1);
setClip("image/png", IMG2);
const c = await paste();
ok("panel W1: a different image -> a new path and a second file", c && c.p !== a.p && shots().length === 2, JSON.stringify(shots()));
ok("panel: no leftover .part files", !fs.readdirSync(path.join(H, "Screenshots")).some((f) => f.endsWith(".part")));
setClip("image/jpeg", IMG1);
const j = await paste();
ok("panel: a JPEG keeps its .jpg extension", j && /\.jpg$/.test(j.p), j?.p);
setClip("text", "hello text");
const t = await paste();
ok("panel: text still pastes as text", t && t.p === "hello text" && !t.o?.image, JSON.stringify(t));

// --- agent windows: the pi extension's Shift+Insert handler (stub pi packages; the handler only, no session_start, no daemon)
for (const f of shots()) fs.unlinkSync(path.join(H, "Screenshots", f));
const STUB = "data:text/javascript," + encodeURIComponent("export class UserMessageComponent{}; export const getMarkdownTheme=()=>({}); export const VERSION='1.0.2'; export class InteractiveMode{}; export class Box{}; export class Text{}; export class Container{}; export const truncateToWidth=(s)=>s; export const Type=new Proxy({}, {get:()=>()=>({})}); export default {};");
const { register } = await import("node:module");
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, n) { if (s === "@earendil-works/pi-coding-agent" || s === "@earendil-works/pi-tui" || s === "typebox") return { url: ${JSON.stringify(STUB)}, shortCircuit: true }; return n(s, c); }`));
process.env.HYPRPI_AGENT_ID = "hp-j593test";
const shortcuts = {};
const pi = new Proxy({}, { get: (_, k) => k === "registerShortcut" ? (key, o) => { shortcuts[key] = o; } : k === "on" ? () => {} : () => {} });
const ext = await import("../pi-extension/index.ts");
ext.default(pi);
const h = shortcuts["shift+insert"]?.handler;
ok("agent: the extension registers Shift+Insert (SUPER+V)", typeof h === "function");
const agentPaste = () => new Promise((res) => { const tm = setTimeout(() => res(null), 5000); h({ ui: { pasteToEditor: (x) => { clearTimeout(tm); res(x); }, setStatus: () => {} } }); });
setClip("image/png", IMG1);
const p1 = await agentPaste(), p2 = await agentPaste();
ok("agent W1: the same image twice -> the same path", p1 && p1 === p2 && /pi-clipboard-[0-9a-f]{16}\.png$/.test(p1), `${p1} / ${p2}`);
ok("agent W1: … and one file", shots().length === 1, JSON.stringify(shots()));
ok("agent: the same name the panel gave this image (one name per content)", p1 === a.p, `${p1} vs ${a.p}`);
setClip("image/png", IMG2);
const p3 = await agentPaste();
ok("agent W1: a different image -> a new path and a second file", p3 && p3 !== p1 && shots().length === 2);

console.log(fails ? `paste-dedupe: ${fails} FAILED` : "paste-dedupe: all pass");
process.exit(fails ? 1 : 0);
