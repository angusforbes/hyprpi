// J472 (Angus: "our phone app would see wrldH as just another world, even though it was agents in omnistation (or another
// server)"): a REMOTE world's agents run under a headless hyprpi daemon on another machine (omnistation/remote.sh, J469). The
// phone server reaches that daemon the way world-h's windows do: with the ssh argv from the private settings file
// (~/.config/hyprpi/remote/<name>.json: { "ssh": [...], "workspace": 71 }), over ONE long-lived connection running a small node
// loop there (newline JSON with ids, as gworld.mjs's J444 bridge). The same allowlist as a sandboxed world: list, an agent's
// prompt / interrupt, the world's Thoughts (get / send), and an agent's session file (realpath under ~/.hyprpi-h/sessions/,
// read there). Replies are data only. Fail closed: a timeout per request kills the connection; nothing is retried blindly.
// Offline: when the login has expired (a Teleport `tsh` login lasts hours) or the machine can't be reached, the world shows as
// offline with a hint, and no new connection is tried for a while (a `tsh ssh` with an expired login is never started, so it
// can't open a browser to log in).
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.HYPRPI_REMOTE_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hyprpi", "remote"); // (tests: HYPRPI_REMOTE_DIR)
const LETTERS = "ABCDEFGHI";
// Every remote world: [{ name, letter, ssh: [...] }] from ~/.config/hyprpi/remote/*.json (a bad file is skipped).
export function remoteWorlds() {
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => /^[a-z0-9-]{1,32}\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
      const ws = Number(c.workspace ?? 71), letter = /^[A-I]$/.test(c.world || "") ? c.world : Number.isInteger(ws) && ws >= 1 && ws <= 90 ? LETTERS[Math.floor((ws - 1) / 10)] : "";
      const ssh = Array.isArray(c.ssh) ? c.ssh.filter((a) => typeof a === "string" && a && a !== "-t" && a !== "-tt") : [];
      if (letter && ssh.length && /^[\w./-]+$/.test(path.basename(ssh[0]))) out.push({ name: f.replace(/\.json$/, ""), letter, ssh });
    } catch { /* skip */ }
  }
  return out;
}
export const remoteOf = (letter) => remoteWorlds().find((w) => w.letter === letter) || null;

const ALLOWED = new Set(["list", "agent.prompt", "agent.interrupt", "thoughts.get", "thoughts.send"]);
// The loop, on the remote machine. Its environment is remote.sh's (the headless daemon's socket and state).
const LOOP = 'import(process.argv[1]+"/lib/client.mjs").then(async(c)=>{const fs=await import("node:fs"),os=await import("node:os");const S=os.homedir()+"/.hyprpi-h/sessions/";const rl=(await import("node:readline")).createInterface({input:process.stdin});process.stdout.write(JSON.stringify({id:0,ok:true,ready:true})+"\\n");rl.on("line",async(l)=>{let q;try{q=JSON.parse(l);}catch{return;}const out=(o)=>process.stdout.write(JSON.stringify({id:q.id,...o})+"\\n");try{if(q.t==="call"){const k=await c.connect({timeout:5000});try{out({ok:true,r:await k.call(q.m,q.p,{timeoutMs:30000})});}finally{k.close();}}else if(q.t==="file"){const f=fs.realpathSync(String(q.f));if(!f.startsWith(S)||!/^[a-z][a-z0-9-]{0,30}\\/[^/]+\\.jsonl$/.test(f.slice(S.length)))throw new Error("not a session file");if(fs.statSync(f).size>24e6)throw new Error("session file too large");out({ok:true,b:fs.readFileSync(f).toString("base64")});}else throw new Error("bad request");}catch(e){out({ok:false,e:String(e&&e.message||e).slice(0,300)});}});rl.on("close",()=>process.exit(0));}).catch((e)=>{process.stderr.write(String(e.message||e));process.exit(1);})';
const REMOTE_CMD = `export HYPRPI_STATE="$HOME/.hyprpi-h/state" HYPRPI_SOCKET="$HOME/.hyprpi-h/run/daemon.sock" HYPRPI_NO_ADOPT=1 PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; unset HYPRLAND_INSTANCE_SIGNATURE WAYLAND_DISPLAY DISPLAY; exec node --input-type=module -e '${LOOP}' "$HOME/hyprpi"`;

// ---- offline: the Teleport login (when the ssh argv is tsh) and the last connection failure
const down = new Map(); // name -> { until, why }
const RETRY_MS = 30000;
const tshValid = (bin) => new Promise((resolve) => {
  execFile(bin, ["status", "--format=json"], { timeout: 8000 }, (e, out) => {
    if (e) return resolve("not logged in to Teleport: run `tsh login` on the laptop");
    try { const u = Date.parse(JSON.parse(out).active?.valid_until || ""); resolve(u && u > Date.now() + 60000 ? "" : "the Teleport login has expired: run `tsh login` on the laptop"); } catch { resolve("can't read the Teleport login (tsh status)"); }
  });
});
export function offline(name) { const d = down.get(name); return d && Date.now() < d.until ? d.why : ""; }
const markDown = (name, why) => { down.set(name, { until: Date.now() + RETRY_MS, why: String(why).slice(0, 200) }); };

