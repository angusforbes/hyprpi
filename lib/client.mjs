// NDJSON client for the hyprpi daemon. Requests: {id, method, params}.
// Replies: {id, result} | {id, error}. Pushed events: {event, data}.
import net from "node:net";
import { socketPath } from "./paths.mjs";

export function connect({ path = socketPath(), onEvent, onClose, timeout = 3000 } = {}) {
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
