// J433 (Angus: "i don't see my sandboxed agents in my remote control app … the only way i can connect is via my
// phone"): a sandboxed world's own agents and Thoughts live in its INNER hyprpi daemon, inside the sandbox. The
// phone server reaches that daemon the way Angus's keyboard does: from the host, with `sbx exec` (the host is
// trusted; nothing in the sandbox can call the host this way). Only a few methods are allowed: list, an agent's
// session (read), a prompt to one of its agents, and Thoughts-G's thread / a message to it. Nothing that
// decides a held item (those stay at the laptop: Doorman-G, J355).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CFG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hyprpi", "worlds");
// world letter -> sandbox name, from ~/.config/hyprpi/worlds/*.json (as lib/sandboxed-world.mjs)
export function sandboxOf(letter) {
  let files = []; try { files = fs.readdirSync(CFG).filter((f) => /^[a-z0-9-]{1,32}\.json$/.test(f)); } catch { return ""; }
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CFG, f), "utf8"));
      const ws0 = Array.isArray(c.workspaces) ? Number(c.workspaces[0]) : NaN;
      const w = /^[A-I]$/.test(c.world || "") ? c.world : Number.isInteger(ws0) && ws0 >= 1 ? "ABCDEFGHI"[Math.floor((ws0 - 1) / 10)] : "";
      if (w === letter && /^[\w.-]+$/.test(c.sandbox || "")) return c.sandbox;
    } catch { /* skip */ }
  }
  return "";
}

const ALLOWED = new Set(["list", "agent.prompt", "agent.interrupt", "thoughts.get", "thoughts.send"]);
const ENV = '. ~/.hyprpi-g/host.env 2>/dev/null; . "$G_HOST_HYPRPI/docker/world/g-env.sh"';
const run = (sb, script, input, timeout = 20000) => new Promise((resolve, reject) => {
  const c = execFile("sbx", ["exec", "-i", sb, "sh", "-c", script], { timeout, maxBuffer: 32 << 20, encoding: "buffer" }, (e, out, err) => e ? reject(new Error(String(err || e.message).trim().slice(0, 300))) : resolve(out));
  if (input != null) c.stdin.end(input); else c.stdin.end();
});

// J444 (fewer sbx calls: each new `sbx exec` makes sandboxd open ~45 fresh keyring sessions, and that churn crashes
// gnome-keyring): requests go through ONE long-lived `sbx exec` per sandbox running the loop below (newline JSON with
// ids; each request connects, calls and closes like the one-shot script; a session file is read with the same realpath
// check, inside). ALLOWED is checked here, on the host, before anything is sent; replies are data only. Fail closed:
// a timeout per request, a reply size cap, ids never reused, and any bridge trouble (the exec ends, a timeout, a bad or
// oversized reply) kills that loop and the request falls back to the one-shot exec; the next request starts a new loop.
const LOOP = 'import(process.argv[1]+"/lib/client.mjs").then(async(c)=>{const fs=await import("node:fs");const rl=(await import("node:readline")).createInterface({input:process.stdin});rl.on("line",async(l)=>{let q;try{q=JSON.parse(l);}catch{return;}const out=(o)=>process.stdout.write(JSON.stringify({id:q.id,...o})+"\\n");try{if(q.t==="call"){const k=await c.connect({timeout:5000});try{out({ok:true,r:await k.call(q.m,q.p,{timeoutMs:30000})});}finally{k.close();}}else if(q.t==="file"){const f=fs.realpathSync(String(q.f));if(!/^\\/home\\/agent\\/\\.pi\\/agent\\/sessions\\/.+\\.jsonl$/.test(f))throw new Error("not a session file");if(fs.statSync(f).size>24e6)throw new Error("session file too large");out({ok:true,b:fs.readFileSync(f).toString("base64")});}else throw new Error("bad request");}catch(e){out({ok:false,e:String(e&&e.message||e).slice(0,300)});}});rl.on("close",()=>process.exit(0));}).catch((e)=>{process.stderr.write(String(e.message||e));process.exit(1);})';
const bridges = new Map(); // sb -> { p, buf, pending: Map(id -> { resolve, reject, timer }), next, dead }
function bridge(sb) {
  let b = bridges.get(sb);
  if (b && !b.dead && b.p.exitCode === null) return b;
  const p = spawn("sbx", ["exec", "-i", sb, "sh", "-c", `${ENV}; exec node --input-type=module -e '${LOOP}' "$G_HOST_HYPRPI"`], { stdio: ["pipe", "pipe", "ignore"] });
  b = { p, buf: "", pending: new Map(), next: 1, dead: false };
  const fail = (why) => {
    if (b.dead) return; b.dead = true; if (bridges.get(sb) === b) bridges.delete(sb);
    for (const x of b.pending.values()) { clearTimeout(x.timer); x.reject(new Error(why)); }
    b.pending.clear(); p.stdout.removeAllListeners("data"); try { p.kill(); } catch { /* */ }
  };
  b.fail = fail;
  p.on("error", () => fail("bridge: sbx didn't start")); p.on("exit", () => fail("bridge: the exec ended")); p.stdin.on("error", () => fail("bridge: stdin closed"));
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => {
    if (b.dead) return;
    b.buf += d; if (b.buf.length > 40 << 20) return fail("bridge: reply too large");
    let i; while ((i = b.buf.indexOf("\n")) >= 0) {
      const line = b.buf.slice(0, i); b.buf = b.buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { return fail("bridge: bad reply"); }
      const x = b.pending.get(m?.id); if (!x) continue; // (a reply for a request that already timed out: dropped)
      b.pending.delete(m.id); clearTimeout(x.timer);
      if (m.ok === true) x.resolve(m); else x.reject(Object.assign(new Error(String(m.e || "error").slice(0, 300)), { inner: true }));
    }
  });
  bridges.set(sb, b); return b;
}
function viaBridge(sb, req, timeout) {
  return new Promise((resolve, reject) => {
    const b = bridge(sb), id = b.next++;
    // a timeout means the loop may be hung: kill it (fail closed), so no late reply can ever be read
    const timer = setTimeout(() => { b.pending.delete(id); reject(new Error("bridge: timeout")); b.fail("bridge: a request timed out"); }, timeout);
    b.pending.set(id, { resolve, reject, timer });
    try { b.p.stdin.write(JSON.stringify({ id, ...req }) + "\n"); } catch (e) { b.pending.delete(id); clearTimeout(timer); reject(e); }
  });
}
// An error from inside (inner: true, e.g. the inner daemon's own refusal) is the answer; bridge trouble → the one-shot exec.
const bridged = async (sb, req, timeout, oneShot) => { try { return await viaBridge(sb, req, timeout); } catch (e) { if (e.inner) throw e; return oneShot(); } };
export const closeBridges = () => { for (const b of [...bridges.values()]) b.fail?.("closed"); bridges.clear(); };

