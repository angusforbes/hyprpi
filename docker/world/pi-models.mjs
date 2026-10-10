#!/usr/bin/env node
// J405: give a sandboxed world the standard model list (docker/world/nv-inference-models.json: NVIDIA Inference
// Hub's OpenAI and Claude models, each tested under a full agent prompt), without touching its key.
//   node docker/world/pi-models.mjs SANDBOX [--dry-run]
// It reads the sandbox's ~/.pi/agent/models.json and settings.json (sbx exec), adds every template model the
// provider lacks (same id = left as it is), sets the provider's baseUrl/api if missing, sets enabledModels to
// the template's when the sandbox has none, keeps a backup (*.bak-J405-<time>) and writes the files back with
// sbx cp. The key (provider apiKey or auth.json) is never read out of the sandbox's files into anything but the
// rewritten models.json itself. --dry-run prints what would change and writes nothing.
// A NEW sandboxed world: after `sbx create` and putting its Inference Hub key in (docker/README.md), run this.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const T = JSON.parse(fs.readFileSync(path.join(here, "nv-inference-models.json"), "utf8"));
const sbxCat = (sb, f) => { try { return execFileSync("sbx", ["exec", sb, "sh", "-c", `cat ~/.pi/agent/${f} 2>/dev/null || true`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch (e) { throw new Error(`can't read ${f} in ${sb}: ${e.message}`); } };

export function merge(models, settings, tpl = T) {
  const m = models && typeof models === "object" ? structuredClone(models) : {};
  m.providers ||= {};
  const p = (m.providers[tpl.provider] ||= {});
  const changes = [];
  if (!p.baseUrl) { p.baseUrl = tpl.baseUrl; changes.push(`baseUrl ${tpl.baseUrl}`); }
  if (!p.api) { p.api = tpl.api; changes.push(`api ${tpl.api}`); }
  p.models ||= [];
  const have = new Set(p.models.map((x) => x.id));
  for (const x of tpl.models) if (!have.has(x.id)) { p.models.push(x); changes.push(`+ ${tpl.provider}/${x.id}`); }
  const s = settings && typeof settings === "object" ? structuredClone(settings) : {};
  if (!Array.isArray(s.enabledModels) && tpl.enabledModels) { s.enabledModels = tpl.enabledModels; changes.push(`enabledModels ${JSON.stringify(tpl.enabledModels)}`); }
  return { models: m, settings: s, changes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sb, ...rest] = process.argv.slice(2);
  const dry = rest.includes("--dry-run");
  if (!sb || !/^[\w.-]+$/.test(sb)) { console.error("usage: pi-models.mjs SANDBOX [--dry-run]"); process.exit(2); }
  const models = JSON.parse(sbxCat(sb, "models.json") || "{}"), settings = JSON.parse(sbxCat(sb, "settings.json") || "{}");
  const r = merge(models, settings);
  const keyless = !(r.models.providers[T.provider].apiKey) && !/"nv-inference"/.test(sbxCat(sb, "auth.json"));
  console.log(`${sb}: ${r.changes.length ? r.changes.length + " change(s)" : "already up to date"}${dry ? " (dry run)" : ""}`);
  for (const c of r.changes) console.log("  " + c);
  if (keyless) console.log(`  note: no ${T.provider} key in ${sb} (models.json apiKey or auth.json): add it, or the models won't answer`);
  if (!dry && r.changes.length) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-models-")), stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    try {
      execFileSync("sbx", ["exec", sb, "sh", "-c", `cd ~/.pi/agent && for f in models.json settings.json; do [ -f $f ] && cp -p $f $f.bak-J405-${stamp}; done; true`]);
      fs.writeFileSync(path.join(tmp, "models.json"), JSON.stringify(r.models, null, 2) + "\n", { mode: 0o600 });
      fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify(r.settings, null, 2) + "\n", { mode: 0o600 });
      for (const f of ["models.json", "settings.json"]) execFileSync("sbx", ["cp", path.join(tmp, f), `${sb}:/home/agent/.pi/agent/${f}`]);
      execFileSync("sbx", ["exec", sb, "sh", "-c", "chmod 600 ~/.pi/agent/models.json"]);
      console.log(`  written; backups *.bak-J405-${stamp} in ${sb}:~/.pi/agent`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}
