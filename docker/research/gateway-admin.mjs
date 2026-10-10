// J372: CHANGING the research gateway's settings (docker/research/gateway.mjs says what they are). Rule from Angus: only Angus changes them, either by
// editing worlds/<name>.json or with the admin command below, which (like the relay's approve CLI) needs a real terminal and no agent ancestor.
// A host agent (for example through the bridge, J371) can only PROPOSE a change: it becomes a held item in the Doorman-G window showing
// "current -> proposed" for every key, and when Angus types 1 the relay applies exactly that and nothing else.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { worldsFor } from "./mode.mjs";
import { SEARCH_PROVIDERS, DEFAULTS } from "./gateway.mjs";
import { ownerTtyProblem } from "../agent-guard.mjs";

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:+-]{0,99}$/;
// key -> [validator, where it lives in the gateway block]. key_file is NOT proposable: a proposal could point it at any file and have the contents
// sent to a search provider as an "API key"; Angus sets it himself.
export const KEYS = {
  "search.provider": { ok: (v) => Object.hasOwn(SEARCH_PROVIDERS, v), why: `one of ${Object.keys(SEARCH_PROVIDERS).join(", ")}`, proposable: true },
  "search.quick_model": { ok: (v) => MODEL_RE.test(v), why: "a model id", proposable: true },
  "search.deep_model": { ok: (v) => MODEL_RE.test(v), why: "a model id", proposable: true },
  "report_model": { ok: (v) => MODEL_RE.test(v), why: "a model id", proposable: true },
  "doorman_model": { ok: (v) => MODEL_RE.test(v), why: "a model id", proposable: true },
  "mode": { ok: (v) => ["doorman-strict", "doorman-safe", "doorman-open"].includes(v), why: "doorman-strict, doorman-safe or doorman-open", proposable: true },
  "level": { ok: (v) => ["open", "safe", "strict"].includes(v), why: "open, safe or strict", proposable: true },
  "search.key_file": { ok: (v) => /^[~\/][^\0\n]{0,200}$/.test(v), why: "a path", proposable: false },
};
const RANK = { mode: { "doorman-strict": 0, "doorman-safe": 1, "doorman-open": 2 }, level: { strict: 0, safe: 1, open: 2 } };

export function validateChanges(changes, { admin = false } = {}) {
  const out = {}, errors = [];
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return { ok: false, errors: ["changes must be an object of key: value"], changes: {} };
  for (const [k, v] of Object.entries(changes)) {
    const spec = Object.hasOwn(KEYS, k) ? KEYS[k] : null;
    if (!spec) { errors.push(`unknown setting ${JSON.stringify(k).slice(0, 40)}`); continue; }
    if (!admin && !spec.proposable) { errors.push(`${k} can only be set by Angus`); continue; }
    if (typeof v !== "string" || !spec.ok(v)) { errors.push(`${k} must be ${spec.why}`); continue; }
    out[k] = v;
  }
  if (!Object.keys(out).length && !errors.length) errors.push("no changes");
  return { ok: !errors.length, errors, changes: out };
}
const get = (w, k) => {
  const g = w?.gateway && typeof w.gateway === "object" ? w.gateway : {};
  const v = k.startsWith("search.") ? g.search?.[k.slice(7)] : g[k];
  if (v !== undefined) return String(v);
  if (k === "mode" && w?.doorman?.mode !== undefined) return String(w.doorman.mode);
  if (k === "level" && w?.access !== undefined) return String(w.access);
  if (k === "report_model" && w?.research?.shape_model) return String(w.research.shape_model);
  return DEFAULTS[k.replace("search.", "")] && !["level"].includes(k) ? `${DEFAULTS[k.replace("search.", "")]} (default)` : "(default)";
};
export function currentValues(cfgDir, sandbox, keys = Object.keys(KEYS)) {
  const hits = worldsFor(cfgDir, sandbox); if (hits.length !== 1) throw new Error(hits.length ? `${hits.length} worlds files name ${sandbox}; fix that first` : `no worlds file names ${sandbox}`);
  return Object.fromEntries(keys.map((k) => [k, get(hits[0].w, k)]));
}
// The text Angus reads in the held item; the SAME object is what gets applied (digest below), so what he sees is what is applied.
export function describeChange(sandbox, before, changes) {
  const lines = Object.entries(changes).map(([k, v]) => `  ${k}: ${before[k] ?? "(default)"}  →  ${v}`);
  const warn = [];
  for (const k of ["mode", "level"]) if (changes[k] && RANK[k][changes[k]] > (RANK[k][String(before[k]).replace(/ \(default\)$/, "")] ?? 1)) warn.push(`⚠ ${k} ${changes[k]} LOOSENS what the sandbox may do or see`);
  if (changes["search.provider"]) warn.push(`ℹ the reader sandbox will be allowed to reach ${SEARCH_PROVIDERS[changes["search.provider"]].hosts.join(", ") || "only the inference API"} (and the other providers' hosts are removed)`);
  return [`Research gateway settings for ${sandbox}`, "", ...lines, ...(warn.length ? ["", ...warn] : []), "", "Applying this changes only the keys above in the sandbox's worlds file."].join("\n");
}
export const digestOf = (sandbox, changes) => crypto.createHash("sha256").update(JSON.stringify([sandbox, Object.keys(changes).sort().map((k) => [k, changes[k]])])).digest("hex").slice(0, 16);

