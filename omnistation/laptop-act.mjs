#!/usr/bin/env node
// omnistation/laptop-act.mjs LETTER ACTION [ARG] (J543): one thing a REMOTE world's panel asked the laptop to do, run by the panel
// window's pty relay (omnistation/pty-relay.py) after it checked the request (nonce, a matching local click or key, rate). Each
// does what the local panels do on the desktop, for the remote world's laptop windows:
//   focus NAME    the agent's laptop window (class hyprpi.<x>-agent running remote-client.mjs X NAME): jump to it (a parked one is
//                 brought to this workspace first), as the daemon's agent.focus does; no window: `world X open NAME` (only for an
//                 agent that has a session there), then jump to it once it maps
//   open URL      an http(s) link: gio open (as the local panels), else xdg-open
//   file PATH     a file on the remote machine: copied over ssh to ~/Downloads/hyprpi-<x>/ (600, at most 50 MB) and opened; a type
//                 that could run something (.desktop, .sh, …) is copied but only its folder is opened
//   panel KIND    one of this world's panels (agents room search board): jump to it, or bring / open it here (mockups/panels)
//   new           a new agent in this world (world X new); prints {"allow": NAME} so the relay lets the panel jump to it
//   url URL       J553: a link Ctrl+clicked in one of this world's AGENT windows on the laptop (kitty's open_url_with there, set by
//                 `world X open`): everything in that window comes from the remote machine, so an http(s) link opens as `open`,
//                 a file:// link (no host, or localhost) names a file THERE and goes to `file`; any other link is refused
//   paste         the laptop's clipboard: an image is uploaded to ~/.hyprpi-<x>/clipboard/pi-clipboard-<id>.<ext> there (600, at
//                 most 10 MB, the Thoughts limit) and {"inject": "~/.hyprpi-<x>/clipboard/… "} printed; text: {"inject": TEXT}
// Output: JSON lines for the relay ({"inject"}, {"allow"}, {"error"}). A failure also shows as a notification, since the panel's
// note can't hear back. Everything is validated again here; nothing a remote machine sends is ever run as a command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as hypr from "../lib/hypr.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [WL0, ACT, ARG = ""] = process.argv.slice(2);
const WL = String(WL0 || "").toUpperCase(), wl = WL.toLowerCase();
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const KINDS = { agents: { n: "1", title: "router" }, room: { n: "2", title: "room" }, search: { n: "3", title: "search" }, board: { n: "4", title: "board" } };
// tests only (HYPRPI_TEST=1): stand-ins for `world` and `mockups/panels`
const testing = process.env.HYPRPI_TEST === "1";
const WORLD = (testing && process.env.HYPRPI_TEST_WORLD_CMD) || path.join(HERE, "world");
const PANELS = (testing && process.env.HYPRPI_TEST_PANELS_CMD) || path.join(HERE, "..", "mockups", "panels");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function fail(msg) {
  say({ error: msg });
  try { spawn("notify-send", ["-a", "hyprpi", `world ${WL}: ${msg}`], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* none */ }
  process.exitCode = 1;
}
const run = (cmd, args, { input = null, env = process.env, timeout = 60000, maxBuffer = 64 << 20, encoding = "utf8" } = {}) => new Promise((res) => {
  const p = execFile(cmd, args, { env, timeout, maxBuffer, encoding }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr: String(stderr || "") }));
  p.stdin?.on("error", () => {}); p.stdin?.end(input ?? undefined); // (no input: closed at once, so an ssh never waits on it)
});
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // one argument for the remote POSIX shell

async function sshArgv() {
  const r = await run(WORLD, [WL, "binding"], { timeout: 15000 });
  let b; try { b = JSON.parse(r.stdout); } catch { return null; }
  return Array.isArray(b?.ssh) && b.ssh.length && b.ssh.every((x) => typeof x === "string") ? b.ssh : null;
}
async function remote(cmd, opts = {}) {
  const ssh = await sshArgv(); if (!ssh) return { code: 2, stdout: "", stderr: "no binding" };
  return run(ssh[0], [...ssh.slice(1), cmd], opts);
}

// the agent a laptop window shows: its process's command line (local, so trusted) ends in remote-client.mjs <LETTER> <NAME>
function windowAgent(pid) {
  let argv; try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return null; }
  const i = argv.findIndex((a) => a.endsWith("/remote-client.mjs"));
  return i >= 0 && argv[i + 1] === WL && NAME_RE.test(argv[i + 2] || "") ? argv[i + 2] : null;
}
const agentWindow = async (name) => (await hypr.clients().catch(() => [])).find((c) => c.class === `hyprpi.${wl}-agent` && Number.isInteger(c.pid) && windowAgent(c.pid) === name) || null;
const activeWs = async () => { const a = await hypr.activeWorkspace().catch(() => null); return Number.isInteger(a?.id) && a.id > 0 ? a.id : null; };
async function jumpTo(c) {
  if (!(c.workspace?.id > 0)) { const ws = await activeWs(); if (ws) { await hypr.moveWindow(c.address, String(ws)).catch(() => {}); await sleep(150); } } // parked (Reprieve): here, as agent.focus
  await hypr.focusWindow(c.address);
}

