// J663 (no silent success, J662): the daemon's way of running ~/.local/bin/bonk (bonks and dings for Angus, lib/daemon.mjs
// runBonk). bonk plays the sound and shows the toast; if it can't be started (missing, not executable) or dies, no sound or
// toast reaches Angus for ANY bonk or ding. That used to be swallowed (.on("error", () => {})). Now every failure is logged,
// and the first one in a daemon's life is also told once through `alert(room, text)` (the daemon: a ⚠ in that world's
// Thoughts thread), so someone who can fix it sees it. bonk's exit code says nothing about its toast (it ends with `wait`;
// its plays are logged in ~/.local/state/bonk.log), so exit 0 is "started", never "Angus saw it".
//   const run = createBonkRunner({ bin, log, alert, spawnImpl }); run({ name, room }, argv, env)
import { spawn } from "node:child_process";

export function createBonkRunner({ bin, log = () => {}, alert = null, spawnImpl = spawn }) {
  let told = false;
  function broken(who, what, why) {
    log(`${what} for ${who.name} NOT played/shown: ${why}`);
    if (told || !alert) return; told = true;
    try { alert(who.room || "A", `⚠ ${what} for ${who.name} didn't reach Angus's desktop: ${why}. No sound or toast for bonks and dings until that's fixed (the agent still shows ×; phone pushes are separate). Later failures are only logged.`); }
    catch (e) { log("bonk note:", e.message); }
  }
  return function run(who, argv, env) {
    const what = argv.includes("--ding") ? "ding" : "bonk";
    try {
      const c = spawnImpl(bin, argv, { detached: true, stdio: "ignore", env });
      c.on("error", (e) => broken(who, what, `couldn't start ${bin}: ${e.message}`));
      c.on("exit", (code, sig) => { if (code || sig) broken(who, what, `${bin} ${sig ? `was killed (${sig})` : `exited ${code}`}`); });
      c.unref?.();
    } catch (e) { broken(who, what, e.message); }
  };
}