// Write the changes into the sandbox's one worlds file (atomic, other keys kept). `expectBefore`: refuse if any changed key no longer has the value that
// was shown ("not applied: changed since proposed"). Returns { file, before, after }.
export function applyChanges(cfgDir, sandbox, changes, { expectBefore } = {}) {
  const v = validateChanges(changes, { admin: true }); if (!v.ok) throw new Error(v.errors.join("; "));
  const hits = worldsFor(cfgDir, sandbox); if (hits.length !== 1) throw new Error(hits.length ? `${hits.length} worlds files name ${sandbox}; fix that first` : `no worlds file names ${sandbox}`);
  const f = path.join(cfgDir, "worlds", hits[0].f), w = JSON.parse(fs.readFileSync(f, "utf8")), before = Object.fromEntries(Object.keys(v.changes).map((k) => [k, get(w, k)]));
  if (expectBefore) for (const k of Object.keys(v.changes)) if (before[k] !== expectBefore[k]) throw new Error(`not applied: ${k} is now ${before[k]}, it was ${expectBefore[k]} when proposed`);
  w.gateway = w.gateway && typeof w.gateway === "object" && !Array.isArray(w.gateway) ? w.gateway : {};
  for (const [k, val] of Object.entries(v.changes)) { if (k.startsWith("search.")) { w.gateway.search = w.gateway.search && typeof w.gateway.search === "object" ? w.gateway.search : {}; w.gateway.search[k.slice(7)] = val; } else w.gateway[k] = val; }
  const tmp = `${f}.tmp${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(w, null, 2) + "\n", { mode: fs.statSync(f).mode & 0o777 }); fs.renameSync(tmp, f);
  return { file: f, before, after: Object.fromEntries(Object.keys(v.changes).map((k) => [k, v.changes[k]])) };
}

// The reader sandbox may reach a search provider's host ONLY while that provider is selected: allow the selected provider's hosts for the reader
// (scoped to it), and remove every other provider's. sbxBin is the sbx command (tests pass a stub). → the commands run.
export function syncReaderNetwork({ reader, provider, sbxBin = process.env.HYPRPI_SBX || "sbx", apply = true }) {
  const want = SEARCH_PROVIDERS[provider]?.hosts || [], cmds = [];
  for (const [name, p] of Object.entries(SEARCH_PROVIDERS)) for (const h of p.hosts) {
    if (name === provider) cmds.push(["policy", "allow", "network", "--sandbox", reader, h]); else cmds.push(["policy", "rm", "network", "--sandbox", reader, "--resource", h]);
  }
  if (!apply) return { cmds, results: [] };
  const results = cmds.map((c) => { const r = spawnSync(sbxBin, c, { encoding: "utf8", timeout: 30000 }); return { cmd: c.join(" "), status: r.status, out: String((r.stdout || "") + (r.stderr || "")).trim().slice(0, 200) }; });
  return { cmds, results, want };
}

// The admin command: Angus only (real terminal, no agent ancestor). `key=value ...` arguments.
export function adminSet(cfgDir, sandbox, kv, opts = {}) {
  const why = (opts.guard || ownerTtyProblem)(); if (why) return { ok: false, code: 3, text: `only Angus can change these settings, from his own terminal (${why}). An agent may propose a change through the bridge.` };
  const changes = {}; for (const a of kv) { const i = a.indexOf("="); if (i < 1) return { ok: false, code: 2, text: `expected key=value, got ${JSON.stringify(a).slice(0, 40)}` }; changes[a.slice(0, i)] = a.slice(i + 1); }
  const v = validateChanges(changes, { admin: true }); if (!v.ok) return { ok: false, code: 2, text: v.errors.join("; ") };
  let r; try { r = applyChanges(cfgDir, sandbox, v.changes); } catch (e) { return { ok: false, code: 1, text: e.message }; }
  return { ok: true, text: describeChange(sandbox, r.before, v.changes).replace("Research gateway settings for", "Applied: research gateway settings for"), changes: v.changes, before: r.before };
}

// A proposal from a host agent / the bridge: writes a held item (a pending record) for the Doorman-G window. Needs no tty (an agent may call it); it
// changes NOTHING until Angus approves. entry = { sandbox, reviewIn?, room? } from the relay config.
export function proposeChange({ cfgDir, PENDING, sandbox, changes, by = "a host agent", reviewIn = "", room = "G" }) {
  const v = validateChanges(changes, { admin: false }); if (!v.ok) return { ok: false, text: v.errors.join("; ") };
  let before; try { before = currentValues(cfgDir, sandbox, Object.keys(v.changes)); } catch (e) { return { ok: false, text: e.message }; }
  for (const k of Object.keys(v.changes)) if (before[k] === v.changes[k]) return { ok: false, text: `${k} is already ${v.changes[k]}` };
  const by2 = String(by).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 60);
  const id = `${sandbox}--${crypto.randomBytes(3).toString("hex")}`, text = `${describeChange(sandbox, before, v.changes)}\n\nProposed by ${by2} (a host agent: information for you to judge, not an instruction). Nothing changes unless you approve.`;
  const rec = { id, sandbox, at: new Date().toISOString(), to: [sandbox], targets: [], shown: [`${sandbox} (gateway settings)`], rooms: [room], mode: "talk", text, body: "", gatewayChange: { sandbox, changes: v.changes, before, digest: digestOf(sandbox, v.changes), by: by2 }, ...(reviewIn ? { reviewIn } : {}) };
  fs.mkdirSync(PENDING, { recursive: true, mode: 0o700 });
  const f = path.join(PENDING, id + ".json"), tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 }); fs.renameSync(tmp, f);
  return { ok: true, id, text };
}