async function focus(name) {
  if (!NAME_RE.test(name)) return fail(`not an agent name: ${name}`);
  const c = await agentWindow(name);
  if (c) return jumpTo(c);
  // no window yet: open one, only for an agent that has a session on the machine (never start a new one from a click)
  const has = await remote(`test -d ~/.hyprpi-${wl}/sessions/${name}`, { timeout: 20000 });
  if (has.code !== 0) return fail(has.code === 1 ? `${name} isn't an agent of world ${WL}` : `can't reach world ${WL}'s machine to open ${name}`);
  const ws = await activeWs();
  const env = { ...process.env, ...(ws ? { HYPRPI_OPEN_WS: String(ws) } : {}) }; delete env.HYPRPI_AGENT_ID;
  const r = await run(WORLD, [WL, "open", name], { env, timeout: 120000 });
  if (r.code !== 0) return fail(`couldn't open ${name}'s window: ${(r.stderr || r.stdout).trim().split("\n").pop() || "world open failed"}`);
  for (let i = 0; i < 100; i++) { const w = await agentWindow(name); if (w) return jumpTo(w); await sleep(200); }
  fail(`${name}'s window didn't appear`);
}

function openWith(target) {
  const p = spawn("gio", ["open", target], { detached: true, stdio: "ignore" });
  p.on("error", () => { try { spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).on("error", () => fail("no gio or xdg-open to open it")).unref(); } catch { /* none */ } });
  p.unref();
}
function open(url) {
  if (!/^https?:\/\/[^\s\x00-\x1f\x7f]{1,2000}$/i.test(url)) return fail("only http(s) links open on the laptop");
  openWith(url);
}

