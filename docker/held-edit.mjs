// J365 ("approve with modifications"): what happens to Angus's edit of a held item before the relay approves it. Pure host code, called only from
// the relay's guarded CLI (real terminal, no agent ancestor). A research plan's edit goes through the research runner's host checks
// (research.mjs edit -> planCheck: pattern pre-check, copied words and numbers against the request, J360 link rules, task); a plain message's
// text is cleaned and size-limited like the original. Both versions are kept: the pending record carries { edit: { text, original } } (message) or
// { edited: { original, edited } } (plan; the plan file keeps both too), and the log gets an "edit" line with both.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function applyHeldEdit(id, editFile, { PENDING, RESEARCH, clean, bytes, maxBytes, log }) {
  let text;
  try { const st = fs.statSync(editFile); if (!st.isFile() || st.size > 40000) throw new Error("bad edit file"); text = fs.readFileSync(editFile, "utf8"); } catch (e) { return { ok: false, code: 4, reason: `can't read the edit (${e.message})` }; }
  const pf = path.join(PENDING, id + ".json"); let m;
  try { m = JSON.parse(fs.readFileSync(pf, "utf8")); } catch { return { ok: false, code: 1, reason: "no such pending message" }; }
  if (m.research?.plan) {
    const r = spawnSync(process.execPath, [RESEARCH, "edit", "--rid", String(m.research.rid)], { input: text, encoding: "utf8", timeout: 20000 });
    let o; try { o = JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { o = { ok: false, reason: "the research runner gave no answer" }; }
    if (!o.ok) return { ok: false, code: 4, reason: o.reason };
    const before = m.research.searches || [];
    m.research.searches = o.searches;
    if (before.length) m.text = String(m.text).replace(/(^|\n\n)((?:- .*(?:\n|$))+)\s*$/, (_, a) => `${a}${o.searches.map((x) => `- ${x}`).join("\n")}`);
    m.edited = { original: m.edited?.original ?? before, edited: o.searches };
    log({ op: "edit", id, kind: "research-plan", original: m.edited.original, edited: o.searches });
  } else if (!m.draft && !m.gpu && !m.taskChange && !m.research && m.mode === "talk") {
    const t = clean(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!t) return { ok: false, code: 4, reason: "the text is empty" };
    if (bytes(t) > maxBytes) return { ok: false, code: 4, reason: `over ${maxBytes} bytes` };
    m.edit = { text: t, original: m.edit?.original ?? m.text };
    log({ op: "edit", id, kind: "talk", original: m.edit.original, edited: t });
  } else return { ok: false, code: 4, reason: "this kind of request can't be edited" };
  fs.writeFileSync(pf + ".tmp", JSON.stringify(m, null, 2), { mode: 0o600 }); fs.renameSync(pf + ".tmp", pf);
  return { ok: true };
}
