// J670: fast-browse's pure parts: snapshot parsing, the legal actions it offers JEV (never a password/MFA/payment field,
// no re-fill of a field that already holds the value, autocomplete comboboxes are fillable, uploads only on file fields),
// and the key reader (env first, then the bashrc export line; never printed). No browser, no network, no processes.
// Run: node test/fast-browse.mjs
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let fail = 0; const check = (n, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) fail++; };
const m = await import("../bin/fast-browse");
const snap = `- heading "Upload form" [level=1, ref=e1]
- textbox "Name" [ref=e4]
- textbox "Email" [ref=e5]: angus@example.com
- combobox "Plan" [expanded=false, ref=e6]: Choose…
  - option "Choose…" [selected, ref=e8]
  - option "Pro" [ref=e10]
- checkbox "I agree" [checked=false, ref=e2]
- button "File" [ref=e7]: No file chosen
- textbox "Password" [ref=e11]
- textbox "Card number" [ref=e12]
- combobox "Search Wikipedia" [expanded=false, ref=e13]
- radio "Express" [checked=false, ref=e14]
- button "Submit" [ref=e3]`;
const els = m.parseSnapshot(snap);
check("parses every ref'd element, options under their combobox", els.length === 11 && els.find((e) => e.ref === "e6").options.map((o) => o.ref).join() === "e8,e10");
const acts = m.buildActions(els, { inputs: { name: "Angus", email: "angus@example.com" }, files: { upload: "/x/upload.txt" } });
const keys = Object.keys(acts);
check("fill offered for an empty textbox", keys.includes("fill e4 name"));
check("no re-fill of a field already holding that value", !keys.includes("fill e5 email"));
check("select offers only unselected options", keys.includes("select e6 e10") && !keys.includes("select e6 e8"));
check("checkbox → check", keys.includes("check e2"));
check("upload only on the file field, with the file input", keys.includes("upload e7 upload") && !keys.includes("click e7"));
check("never a password or card-number field", !keys.some((k) => / e1[12] /.test(k + " ")));
check("an autocomplete combobox (no options) is fillable", keys.includes("fill e13 name"));
check("radio → click; button → click", keys.includes("click e14") && keys.includes("click e3"));
check("Enter offered only on a field with a value", keys.includes("enter e5") && !keys.includes("enter e4"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-")), rc = path.join(dir, "bashrc");
fs.writeFileSync(rc, '[[ $- != *i* ]] && return\nexport TYPESAFE_API_KEY="ts_fake_123"\n');
check("key: environment first", m.readKey({ TYPESAFE_API_KEY: "env_key" }, rc) === "env_key");
check("key: else the bashrc export line (past the interactive guard)", m.readKey({}, rc) === "ts_fake_123");
check("key: none → empty", m.readKey({}, path.join(dir, "missing")) === "");
const src = fs.readFileSync(new URL("../bin/fast-browse", import.meta.url), "utf8");
check("the key is never written to output: only into the Authorization header, and scrubbed from error bodies", (src.match(/\bkey\b/g) || []).length > 0 && /split\(key\)\.join\("<key>"\)/.test(src) && !/console\.(log|error)\([^)]*\bkey\b/.test(src));
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