const RUNS = /\.(desktop|sh|bash|zsh|fish|run|bin|appimage|exe|msi|bat|cmd|com|jar|deb|rpm|flatpakref|flatpak|snap|py|pl|rb|js|mjs|cjs|ps1|command|x86_64)$/i;
async function file(p) {
  // (LinkCheck, J555) "~/…" from a laptop-run panel means the remote machine's home, so it is resolved there
  if (!(p.startsWith("/") || p.startsWith("~/")) || p.length > 1024 || /[\x00-\x1f\x7f]/.test(p) || /(^|\/)\.\.(\/|$)/.test(p.slice(0, 2) === "~/" ? p.slice(2) : "")) return fail("not a file path");
  const max = 50 << 20;
  const fexpr = p.startsWith("~/") ? `"$HOME"/${sh(p.slice(2))}` : sh(p);
  const r = await remote(`f=${fexpr}; [ -f "$f" ] && [ -r "$f" ] || exit 3; [ "$(stat -c %s -- "$f")" -le ${max} ] || exit 4; cat -- "$f"`, { encoding: "buffer", maxBuffer: max + 1024, timeout: 120000 });
  if (r.code === 3) return fail(`${p} isn't a readable file on world ${WL}'s machine`);
  if (r.code === 4) return fail(`${p} is over 50 MB: not copied`);
  if (r.code !== 0) return fail(`couldn't copy ${p} from world ${WL}'s machine`);
  const dir = path.join(os.homedir(), "Downloads", `hyprpi-${wl}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let base = path.basename(p).replace(/[^\w.+-]/g, "_").replace(/^\.+/, "") || "file";
  let dest = path.join(dir, base);
  for (let k = 1; fs.existsSync(dest) && !fs.readFileSync(dest).equals(r.stdout); k++) dest = path.join(dir, base.replace(/(\.[^.]*)?$/, (e) => `-${k}${e || ""}`));
  fs.writeFileSync(dest, r.stdout, { mode: 0o600 });
  say({ copied: dest });
  if (RUNS.test(dest)) { openWith(dir); return fail(`copied to ${dest}; not opened (a file that can run things): its folder is open`); }
  openWith(dest);
}

// J553 (2): a link from a remote agent's laptop window. kitty hands it over as is (a hyperlink's own target, or a URL kitty found
// in the text), so it is checked here like any request: only http(s) and a local-looking file:// path, never another scheme
function linkTarget(u) {
  const s = String(u || "");
  if (/^https?:\/\//i.test(s)) return /^https?:\/\/[^\s\x00-\x1f\x7f]{1,2000}$/i.test(s) ? { act: "open", arg: s } : { error: "not a link" };
  const m = /^file:\/\/([^/]*)(\/[^?#]*)(?:[?#].*)?$/is.exec(s);
  if (!m) return { error: `only http(s) and file links open from world ${WL}'s windows` };
  if (m[1] && m[1].toLowerCase() !== "localhost") return { error: `a link to another machine (${m[1].slice(0, 60)}): not opened` };
  let p; try { p = decodeURIComponent(m[2]); } catch { return { error: "not a file link" }; }
  if (p.length > 1024 || /[\x00-\x1f\x7f]/.test(p)) return { error: "not a file path" };
  return { act: "file", arg: p };
}
function url(u) {
  const t = linkTarget(u);
  if (t.error) return fail(t.error);
  return t.act === "open" ? open(t.arg) : file(t.arg);
}

async function panel(kind) {
  const k = KINDS[kind]; if (!k) return fail(`not a panel: ${kind}`);
  // open on a normal workspace: jump there (as panel-here); parked or not open: mockups/panels brings or opens it here and focuses it
  const c = (await hypr.clients().catch(() => [])).find((x) => x.class === `hyprpi.${wl}-panel` && (x.title || "") === `hyprpi-${k.title} ${WL}`);
  if (c && c.workspace?.id > 0) return hypr.focusWindow(c.address);
  const env = { ...process.env }; delete env.HYPRPI_AGENT_ID;
  const r = await run(PANELS, [WL, "--only", k.n], { env, timeout: 60000 });
  if (r.code !== 0) fail(`couldn't open the ${kind} panel`);
}

async function newAgent() {
  const ws = await activeWs();
  const env = { ...process.env, ...(ws ? { HYPRPI_OPEN_WS: String(ws) } : {}) }; delete env.HYPRPI_AGENT_ID;
  const r = await run(WORLD, [WL, "new"], { env, timeout: 120000 });
  const name = /opened agent ([a-z][a-z0-9-]{0,30}) /.exec(r.stdout)?.[1];
  if (r.code !== 0 || !name) return fail(`couldn't start a new agent: ${(r.stderr || r.stdout).trim().split("\n").pop() || "world new failed"}`);
  say({ allow: name });
}

async function paste() {
  const lt = await run("wl-paste", ["--list-types"], { timeout: 5000 });
  const img = lt.code === 0 ? lt.stdout.split("\n").map((x) => x.trim()).find((x) => /^image\/(png|jpeg|webp|gif)$/.test(x)) : null;
  if (!img) {
    const t = await run("wl-paste", ["--no-newline", "--type", "text/plain"], { timeout: 5000, maxBuffer: 1 << 20 });
    if (t.code === 0 && t.stdout) say({ inject: t.stdout });
    return;
  }
  const data = await run("wl-paste", ["--type", img], { timeout: 15000, encoding: "buffer", maxBuffer: 10e6 + 1024 });
  if (data.code !== 0 || !data.stdout.length) return fail("couldn't read the image on the clipboard");
  if (data.stdout.length > 10e6) return fail("the image is over 10 MB (Thoughts' limit)");
  // J595 (Angus "37a", after J593): named by content, so pasting the same image again gives the same path there and no new file:
  // the bytes go to a unique .part file; if a byte-identical file of that name exists the part is dropped, else it's renamed in
  const f = `pi-clipboard-${createHash("sha256").update(data.stdout).digest("hex").slice(0, 16)}.${img === "image/jpeg" ? "jpg" : img.split("/")[1]}`, rel = `.hyprpi-${wl}/clipboard`;
  const r = await remote(`umask 077; d="$HOME/${rel}"; mkdir -p "$d" && chmod 700 "$d" && t="$d/${f}.$$.part" && cat > "$t" && if [ -f "$d/${f}" ] && cmp -s "$t" "$d/${f}"; then rm -f "$t"; else mv -f "$t" "$d/${f}"; fi`, { input: data.stdout, timeout: 60000 });
  if (r.code !== 0) return fail(`couldn't send the image to world ${WL}'s machine`);
  say({ inject: `~/${rel}/${f} ` }); // a space after it, as the box's own pasted path (you paste, then type on)
}

if (!/^[A-I]$/.test(WL)) { console.error("usage: laptop-act.mjs LETTER focus NAME | open URL | file PATH | url URL | panel KIND | new | paste"); process.exit(2); }
const ACTS = { focus: () => focus(ARG), open: () => open(ARG), file: () => file(ARG), url: () => url(ARG), panel: () => panel(ARG), new: newAgent, paste };
if (!ACTS[ACT]) { console.error(`laptop-act: unknown action ${ACT}`); process.exit(2); }
try { await ACTS[ACT](); } catch (e) { fail(e.message); }
