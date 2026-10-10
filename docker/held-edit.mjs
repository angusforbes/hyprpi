// J365 ("approve with modifications"): Angus's edit of a held item, in two steps so that an edit can never outlive or outrun the approval it belongs to.
//   prepareEdit(): runs in the relay's guarded CLI (real terminal, no agent ancestor), BEFORE the approval file is written. It validates the edit
//     with host code and writes an edit envelope edits/<id>.json (unique temp name, atomic rename) holding { kind, edited, original, digest }. It does
//     NOT touch the pending record or the plan file. The approval file then carries "edit:<digest>".
//   takeEdit(): runs in Relay.decide() after the held item was claimed. It applies the envelope ONLY if the decision names its digest and the
//     envelope matches; the envelope is always deleted (a stale one, left by an interrupted CLI, is never applied by a later approval).
// A research plan's edit is checked by the research runner (research.mjs edit-check: planCheck, same as the Doorman's own searches); a plain
// message's text is cleaned and size-limited. Both versions are kept (envelope -> relay log "edit" line; research log; plan file).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const sha = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
const ID = /^[A-Za-z0-9._-]+--[0-9a-f]{6}$/;

export function prepareEdit(id, editFile, { PENDING, EDITS, RESEARCH, clean, bytes, maxBytes }) {
  if (!ID.test(id)) return { ok: false, code: 1, reason: "bad id" };
  let text;
  try { const st = fs.statSync(editFile); if (!st.isFile() || st.size > 40000) throw new Error("bad edit file"); text = fs.readFileSync(editFile, "utf8"); } catch (e) { return { ok: false, code: 4, reason: `can't read the edit (${e.message})` }; }
  let m; try { m = JSON.parse(fs.readFileSync(path.join(PENDING, id + ".json"), "utf8")); } catch { return { ok: false, code: 1, reason: "no such pending message" }; }
  let env;
  if (m.research?.plan) {
    const r = spawnSync(process.execPath, [RESEARCH, "edit-check", "--rid", String(m.research.rid)], { input: text, encoding: "utf8", timeout: 20000 });
    let o; try { o = JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { o = { ok: false, reason: "the research runner gave no answer" }; }
    if (!o.ok) return { ok: false, code: 4, reason: o.reason };
    env = { kind: "research-plan", rid: String(m.research.rid), edited: o.searches, original: m.research.searches || o.original };
  } else if (!m.draft && !m.gpu && !m.taskChange && !m.research && !m.typed && m.mode === "talk") {
    const t = clean(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!t) return { ok: false, code: 4, reason: "the text is empty" };
    if (bytes(t) > maxBytes) return { ok: false, code: 4, reason: `over ${maxBytes} bytes` };
    env = { kind: "talk", edited: t, original: m.text };
  } else return { ok: false, code: 4, reason: "this kind of request can't be edited" };
  env.digest = sha({ id, kind: env.kind, edited: env.edited }); env.id = id;
  fs.mkdirSync(EDITS, { recursive: true, mode: 0o700 });
  const f = path.join(EDITS, id + ".json"), tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 }); fs.renameSync(tmp, f);
  return { ok: true, digest: env.digest };
}

// In Relay.decide(), after the pending record was claimed and removed. digest = what the decision file named (or "").
export function takeEdit(id, digest, msg, { EDITS, RESEARCH, log }) {
  const f = path.join(EDITS, id + ".json"); let env = null;
  try { env = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* none */ }
  try { fs.unlinkSync(f); } catch { /* none */ }
  if (!env || !digest || env.digest !== digest || env.id !== id || sha({ id, kind: env.kind, edited: env.edited }) !== digest) return { msg, applied: false };
  if (env.kind === "talk" && !msg.research && !msg.draft && !msg.gpu && !msg.taskChange && !msg.typed && typeof env.edited === "string") {
    const head = String(msg.body || "").split("\n")[0];
    log({ op: "edit", id, kind: "talk", original: String(env.original || "").slice(0, 4000), edited: env.edited });
    return { msg: { ...msg, text: env.edited, body: `${head}\n🐳│ ${env.edited.split("\n").join("\n🐳│ ")}\n🐳│ (edited by Angus before it was sent)` }, applied: true };
  }
  if (env.kind === "research-plan" && msg.research?.plan && String(msg.research.rid) === env.rid && Array.isArray(env.edited)) {
    const r = spawnSync(process.execPath, [RESEARCH, "edit-apply", "--rid", env.rid], { input: JSON.stringify(env.edited), encoding: "utf8", timeout: 20000 });
    let o; try { o = JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { o = { ok: false, reason: "the research runner gave no answer" }; }
    log({ op: "edit", id, kind: "research-plan", original: env.original, edited: env.edited, applied: !!o.ok, ...(o.ok ? {} : { reason: o.reason }) });
    if (!o.ok) return { msg, applied: false, failed: o.reason };
    return { msg: { ...msg, research: { ...msg.research, searches: env.edited } }, applied: true };
  }
  return { msg, applied: false };
}
