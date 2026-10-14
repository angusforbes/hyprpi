// jot-setup-remote.mjs (J559 / J561): run ON a remote world's machine by `omnistation/world X jot` (and setup), with node, as
//   node - WORLD-LETTER LAPTOP-TIME-ZONE < this file      (the laptop's jot.json arrives in env HYPRPI_JOT_JSON, base64)
// It makes every pi there run pi-jot in relay mode, so all jots go to the laptop's notes:
//   - ~/.pi/agent/jot.json = the laptop's (same kinds and folders) with "timeZone" = the laptop's (J561 "22a": laptop-time stamps);
//   - ~/.pi/agent/settings.json "packages" includes ~/.hyprpi-<x>/pi-jot (agents load it);
//   - ~/.config/hyprpi/config.json "jotExtension" = that pi-jot (the world's Thoughts loads it; it reads this when its daemon starts);
//   - ~/.hyprpi-<x>/pi-entry exports PI_JOT_RELAY=1, PI_JOT_RELAY_SOCKET and PI_JOT_RELAY_LINK (the next remote.sh install writes the same);
//   - ~/.pi/agent/AGENTS.md gets the "hyprpi:jot" section (laptop notes are the master; copies here or in the shared folder are fine).
// Idempotent; prints one line per change.
const fs = require("fs"), path = require("path");
const [wl, tz] = process.argv.slice(2);
if (!/^[a-i]$/.test(wl || "")) { console.error("jot-setup-remote: bad world letter"); process.exit(2); }
const H = process.env.HOME, ROOT = `${H}/.hyprpi-${wl}`, PJ = `${ROOT}/pi-jot`, said = (s) => console.log(`  ${s}`);
const readJ = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const writeIf = (p, text) => { let old = null; try { old = fs.readFileSync(p, "utf8"); } catch { /* new */ } if (old === text) return false; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + ".new", text); fs.renameSync(p + ".new", p); return true; };

// jot.json with the laptop's time zone
const jb = process.env.HYPRPI_JOT_JSON ? Buffer.from(process.env.HYPRPI_JOT_JSON, "base64").toString("utf8") : "";
let jot = null; try { jot = jb ? JSON.parse(jb) : null; } catch { /* keep the old one */ }
if (jot) { if (tz && /^[A-Za-z_+\-\/0-9]{1,64}$/.test(tz)) jot.timeZone = tz; if (writeIf(`${H}/.pi/agent/jot.json`, JSON.stringify(jot, null, 2) + "\n")) said(`jot.json: the laptop's${jot.timeZone ? `, time zone ${jot.timeZone}` : ""}`); }

// pi package for agents
const sp = `${H}/.pi/agent/settings.json`, s = readJ(sp) || {};
const pk = Array.isArray(s.packages) ? s.packages : [];
if (!pk.includes(PJ)) { s.packages = [...pk, PJ]; writeIf(sp, JSON.stringify(s, null, 2) + "\n"); said("pi-jot added to pi's packages"); }

// the world's Thoughts
const cp = `${H}/.config/hyprpi/config.json`, c = readJ(cp);
if (c && c.jotExtension !== `${PJ}/src/extension.ts`) { c.jotExtension = `${PJ}/src/extension.ts`; writeIf(cp, JSON.stringify(c, null, 2) + "\n"); said("Thoughts gets pi-jot (from its next start)"); }

// pi-entry: relay mode for every pi here
const pe = `${ROOT}/pi-entry`;
try {
  let t = fs.readFileSync(pe, "utf8");
  const want = `export PI_JOT_RELAY=1 PI_JOT_RELAY_SOCKET=${ROOT}/jot.sock PI_JOT_RELAY_LINK=${ROOT}/run/daemon.sock`; // (J569: the daemon's link.call, J555)
  const t2 = t.replace(/then export PI_JOT_RELAY=1; exec /, "then exec ").replace(/^export PI_JOT_RELAY=1[^\n]*\n/m, "").replace(/^(#![^\n]*\n(?:#[^\n]*\n)*)/, `$1${want}\n`);
  if (t2 !== t) { fs.writeFileSync(pe + ".new", t2, { mode: 0o755 }); fs.renameSync(pe + ".new", pe); said("pi-entry: every pi here runs pi-jot in relay mode"); }
} catch (e) { said(`pi-entry not changed (${e.message}); remote.sh install writes it`); }

// AGENTS.md
const ap = `${H}/.pi/agent/AGENTS.md`, B = "<!-- hyprpi:jot (J559/J561; written by omnistation/world X jot, replaced on every setup) -->", E = "<!-- /hyprpi:jot -->";
const sec = `${B}
## Notes and todos (/jot-*): the laptop's Obsidian is the master

Every \`/jot-*\` command and pi-jot tool here (jot_save, jot_plan, jot_file, /jot-todo) writes to Angus's notes on his LAPTOP (~/Obsidian), never on this machine: pi-jot sends each file access to the laptop (relay mode). Stamps use the laptop's time zone. If the laptop isn't reachable (asleep, link down) a jot fails with "nothing was saved": tell Angus, and try again later.

The laptop's Obsidian is the master copy. For an important note or todo you may ALSO keep a copy where you need it: in the shared folder (\`~/workspace/shared\`, synced with the laptop) and/or locally on this machine. Those are copies; the laptop's notes stay the reference.
${E}`;
let a = ""; try { a = fs.readFileSync(ap, "utf8"); } catch { /* new */ }
const i = a.indexOf(B), j = a.indexOf(E);
const a2 = i >= 0 && j > i ? a.slice(0, i) + sec + a.slice(j + E.length) : (a ? a.replace(/\n*$/, "\n\n") : "") + sec + "\n";
if (writeIf(ap, a2)) said("AGENTS.md: the hyprpi:jot section");
