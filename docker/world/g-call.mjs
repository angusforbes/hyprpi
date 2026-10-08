// Inside a sandboxed hyprpi world (J262): send one request to the host's world-helper through the drop-box
// and wait for its answer. Requests: $HYPRPI_G_OUT (sandbox-writable). Answers: $HYPRPI_G_IN (host-only,
// read-only here), named res-<request>.json. Used by bin/hyprctl and bin/kitty.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function gCall(req, { timeoutMs = 6000 } = {}) {
  const out = process.env.HYPRPI_G_OUT, inbox = process.env.HYPRPI_G_IN;
  if (!out || !inbox) throw new Error("not inside a sandboxed hyprpi world (HYPRPI_G_OUT / HYPRPI_G_IN unset)");
  fs.mkdirSync(out, { recursive: true });
  const stem = `${String(Date.now()).padStart(13, "0")}-${crypto.randomBytes(4).toString("hex")}`;
  const tmp = path.join(out, `.${stem}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(req), { flag: "wx" });
  fs.renameSync(tmp, path.join(out, `${stem}.json`));
  const res = path.join(inbox, `res-${stem}.json`);
  const end = Date.now() + timeoutMs;
  for (let wait = 10; Date.now() < end; wait = Math.min(wait * 1.5, 100)) {
    try { return JSON.parse(fs.readFileSync(res, "utf8")); } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error("no answer from the host's world-helper (is it running?)");
}
