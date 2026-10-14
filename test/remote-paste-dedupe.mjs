#!/usr/bin/env node
// J595 (Angus "37a", after J593): pasted images into remote worlds reuse one file per content, in each remote paste path.
// Throwaway HOME, fake wl-paste, stand-in `world` binding + ssh (runs the remote command locally); no network, no daemon, no windows.
//   A) omnistation/laptop-act.mjs paste (a remote world's panel pastes the laptop clipboard: uploaded over ssh to
//      ~/.hyprpi-<x>/clipboard/): the same image twice -> the same path and one file; a different image -> a new one.
//   B) lib/tui/laptop.mjs uploadImages (a link panel's pasted image) + omnistation/rlink-remote.mjs upload (the receiving side):
//      the same image -> the same name and one file there (not rewritten); a different image -> a new one.
//   C) docker/world/g_paste.py (world G's kitty paste kitten, host side): the same image -> the same path, one file; different -> new.
//   node test/run.mjs test/remote-paste-dedupe.mjs   (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { requireSandbox } from "./guard/sandbox.mjs";
await requireSandbox(import.meta.url);
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

const T = fs.mkdtempSync(path.join(os.tmpdir(), "j595-"));
const H = path.join(T, "home"), B = path.join(T, "bin"), CLIP = path.join(T, "clip");
for (const d of [H, B, CLIP, path.join(H, "Screenshots")]) fs.mkdirSync(d, { recursive: true });
const exe = (f, body) => fs.writeFileSync(f, body, { mode: 0o755 });
exe(path.join(B, "wl-paste"), `#!/bin/sh
t=$(cat "${CLIP}/type")
case "$*" in
  *--list-types*) echo "$t"; echo text/plain ;;
  *text/plain*) ;;
  *) cat "${CLIP}/data" ;;
esac
`);
exe(path.join(B, "notify-send"), "#!/bin/sh\nexit 0\n");
const setClip = (type, data) => { fs.writeFileSync(path.join(CLIP, "type"), type); fs.writeFileSync(path.join(CLIP, "data"), data); };
const IMG1 = Buffer.from("\x89PNG\r\n\x1a\nfirst-image".repeat(80)), IMG2 = Buffer.from("\x89PNG\r\n\x1a\nsecond-image".repeat(80));
const env = { ...process.env, HOME: H, PATH: `${B}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(T, "cfg"), XDG_STATE_HOME: path.join(T, "state") };
const files = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };

// ---- A) laptop-act.mjs paste
exe(path.join(T, "world"), `#!/bin/sh\n[ "$2" = binding ] && echo '{"ssh":["${path.join(T, "ssh")}","h"]}'\nexit 0\n`);
exe(path.join(T, "ssh"), `#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n`);
const AENV = { ...env, HYPRPI_TEST: "1", HYPRPI_TEST_WORLD_CMD: path.join(T, "world"), HYPRPI_TEST_PANELS_CMD: path.join(T, "world") };
const act = () => { const out = execFileSync(process.execPath, [path.join(ROOT, "omnistation/laptop-act.mjs"), "H", "paste"], { env: AENV, encoding: "utf8", timeout: 20000 }); return JSON.parse(out.trim().split("\n").pop()); };
const RD = path.join(H, ".hyprpi-h", "clipboard");
setClip("image/png", IMG1);
const a1 = act(), a2 = act();
ok("A laptop-act: an image pastes as ~/.hyprpi-h/clipboard/pi-clipboard-<16 hex>.png", /^~\/\.hyprpi-h\/clipboard\/pi-clipboard-[0-9a-f]{16}\.png $/.test(a1.inject || ""), JSON.stringify(a1));
ok("A W1 laptop-act: the same image twice -> the same path", a1.inject && a1.inject === a2.inject, `${a1.inject} / ${a2.inject}`);
ok("A W1 laptop-act: … and one file, no .part left", JSON.stringify(files(RD)) === JSON.stringify([a1.inject.trim().split("/").pop()]), JSON.stringify(files(RD)));
const fA = path.join(H, a1.inject.trim().slice(2));
ok("A laptop-act: the file holds the image, 0600", fs.readFileSync(fA).equals(IMG1) && (fs.statSync(fA).mode & 0o777) === 0o600);
const mA = fs.statSync(fA).mtimeMs; await new Promise((r) => setTimeout(r, 30)); act();
ok("A laptop-act: a third paste leaves the file as it was", fs.statSync(fA).mtimeMs === mA && files(RD).length === 1);
fs.writeFileSync(fA, Buffer.alloc(IMG1.length, 0)); act();
ok("A laptop-act: a same-named file with other bytes is repaired", fs.readFileSync(fA).equals(IMG1) && files(RD).length === 1);
setClip("image/png", IMG2);
const a3 = act();
ok("A W1 laptop-act: a different image -> a new path and a second file", a3.inject && a3.inject !== a1.inject && files(RD).length === 2, JSON.stringify(files(RD)));

// ---- B) uploadImages (laptop side) -> rlink-remote.mjs upload (receiving side)
const RW = path.join(T, "rhome", ".hyprpi-h"); fs.mkdirSync(path.join(RW, "state"), { recursive: true });
const remoteProc = spawn(process.execPath, [path.join(ROOT, "omnistation/rlink-remote.mjs")], { env: { ...env, HYPRPI_STATE: path.join(RW, "state"), HYPRPI_SOCKET: path.join(T, "no.sock") }, stdio: ["pipe", "pipe", "ignore"] });
let rbuf = ""; const waiting = new Map();
remoteProc.stdout.setEncoding("utf8");
remoteProc.stdout.on("data", (d) => { rbuf += d; let i; while ((i = rbuf.indexOf("\n")) >= 0) { const l = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; } if (m.t === "ur" && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
let nid = 0;
// api.call("link.upload") the way rlink.mjs carries it: a {t:"u"} frame to rlink-remote, answered {t:"ur"}
const api = { call: (method, p) => new Promise((res, rej) => { if (method !== "link.upload") return rej(new Error(method)); const id = ++nid; waiting.set(id, (m) => (m.error ? rej(new Error(m.error)) : res({ path: m.path }))); remoteProc.stdin.write(JSON.stringify({ t: "u", c: 1, id, name: p.name, data: p.data }) + "\n"); }) };
process.env.HYPRPI_REMOTE_LINK = "1";
const { uploadImages } = await import("../lib/tui/laptop.mjs");
const L1 = path.join(T, "local1.png"), L2 = path.join(T, "local1-copy.png"), L3 = path.join(T, "other.png");
fs.writeFileSync(L1, IMG1); fs.writeFileSync(L2, IMG1); fs.writeFileSync(L3, IMG2);
const up = (f) => uploadImages(api, `see ${f}`, [f], { to: true });
const RC = path.join(RW, "clipboard");
const b1 = await up(L1), b2 = await up(L2);
ok("B uploadImages: the image is uploaded and its path there replaces the laptop path", b1.images.length === 1 && /\/\.hyprpi-h\/clipboard\/pi-clipboard-[0-9a-f]{16}\.png$/.test(b1.images[0]) && b1.text === `see ${b1.images[0]}`, JSON.stringify(b1));
ok("B W1 upload: the same image twice (even from two laptop files) -> the same path there", b1.images[0] && b1.images[0] === b2.images[0], `${b1.images[0]} / ${b2.images[0]}`);
ok("B W1 upload: … and one file there, no .tmp left", files(RC).length === 1, JSON.stringify(files(RC)));
const fB = b1.images[0]; const mB = fs.statSync(fB).mtimeMs; await new Promise((r) => setTimeout(r, 30)); await up(L1);
ok("B upload: a byte-identical file there is kept, not rewritten", fs.statSync(fB).mtimeMs === mB && fs.readFileSync(fB).equals(IMG1) && (fs.statSync(fB).mode & 0o777) === 0o600);
const b3 = await up(L3);
ok("B W1 upload: a different image -> a new path and a second file there", b3.images[0] && b3.images[0] !== fB && files(RC).length === 2, JSON.stringify(files(RC)));
remoteProc.stdin.end(); remoteProc.kill();

// ---- C) g_paste.py (host side of world G's kitty paste); kittens.tui.handler stubbed (kitty's own module)
const KS = path.join(T, "pystub", "kittens", "tui"); fs.mkdirSync(KS, { recursive: true });
fs.writeFileSync(path.join(T, "pystub", "kittens", "__init__.py"), ""); fs.writeFileSync(path.join(KS, "__init__.py"), "");
fs.writeFileSync(path.join(KS, "handler.py"), "def result_handler(**kw):\n    return lambda f: f\n");
const py = (n) => execFileSync("python3", ["-c", `import sys; sys.path[:0] = [${JSON.stringify(path.join(T, "pystub"))}, ${JSON.stringify(path.join(ROOT, "docker/world"))}]\nimport g_paste\nprint(g_paste.save_clipboard_image())`], { env, encoding: "utf8" }).trim();
const SS = path.join(H, "Screenshots");
setClip("image/png", IMG1);
const c1 = py(), c2 = py();
ok("C g_paste: an image pastes as an absolute ~/Screenshots path", c1.startsWith(SS + "/pi-clipboard-") && /pi-clipboard-[0-9a-f]{16}\.png$/.test(c1), c1);
ok("C W1 g_paste: the same image twice -> the same path", c1 === c2, `${c1} / ${c2}`);
ok("C W1 g_paste: … and one file, no .part left", files(SS).length === 1, JSON.stringify(files(SS)));
ok("C g_paste: the file holds the image, 0600", fs.readFileSync(c1).equals(IMG1) && (fs.statSync(c1).mode & 0o777) === 0o600);
fs.writeFileSync(c1, Buffer.alloc(IMG1.length, 0)); py();
ok("C g_paste: a same-named file with other bytes is repaired", fs.readFileSync(c1).equals(IMG1) && files(SS).length === 1);
setClip("image/png", IMG2);
const c3 = py();
ok("C W1 g_paste: a different image -> a new path and a second file", c3 !== c1 && files(SS).length === 2, JSON.stringify(files(SS)));
setClip("image/jpeg", IMG1);
ok("C g_paste: a JPEG gets .jpg", /\.jpg$/.test(py()));

console.log(fails ? `remote-paste-dedupe: ${fails} FAILED` : "remote-paste-dedupe: all pass");
process.exit(fails ? 1 : 0);
