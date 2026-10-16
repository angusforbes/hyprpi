// J663 (no silent success, J662): one way to put a desktop notification on Angus's screen, that says whether it got there.
// omarchy-notification-send (busctl Notify, its exit code is the notification server's answer), else notify-send. Exit 0 =
// the notification server took it (it may still be hidden by do-not-disturb: the server doesn't tell us). Anything else (no
// notifier, an error exit, no answer within timeoutMs: the child is killed, it's ours) is logged with the reason and the
// promise resolves { ok: false, why }; it never rejects and never hangs past the timeout, so a caller that awaits it (the
// restore notification) can't be held up by a stuck notifier.
//   desktopNote(args, { what, log, timeoutMs, env }) -> Promise<{ ok: true, id } | { ok: false, why }>
//   args: the notifier's arguments (--app-name X -u normal [-p] [-r ID] TITLE BODY [--exec …]); id = what -p printed.
import { spawn } from "node:child_process";

export const NOTIFY_SH = 'command -v omarchy-notification-send >/dev/null && exec omarchy-notification-send "$@" || exec notify-send "$@"';

export function desktopNote(args, { what = "notification", log = () => {}, timeoutMs = Number(process.env.HYPRPI_NOTIFY_TIMEOUT_MS) || 10000, env = process.env, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false, c;
    const finish = (r) => { if (done) return; done = true; clearTimeout(to); if (!r.ok) log(`${what}: desktop notification NOT shown: ${r.why}`); resolve(r); };
    const to = setTimeout(() => { try { c?.kill("SIGKILL"); } catch { /* gone */ } finish({ ok: false, why: `the notifier gave no answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}` }); }, timeoutMs);
    to.unref?.();
    try { c = spawnImpl("sh", ["-c", NOTIFY_SH, "sh", ...args.map(String)], { stdio: ["ignore", "pipe", "pipe"], env }); }
    catch (e) { return finish({ ok: false, why: `couldn't start the notifier: ${e.message}` }); }
    c.stdout?.on("data", (d) => { out += d; });
    c.stderr?.on("data", (d) => { err = (err + d).slice(-400); });
    c.on("error", (e) => finish({ ok: false, why: `couldn't start the notifier: ${e.message}` }));
    c.on("close", (code, sig) => finish(code === 0 ? { ok: true, id: out.trim().split(/\s+/)[0] || "" }
      : { ok: false, why: `${code === 127 ? "no notifier installed (omarchy-notification-send / notify-send)" : sig ? `the notifier was killed (${sig})` : `the notifier exited ${code}`}${err.trim() ? `: ${err.trim().replace(/\s+/g, " ").slice(0, 200)}` : ""}` }));
  });
}
