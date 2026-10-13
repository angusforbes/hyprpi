// NDJSON client for the hyprpi daemon. Requests: {id, method, params}.
// Replies: {id, result} | {id, error}. Pushed events: {event, data}.
import net from "node:net";
import { socketPath, linkSocket, remoteLink } from "./paths.mjs";

// J543 (ParityPanels' review gap) + J553 (9): no string from the daemon may carry a terminal command into a PANEL's screen: an agent's
// Stream post, board text or Thoughts entry with OSC 52 (a clipboard write), a title change, a hyperlink, a remote panel relay's
// request, a DCS / SOS / PM / APC string, a cursor move or mode change (CSI that isn't a colour: e.g. mouse reporting off), a reset
// (ESC c), any other C0 / C1 control (BEL, shift-out, …; tab, newline and CR stay) or their 8-bit C1 forms is cut out of every reply and event; colours (SGR: ESC [ … m) stay. The panels ask for it with
// connect({ scrub: true }) (local and remote alike); a remote world's panel (HYPRPI_REMOTE_PANEL=1) gets it by default. Other clients
// (agents' pi extension, bin/hyprpi, the phone server) get the daemon's strings as they are. The panels' own escapes (their
// titles, OSC 52 copies, links they draw) are written by the panels themselves, after this, so they still work.
const CMD = /(?:\x1b[\]P_^X]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b\[(?![0-9;:]*m)[0-9;:?<>=!]*[ -\/]*[@-~]?|\x9b[0-9;:?<>=!]*[ -\/]*[@-~]?|\x1b(?![[\]P_^X])[\s\S]?|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g;
const HAS_CMD = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/; // (tab, newline and carriage return are text)
const cleanCmds = (v) => typeof v === "string" ? (HAS_CMD.test(v) ? v.replace(CMD, "") : v) : Array.isArray(v) ? v.map(cleanCmds) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanCmds(x)])) : v;
export const scrubTerminalCommands = cleanCmds;
// a reply / event line that can't hold one (no control character, raw or escaped) is passed on without a deep copy
const LINE_MAY_HAVE_CMD = /\\u00[01][0-9a-f]|\\u00[79][0-9a-f]|\\u008[0-9a-f]|\\[bf]|[\x7f-\x9f]/i;

// J555: a laptop panel of a remote world (HYPRPI_REMOTE_LINK=X) talks to that world's daemon through the world's link socket
const defaultPath = () => (remoteLink() ? linkSocket(remoteLink()) : socketPath());
export function connect({ path = defaultPath(), onEvent, onClose, timeout = 3000, scrub = process.env.HYPRPI_REMOTE_PANEL === "1" } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(path);
    const pending = new Map();
    let nextId = 1, buf = "", open = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`hyprpi daemon not answering at ${path}`)); }, timeout);
    const api = {
      call(method, params = {}, { timeoutMs = 15000 } = {}) {
        return new Promise((res, rej) => {
          if (sock.destroyed) return rej(new Error("hyprpi connection closed"));
          const id = nextId++;
          const t = timeoutMs > 0 ? setTimeout(() => { pending.delete(id); rej(new Error(`hyprpi ${method} timed out`)); }, timeoutMs) : null;
          pending.set(id, { res, rej, t });
          sock.write(JSON.stringify({ id, method, params }) + "\n");
        });
      },
      close() { sock.end(); sock.destroy(); },
      get closed() { return sock.destroyed; },
    };
    sock.on("connect", () => { open = true; clearTimeout(timer); resolve(api); });
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (scrub && LINE_MAY_HAVE_CMD.test(line)) m = cleanCmds(m); // J543, J553 (9)
        if (m.event) { try { onEvent?.(m.event, m.data); } catch { /* listener bug */ } continue; }
        const p = pending.get(m.id);
        if (!p) continue;
        pending.delete(m.id); if (p.t) clearTimeout(p.t);
        m.error ? p.rej(new Error(m.error)) : p.res(m.result);
      }
    });
    sock.on("error", (e) => { if (!open) { clearTimeout(timer); reject(e); } });
    sock.on("close", () => {
      for (const p of pending.values()) { if (p.t) clearTimeout(p.t); p.rej(new Error("hyprpi connection closed")); }
      pending.clear();
      if (open) onClose?.();
    });
  });
}

// One-shot request.
export async function request(method, params = {}, opts = {}) {
  const c = await connect(opts);
  try { return await c.call(method, params, opts); } finally { c.close(); }
}
