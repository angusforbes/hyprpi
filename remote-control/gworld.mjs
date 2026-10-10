// J433 (Angus: "i don't see my sandboxed agents in my remote control app … the only way i can connect is via my
// phone"): a sandboxed world's own agents and Thoughts live in its INNER hyprpi daemon, inside the sandbox. The
// phone server reaches that daemon the way Angus's keyboard does: from the host, with `sbx exec` (the host is
// trusted; nothing in the sandbox can call the host this way). Only a few methods are allowed: list, an agent's
// session (read), a prompt to one of its agents, and Thoughts-G's thread / a message to it. Nothing that
// decides a held item (those stay at the laptop: Doorman-G, J355).
import { execFile } from "node:child_process";
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

// One request to the sandbox's inner daemon.
export async function call(sb, method, params = {}) {
  if (!ALLOWED.has(method)) throw new Error(`not allowed from the phone: ${method}`);
  const js = 'import(process.argv[1]+"/lib/client.mjs").then(async(c)=>{let b="";for await(const x of process.stdin)b+=x;const q=JSON.parse(b);const k=await c.connect({timeout:5000});try{const r=await k.call(q.m,q.p,{timeoutMs:30000});process.stdout.write(JSON.stringify(r));}finally{k.close();}}).catch((e)=>{process.stderr.write(String(e.message||e));process.exit(1);})';
  const out = await run(sb, `${ENV}; exec node --input-type=module -e '${js}' "$G_HOST_HYPRPI"`, JSON.stringify({ m: method, p: params }), 40000);
  return JSON.parse(out.toString("utf8") || "null");
}

// An inner agent's session file, copied to a host temp file (for remote-control/session-read.mjs), cached 3 s.
const cache = new Map(); // sb:file -> { at, tmp }
export async function sessionCopy(sb, file) {
  if (!/^\/home\/agent\/\.pi\/agent\/sessions\/[^\0]+\.jsonl$/.test(file) || file.includes("/../")) return null;
  const k = `${sb}:${file}`, c = cache.get(k);
  if (c && Date.now() - c.at < 3000 && fs.existsSync(c.tmp)) return c.tmp;
  const out = await run(sb, 'f="$1"; case "$(readlink -f "$f")" in /home/agent/.pi/agent/sessions/*.jsonl) cat -- "$f";; *) exit 3;; esac'.replace('"$1"', `'${file.replace(/'/g, "")}'`), null, 20000);
  const dir = path.join(os.tmpdir(), "hyprpi-gsess"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = c?.tmp || path.join(dir, `${sb}-${path.basename(file)}`);
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  cache.set(k, { at: Date.now(), tmp });
  return tmp;
}
