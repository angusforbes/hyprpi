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

// J500 (Angus: "a similar config for models in omnistation and sandbox"): by default the sandbox's models come from
// docker/world/models.jsonc (lib/models-resolve.mjs: preset, add / exclude / deny, default, Thoughts), applied with the same code as a
// Brev box or world H (lib/nv-models.mjs applyModels): provider nv-inference set to exactly that list, pi's default, the explicit
// nv-inference entries of enabledModels, and the sandbox's own hyprpi thoughtsModel. The key stays in the sandbox's auth.json (or
// its provider apiKey, kept). --config FILE picks another config; --template is the old J405 add-only merge of the whole template.
//   node docker/world/pi-models.mjs SANDBOX [--dry-run] [--config FILE | --template [--no-host-list]]
async function configMode(sb, rest) {
  const dry = rest.includes("--dry-run");
  const cfgFile = rest.includes("--config") ? rest[rest.indexOf("--config") + 1] : path.join(here, "models.jsonc");
  const { resolveModels } = await import("../../lib/models-resolve.mjs");
  const { applyModels } = await import("../../lib/nv-models.mjs");
  let resolved; try { resolved = await resolveModels(cfgFile); } catch (e) { console.error(`pi-models: ${e.message}`); process.exit(2); }
  const parse = (t, f) => { if (!t.trim()) return {}; try { const j = JSON.parse(t); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch { /* below */ } console.error(`pi-models: ${sb}'s ${f} isn't a JSON object; nothing changed`); process.exit(2); };
  const sbxHome = (f) => { try { return execFileSync("sbx", ["exec", sb, "sh", "-c", `cat ~/${f} 2>/dev/null || true`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch (e) { console.error(`pi-models: can't read ${f} in ${sb}: ${e.message}`); process.exit(1); } };
  const before = { models: parse(sbxCat(sb, "models.json"), "models.json"), settings: parse(sbxCat(sb, "settings.json"), "settings.json") };
  const cfgText = sbxHome(".config/hyprpi/config.json"); before.config = cfgText.trim() ? parse(cfgText, ".config/hyprpi/config.json") : null;
  let r; try { r = applyModels(before, resolved, { keyCmd: null }); } catch (e) { console.error(`pi-models: ${e.message}; nothing changed`); process.exit(2); }
  const txt = (o) => JSON.stringify(o, null, 2) + "\n";
  const changed = [["models.json", r.models, before.models], ["settings.json", r.settings, before.settings], ...(r.config ? [["config.json", r.config, before.config]] : [])].filter(([, a, b]) => txt(a) !== txt(b));
  const ids = (o) => (o?.providers?.["nv-inference"]?.models || []).map((m) => m.id);
  const was = ids(before.models), now = ids(r.models);
  console.log(`${sb}: preset ${resolved.preset}, ${now.length} models, default ${r.def}: ${changed.length ? changed.map(([f]) => f).join(", ") + " would change" : "already up to date"}${dry ? " (dry run)" : ""}`);
  const plus = now.filter((x) => !was.includes(x)), minus = was.filter((x) => !now.includes(x));
  if (plus.length) console.log(`  + ${plus.join(", ")}`); if (minus.length) console.log(`  - ${minus.join(", ")}`);
  if (before.settings.defaultModel !== r.settings.defaultModel) console.log(`  default ${before.settings.defaultModel || "-"} -> ${r.settings.defaultModel}`);
  if (r.config && before.config?.thoughtsModel !== r.config.thoughtsModel) console.log(`  thoughtsModel ${before.config?.thoughtsModel || "-"} -> ${r.config.thoughtsModel}`);
  for (const d of resolved.denied) console.log(`  denied: ${d.id} (${d.why})`);
  if (dry || !changed.length) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-models-")), stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  try {
    // (review) fail closed: a backup that can't be made stops the run before anything is overwritten (execFileSync throws)
    execFileSync("sbx", ["exec", sb, "sh", "-ec", `cd ~/.pi/agent; for f in models.json settings.json; do if [ -f $f ]; then cp -p $f $f.bak-J500-${stamp}; fi; done; if [ -f ~/.config/hyprpi/config.json ]; then cp -p ~/.config/hyprpi/config.json ~/.config/hyprpi/config.json.bak-J500-${stamp}; fi`]);
    for (const [f, o] of changed) {
      fs.writeFileSync(path.join(tmp, f), txt(o), { mode: 0o600 });
      execFileSync("sbx", ["cp", path.join(tmp, f), `${sb}:/home/agent/${f === "config.json" ? ".config/hyprpi" : ".pi/agent"}/${f}`]);
    }
    execFileSync("sbx", ["exec", sb, "sh", "-c", "chmod 600 ~/.pi/agent/models.json ~/.pi/agent/settings.json"]);
    console.log(`  written; backups *.bak-J500-${stamp} in ${sb} (its running agents see the models after a restart)`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sb0, ...rest0] = process.argv.slice(2);
  if (sb0 && /^[\w.-]+$/.test(sb0) && !rest0.includes("--template")) { await configMode(sb0, rest0); process.exit(0); }
  const [sb, ...rest] = process.argv.slice(2);
  const dry = rest.includes("--dry-run");
  if (!sb || !/^[\w.-]+$/.test(sb)) { console.error("usage: pi-models.mjs SANDBOX [--dry-run] [--config FILE | --template [--no-host-list]]"); process.exit(2); }
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
