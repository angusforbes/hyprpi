// Finding an open hyprpi panel without ever opening a second one (Angus via Thoughts-D, J34: "why do
// I have more than one of the same TUI in world D?"). The openers (mockups/panel-here, mockups/panels)
// used to read a failed `hyprctl clients` as "no windows", so any hiccup opened a duplicate, and two
// quick presses could both open one while the first window was still mapping (its title not set yet).
//
//   strictClients()            hyprctl clients, retried; THROWS if Hyprland can't be read (never "none")
//   withPanelLock(key, fn)     one opener per panel at a time (an O_EXCL lock file in the runtime dir);
//                              a second caller waits for the first, then looks again
import fs from "node:fs";
import path from "node:path";
import * as hypr from "./hypr.mjs";
import { runtimeDir } from "./paths.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function strictClients(tries = 3, opts) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { const l = await hypr.clients(opts); if (Array.isArray(l)) return l; err = new Error("hyprctl clients gave no list"); }
    catch (e) { err = e; }
    await sleep(100 * (i + 1));
  }
  throw new Error(`couldn't read Hyprland's windows (${err?.message || err}), so no panel was opened`);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// key: e.g. "board-D". The lock is held while looking AND opening (up to the new window's title).
export async function withPanelLock(key, fn, { waitMs = 12000 } = {}) {
  const dir = runtimeDir(); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `panel-${String(key).replace(/[^\w.-]/g, "_")}.lock`);
  const t0 = Date.now();
  for (;;) {
    try { const fd = fs.openSync(f, "wx"); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = 0, age = 0;
      try { pid = Number(fs.readFileSync(f, "utf8")) || 0; age = Date.now() - fs.statSync(f).mtimeMs; } catch { continue; }
      if (!pid || !alive(pid) || age > 15000) { try { fs.unlinkSync(f); } catch { /* raced */ } continue; } // stale
      if (Date.now() - t0 > waitMs) throw new Error(`another ${key} panel opener is still running`);
      await sleep(100);
    }
  }
  try { return await fn(); }
  finally { try { if (Number(fs.readFileSync(f, "utf8")) === process.pid) fs.unlinkSync(f); } catch { /* gone */ } }
}
