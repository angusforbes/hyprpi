// node test/bridge-scope.mjs  (J428: a host job's folders and tools; pure, temp folders)
import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { checkScope } from "../docker/bridge/scope.mjs";
const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-home-")));
for (const d of ["Work/proj", "Work/free/sub", ".ssh", "keys", "Docs", "Work/.hidden"]) fs.mkdirSync(path.join(H, d), { recursive: true });
fs.writeFileSync(path.join(H, "Docs/file.txt"), "x"); fs.symlinkSync(path.join(H, ".ssh"), path.join(H, "Work/sneaky"));
const W = (p) => path.join(H, p);
const shares = { mounts: [{ host: W("Work"), ro: false }, { host: W("Work/proj"), ro: true }], hidden: [{ path: W("Work/free/sub") }] };
const ctx = { home: H, shares };
const ok = (r, m) => assert.equal(r.ok, true, `${m}: ${r.text}`), bad = (r, re, m) => { assert.equal(r.ok, false, m); assert.match(r.text, re, m); };
// W5: a draft naming nothing gets exactly the sandbox's shares and rights, hidden paths included
let r = checkScope({ world: "world-t" }, ctx); ok(r, "no folders named");
assert.deepEqual(r.folders.map((x) => [x.path, x.access]), [[W("Work"), "write"], [W("Work/proj"), "read"]], "the shares with their rights");
assert.deepEqual(r.hidden, [W("Work/free/sub")]); assert.deepEqual(r.beyond, []); assert.deepEqual(r.tools, ["Read", "Glob", "Grep", "Write", "Edit"]);
assert.match(r.text, /^Folders: T's shares \(2 folders, 1 writable/); assert.ok(!/BEYOND/.test(r.text));
// a folder inside the shares with the rights it has: nothing extra; beyond them: shown prominently
ok(checkScope({ folders: [{ path: "~/Work/free", access: "write" }] }, ctx), "inside a writable share");
assert.equal(checkScope({ folders: [{ path: "~/Work/free", access: "write" }] }, ctx).beyond.length, 0);
r = checkScope({ world: "world-t", folders: [{ path: "~/Docs", access: "write" }, { path: "~/Work/proj", access: "read" }], tools: ["Read", "Write"] }, ctx); ok(r, "beyond");
assert.deepEqual(r.beyond.map((x) => [x.path, x.access]), [[W("Docs"), "write"]], "only ~/Docs is beyond (proj is a share, read)");
assert.match(r.text, /⚠ BEYOND T's SHARES: .*Docs \(read and WRITE\)\nTools: Read, Write$/);
bad(checkScope({ folders: [{ path: H, access: "read" }] }, ctx), /never the home folder itself/, "home root");
bad(checkScope({ folders: [{ path: "/", access: "read" }] }, ctx), /inside the home folder/, "/");
bad(checkScope({ folders: [{ path: "/etc", access: "read" }] }, ctx), /inside the home folder/, "outside home");
bad(checkScope({ folders: [{ path: "~/.ssh", access: "read" }] }, ctx), /hidden/, "~/.ssh");
bad(checkScope({ folders: [{ path: "~/Work/sneaky", access: "read" }] }, ctx), /hidden/, "a symlink to ~/.ssh is judged by its real path");
bad(checkScope({ folders: [{ path: "~/Work/.hidden", access: "read" }] }, ctx), /hidden/, "a dot folder deeper down");
bad(checkScope({ folders: [{ path: "~/keys", access: "read" }] }, ctx), /credentials/, "keys");
bad(checkScope({ folders: [{ path: "~/Work/proj", access: "write" }] }, ctx), /read-only \(protected\)/, "a protected project for writing");
bad(checkScope({ folders: [{ path: "~/Work", access: "write" }] }, { home: H, shares: { mounts: [{ host: W("Work/proj"), ro: true }] } }), /holds .*read-only/, "a folder holding a protected one, for writing");
bad(checkScope({ folders: [{ path: "~/Work/free/sub", access: "read" }] }, { home: H, shares: { mounts: [], hidden: [{ path: W("Work/free/sub") }] } }), /hidden \(gitignored\)/, "a hidden path can't be named to un-hide it");
bad(checkScope({ folders: [{ path: "~/Docs/file.txt", access: "read" }] }, ctx), /not a folder/, "a file");
bad(checkScope({ folders: [{ path: "~/nope", access: "read" }] }, ctx), /no such folder/, "missing");
bad(checkScope({ folders: [{ path: "Work/free", access: "read" }] }, ctx), /absolute/, "relative");
bad(checkScope({ folders: [{ path: "~/Docs", access: "rw" }] }, ctx), /access must be/, "bad access");
bad(checkScope({ folders: [1, 2, 3, 4, 5].map(() => ({ path: "~/Docs", access: "read" })) }, ctx), /at most 4/, "too many");
bad(checkScope({ folders: [{ path: "~/Docs", access: "read" }], tools: ["Write"] }, { home: H, shares: { mounts: [] } }), /needs a folder with write access/, "Write without a write folder");
bad(checkScope({ tools: ["default"] }, ctx), /isn't allowed/, "an unknown tool");
bad(checkScope({ tools: ["Read"] }, { home: H, shares: { mounts: [] } }), /at least one folder/, "file tools, no folder");
r = checkScope({ tools: ["Bash"] }, ctx); ok(r, "Bash"); assert.match(r.text, /isn't limited to these folders/);
bad(checkScope({ folders: [{ path: "~/Docs\n", access: "read" }] }, ctx), /control characters/, "control chars");
bad(checkScope({ folders: "~/Docs" }, ctx), /must be lists/, "not a list");
r = checkScope({ folders: [{ path: "~/Docs", access: "read" }, { path: "~/Docs", access: "write" }] }, ctx); assert.equal(r.beyond.length, 1); assert.equal(r.beyond[0].access, "write", "a repeated folder: one entry, the wider access");
r = checkScope({}, { home: H, shares: null }); ok(r, "shares unknown, nothing named"); assert.deepEqual([r.folders, r.tools], [[], []], "shares unknown: no folders and no file tools (fail closed)");
bad(checkScope({ folders: [{ path: "~/Docs", access: "write" }] }, { home: H, shares: null }), /protected/, "shares unknown: no write access at all");
fs.rmSync(H, { recursive: true, force: true });
console.log("bridge-scope: all pass");
// the runner: exactly the approved folders and tools, read-only ones denied Write/Edit; an answer can't widen it (J428 W2)
{
  const { plan } = await import("../docker/bridge/runner.mjs");
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-run-"))); for (const d of ["rw", "ro", "other"]) fs.mkdirSync(path.join(T, d));
  const job = { id: "world-t--abc428", approved: { action: "x", tools: ["Read", "Write"], folders: [path.join(T, "rw"), path.join(T, "ro")], read_only: [path.join(T, "ro")], hidden: [path.join(T, "rw", "secret")], time_limit_s: 600 }, questions: [] };
  const a = plan(job, { mcpConfig: "/tmp/m.json" }).argv, at = (f) => a[a.indexOf(f) + 1];
  assert.deepEqual(a.filter((x, i) => a[i - 1] === "--add-dir"), [path.join(T, "rw"), path.join(T, "ro")], "--add-dir: exactly the job's folders");
  const deny = a.slice(a.indexOf("--disallowedTools") + 1, a.indexOf("--permission-mode"));
  assert.equal(at("--tools"), "Read,Write"); assert.ok(deny.includes(`Write(/${T}/ro/**)`) && deny.includes(`Edit(/${T}/ro/**)`), "writes denied in the read-only folder");
  assert.ok(deny.includes(`Read(/${T}/rw/secret)`) && deny.includes(`Read(/${T}/rw/secret/**)`), "a hidden path denied for reading");
  assert.ok(!deny.some((x) => x.startsWith("Write") && x.includes("/rw/")), "the writable folder isn't denied");
  const answered = { ...job, questions: [{ n: 1, text: "may I also use " + path.join(T, "other") + "?", answer: `yes, use ${path.join(T, "other")} and Bash too` }] };
  const b = plan(answered, { mcpConfig: "/tmp/m.json" });
  assert.deepEqual(b.argv, a, "an owner's answer changes nothing in the command: no folder, no tool");
  assert.match(b.prompt, /can't be widened/); assert.match(b.prompt, /needs_wider/);
  const roOnly = plan({ ...job, approved: { ...job.approved, folders: [path.join(T, "ro")], read_only: [path.join(T, "ro")] } }, { mcpConfig: "/tmp/m.json" }).argv;
  assert.equal(roOnly[roOnly.indexOf("--tools") + 1], "Read", "no writable folder: no Write at all"); assert.ok(!roOnly[roOnly.indexOf("--allowedTools") + 1].split(",").includes("Write"));
  console.log("runner argv:", a.slice(1).map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ").replace(/\/tmp\/scope-run-\w+/g, "$T"));
  fs.rmSync(T, { recursive: true, force: true });
  console.log("bridge-scope runner: all pass");
}
// J428Review: rule metacharacters; scope_held / scoping never stuck; a write folder from scoping brings Write/Edit when no tools were named
{
  const H2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-meta-")));
  for (const d of ["notes) free", "ok", "rw/secret[abc]", "rw/plain"]) fs.mkdirSync(path.join(H2, d), { recursive: true });
  const r1 = checkScope({ folders: [{ path: path.join(H2, "notes) free"), access: "read" }] }, { home: H2, shares: { mounts: [] } });
  assert.equal(r1.ok, false); assert.match(r1.text, /permission rules can't hold/);
  const { plan } = await import("../docker/bridge/runner.mjs");
  const job = { id: "world-t--abc429", approved: { action: "x", tools: ["Read", "Edit"], folders: [path.join(H2, "ok"), path.join(H2, "notes) free"), path.join(H2, "rw")], read_only: [path.join(H2, "notes) free")], hidden: [path.join(H2, "rw/secret[abc]")], time_limit_s: 600 }, questions: [] };
  const a = plan(job, { mcpConfig: "/tmp/m.json" }).argv, dirs = a.filter((x, i) => a[i - 1] === "--add-dir");
  assert.deepEqual(dirs, [path.join(H2, "ok")], "a read-only folder with ')' and a share holding an unfenceable hidden path are left out entirely");
  assert.ok(!a.some((x) => x.includes("notes) free") || x.includes("[abc]")), "no unsafe path reaches a rule");
  const { sweep, scopeDecision, newJob } = await import("../docker/bridge/core.mjs");
  const now = Date.parse("2026-10-10T12:00:00Z"), iso = (ms) => new Date(ms).toISOString();
  let s = sweep({ type: "host_job", state: "scope_held", proposal: { at: iso(now - 25 * 3600e3), folders: [] }, approved: { time_limit_s: 600 } }, now); assert.equal(s.patch.state, "declined", "an unanswered proposal expires");
  s = sweep({ type: "host_job", state: "scoping", created_at: iso(now - 2 * 3600e3), history: [], approved: { time_limit_s: 600 } }, now); assert.equal(s.patch.state, "needs_wider", "nobody scoped it within an hour");
  assert.equal(sweep({ type: "host_job", state: "scoping", created_at: iso(now - 60e3), history: [], approved: { time_limit_s: 600 } }, now), null);
  const j = newJob({ id: "world-t--abc430", sandbox: "world-t", asker: "A", action: "x", tools: ["Read", "Glob", "Grep"], folders: [path.join(H2, "ok")], readOnly: [path.join(H2, "ok")], needs: "y", nowMs: now });
  const d = scopeDecision({ ...j, state: "scope_held", proposal: { held_id: "h1", folders: [] } }, true, "h1", [{ path: path.join(H2, "rw/plain"), access: "write", id: "1:2" }], now);
  assert.ok(d.patch.approved.tools.includes("Write") && d.patch.approved.tools.includes("Edit"), "a write folder from scoping brings Write/Edit (no tools named)");
  assert.equal(d.patch.approved.folder_ids[path.join(H2, "rw/plain")], "1:2");
  fs.rmSync(H2, { recursive: true, force: true });
  console.log("bridge-scope review cases: all pass");
}
