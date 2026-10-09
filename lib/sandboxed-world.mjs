#!/usr/bin/env node
// J295: is world LETTER a sandboxed world (a ~/.config/hyprpi/worlds/<name>.json whose first workspace is in it)?
// Exit 0 = yes (the host must not open its panels: they run inside its sandbox), 1 = no. Used by the panel launchers.
import fs from "node:fs";
import path from "node:path";
const letter = String(process.argv[2] || "").toUpperCase();
if (!/^[A-I]$/.test(letter)) process.exit(1);
const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config"), "hyprpi", "worlds");
let files = []; try { files = fs.readdirSync(dir).filter((f) => /^[a-z0-9-]{1,32}\.json$/.test(f)); } catch { process.exit(1); }
for (const f of files) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const ws0 = Array.isArray(c.workspaces) ? Number(c.workspaces[0]) : NaN;
    const w = /^[A-I]$/.test(c.world || "") ? c.world : Number.isInteger(ws0) && ws0 >= 1 ? "ABCDEFGHI"[Math.floor((ws0 - 1) / 10)] : "";
    if (w === letter) process.exit(0);
  } catch { /* skip a bad file */ }
}
process.exit(1);
