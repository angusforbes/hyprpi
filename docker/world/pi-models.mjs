#!/usr/bin/env node
// J405: give a sandboxed world the standard model list (docker/world/nv-inference-models.json: NVIDIA Inference
// Hub's OpenAI and Claude models, each tested under a full agent prompt), without touching its key.
//   node docker/world/pi-models.mjs SANDBOX [--dry-run] [--no-host-list]
// J380 v3: only the template models the HOST's scoped model list allows are given (--no-host-list: the whole template).
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

// J380 v3: the HOST's scoped model list (pi enabledModels; lib/modellist.mjs) decides which of the template's models a sandbox gets: host.allows(
// "provider/id") -> bool. Without `host` the whole template is used (as before).
export function merge(models, settings, tpl = T, host = null) {
  const m = models && typeof models === "object" ? structuredClone(models) : {};
  m.providers ||= {};
  const p = (m.providers[tpl.provider] ||= {});
  const changes = [];
  if (!p.baseUrl) { p.baseUrl = tpl.baseUrl; changes.push(`baseUrl ${tpl.baseUrl}`); }
  if (!p.api) { p.api = tpl.api; changes.push(`api ${tpl.api}`); }
  p.models ||= [];
  const have = new Set(p.models.map((x) => x.id));
  const wanted = host ? tpl.models.filter((x) => host.allows(`${tpl.provider}/${x.id}`)) : tpl.models;
  if (host && !wanted.length) throw new Error("none of the template's models are on the host's scoped model list, so there is nothing to give (an empty enabledModels would mean every model is allowed); add them to the host list or use --no-host-list");
  if (host && wanted.length < tpl.models.length) changes.push(`host list: ${tpl.models.length - wanted.length} of ${tpl.models.length} template models are not on the host's scoped model list and are left out`);
  for (const x of wanted) if (!have.has(x.id)) { p.models.push(x); changes.push(`+ ${tpl.provider}/${x.id}`); }
  const s = settings && typeof settings === "object" ? structuredClone(settings) : {};
  if (!Array.isArray(s.enabledModels) && tpl.enabledModels) { s.enabledModels = host ? wanted.map((x) => `${tpl.provider}/${x.id}`) : tpl.enabledModels; changes.push(`enabledModels ${JSON.stringify(s.enabledModels).slice(0, 100)}`); }
  return { models: m, settings: s, changes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sb, ...rest] = process.argv.slice(2);
  const dry = rest.includes("--dry-run");
  if (!sb || !/^[\w.-]+$/.test(sb)) { console.error("usage: pi-models.mjs SANDBOX [--dry-run]"); process.exit(2); }
  const models = JSON.parse(sbxCat(sb, "models.json") || "{}"), settings = JSON.parse(sbxCat(sb, "settings.json") || "{}");
  let host = null; if (!rest.includes("--no-host-list")) { try { const { allowedBy, readList } = await import("../../lib/modellist.mjs"); const list = readList(); host = list.length ? { allows: (m) => !!allowedBy(m, list) } : null; } catch (e) { console.error(`pi-models: can't read the host's model list (${e.message}); use --no-host-list to give the whole template`); process.exit(1); } }
  let r; try { r = merge(models, settings, T, host); } catch (e) { console.error(`pi-models: ${e.message}`); process.exit(1); }
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