// One request to the sandbox's inner daemon. "list" is cached 3 s per sandbox (the phone polls it).
// (J444bcheck) any other call clears it BEFORE it is sent, and bumps a generation, so a list that was in flight when a
// prompt or send went out never fills the cache afterwards.
const listCache = new Map(), listGen = new Map();
export async function call(sb, method, params = {}) {
  if (!ALLOWED.has(method)) throw new Error(`not allowed from the phone: ${method}`);
  const isList = method === "list" && !Object.keys(params || {}).length;
  if (isList) { const c = listCache.get(sb); if (c && Date.now() - c.at < 3000) return c.v; }
  else { listCache.delete(sb); listGen.set(sb, (listGen.get(sb) || 0) + 1); }
  const gen = listGen.get(sb) || 0;
  const v = await bridged(sb, { t: "call", m: method, p: params }, 40000, () => callOnce(sb, method, params)).then((m) => (m && typeof m === "object" && "ok" in m && "id" in m ? (m.r ?? null) : m));
  if (isList && (listGen.get(sb) || 0) === gen) listCache.set(sb, { at: Date.now(), v });
  return v;
}
async function callOnce(sb, method, params) {
  const js = 'import(process.argv[1]+"/lib/client.mjs").then(async(c)=>{let b="";for await(const x of process.stdin)b+=x;const q=JSON.parse(b);const k=await c.connect({timeout:5000});try{const r=await k.call(q.m,q.p,{timeoutMs:30000});process.stdout.write(JSON.stringify(r));}finally{k.close();}}).catch((e)=>{process.stderr.write(String(e.message||e));process.exit(1);})';
  const out = await run(sb, `${ENV}; exec node --input-type=module -e '${js}' "$G_HOST_HYPRPI"`, JSON.stringify({ m: method, p: params }), 40000);
  return JSON.parse(out.toString("utf8") || "null");
}

const fileOnce = (sb, file) => run(sb, 'f="$1"; case "$(readlink -f "$f")" in /home/agent/.pi/agent/sessions/*.jsonl) [ "$(stat -c %s -- "$f")" -le 24000000 ] || exit 4; cat -- "$f";; *) exit 3;; esac'.replace('"$1"', `'${file.replace(/'/g, "")}'`), null, 20000); // the one-shot way (J444: the fallback)
// An inner agent's session file, copied to a host temp file (for remote-control/session-read.mjs), cached 3 s.
const cache = new Map(); // sb:file -> { at, tmp }
export async function sessionCopy(sb, file) {
  if (!/^\/home\/agent\/\.pi\/agent\/sessions\/[^\0]+\.jsonl$/.test(file) || file.includes("/../")) return null;
  const k = `${sb}:${file}`, c = cache.get(k);
  if (c && Date.now() - c.at < 3000 && fs.existsSync(c.tmp)) return c.tmp;
  const out = await bridged(sb, { t: "file", f: file }, 20000, () => fileOnce(sb, file)).then((m) => (Buffer.isBuffer(m) ? m : Buffer.from(String(m?.b || ""), "base64")));
  const dir = path.join(os.tmpdir(), "hyprpi-gsess"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = c?.tmp || path.join(dir, `${sb}-${path.basename(file)}`);
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  cache.set(k, { at: Date.now(), tmp });
  return tmp;
}