// ---- the bridge: one long-lived connection per remote world
const bridges = new Map(); // name -> { p, buf, pending, next, dead, ready: Promise }
async function bridge(w) {
  let b = bridges.get(w.name);
  if (b && !b.dead && b.p.exitCode === null) { await b.ready; return b; }
  const off = offline(w.name); if (off) throw Object.assign(new Error(off), { offline: true });
  if (path.basename(w.ssh[0]) === "tsh") { const why = await tshValid(w.ssh[0]); if (why) { markDown(w.name, why); throw Object.assign(new Error(why), { offline: true }); } }
  const args = path.basename(w.ssh[0]) === "ssh" ? ["-o", "BatchMode=yes", ...w.ssh.slice(1)] : w.ssh.slice(1); // never a prompt
  const p = spawn(w.ssh[0], [...args, REMOTE_CMD], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  b = { p, buf: "", pending: new Map(), next: 1, dead: false };
  const fail = (why) => {
    if (b.dead) return; b.dead = true; if (bridges.get(w.name) === b) bridges.delete(w.name);
    for (const x of b.pending.values()) { clearTimeout(x.timer); x.reject(new Error(why)); }
    b.pending.clear(); p.stdout.removeAllListeners("data"); try { p.kill(); } catch { /* */ }
  };
  b.fail = fail;
  b.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => { const why = `can't reach ${w.name} (no answer in 30 s; VPN or login?)`; markDown(w.name, why); fail(why); reject(Object.assign(new Error(why), { offline: true })); }, 30000);
    b.pending.set(0, { resolve: () => { clearTimeout(t); resolve(); }, reject: (e) => { clearTimeout(t); reject(Object.assign(e, { offline: true })); }, timer: t });
  });
  p.stderr.setEncoding("utf8"); p.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
  p.on("error", () => fail(`${w.ssh[0]} didn't start`));
  p.on("exit", () => { const why = `connection to ${w.name} ended${err.trim() ? `: ${err.trim().split("\n").pop().slice(0, 160)}` : ""}`; if (!b.readyDone) markDown(w.name, why); fail(why); });
  p.stdin.on("error", () => fail("stdin closed"));
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    if (b.dead) return;
    b.buf += d; if (b.buf.length > 40 << 20) return fail("reply too large");
    let i; while ((i = b.buf.indexOf("\n")) >= 0) {
      const line = b.buf.slice(0, i); b.buf = b.buf.slice(i + 1);
      if (!line.startsWith("{")) continue; // a login banner or motd line before the loop starts
      let m; try { m = JSON.parse(line); } catch { return fail("bad reply"); }
      const x = b.pending.get(m?.id); if (!x) continue;
      b.pending.delete(m.id); clearTimeout(x.timer);
      if (m.id === 0) { b.readyDone = true; down.delete(w.name); x.resolve(); continue; }
      if (m.ok === true) x.resolve(m);
      else if (m.ok === false) x.reject(Object.assign(new Error(String(m.e || "error").slice(0, 300)), { inner: true }));
      else { x.reject(new Error("bad reply")); return fail("bad reply"); }
    }
  });
  bridges.set(w.name, b);
  await b.ready;
  return b;
}
async function viaBridge(w, req, timeout) {
  const b = await bridge(w);
  return new Promise((resolve, reject) => {
    const id = b.next++;
    const timer = setTimeout(() => { b.pending.delete(id); reject(new Error("timeout")); b.fail("a request timed out"); }, timeout);
    b.pending.set(id, { resolve, reject, timer });
    try { b.p.stdin.write(JSON.stringify({ id, ...req }) + "\n"); } catch (e) { b.pending.delete(id); clearTimeout(timer); reject(e); }
  });
}
export const closeBridges = () => { for (const b of [...bridges.values()]) b.fail?.("closed"); bridges.clear(); };

// One request to the remote world's daemon. "list" cached 3 s (the phone polls it); any other call clears it.
const listCache = new Map();
export async function call(w, method, params = {}) {
  if (!ALLOWED.has(method)) throw new Error(`not allowed from the phone: ${method}`);
  const isList = method === "list" && !Object.keys(params || {}).length;
  if (isList) { const c = listCache.get(w.name); if (c && Date.now() - c.at < 3000) return c.v; } else listCache.delete(w.name);
  const m = await viaBridge(w, { t: "call", m: method, p: params }, 40000);
  const v = m.r ?? null;
  if (isList) listCache.set(w.name, { at: Date.now(), v }); else listCache.delete(w.name);
  return v;
}
// An agent's session file, copied to a host temp file (for session-read.mjs), cached 3 s. Only a path under the remote
// ~/.hyprpi-h/sessions/<agent>/ (checked again there, after realpath).
const cache = new Map();
export async function sessionCopy(w, file) {
  if (!/^\/[^\0]*\/\.hyprpi-h\/sessions\/[a-z][a-z0-9-]{0,30}\/[^/\0]+\.jsonl$/.test(String(file)) || String(file).includes("/../")) return null;
  const k = `${w.name}:${file}`, c = cache.get(k);
  if (c && Date.now() - c.at < 3000 && fs.existsSync(c.tmp)) return c.tmp;
  const m = await viaBridge(w, { t: "file", f: file }, 30000);
  const dir = path.join(os.tmpdir(), "hyprpi-rsess"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = c?.tmp || path.join(dir, `${w.name}-${path.basename(file)}`);
  fs.writeFileSync(tmp, Buffer.from(String(m.b || ""), "base64"), { mode: 0o600 });
  cache.set(k, { at: Date.now(), tmp });
  return tmp;
}
