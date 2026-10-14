#!/usr/bin/env node
// J566: hyprpi's test runner. Every test runs inside the test guard (test/guard/): a bubblewrap sandbox (own pid + network
// namespace, live runtime folders masked, live hyprpi state read-only, every leftover process killed at the end) with the
// kill-guard preload in every node process. A test can't see, signal or close Angus's agents, windows or live daemon from in here,
// and any attempt is refused with a message and fails that test.
//
//   node test/run.mjs FILE…            run these tests (paths or names: top-tui, test/top-tui.mjs)
//   node test/run.mjs --all            the gate's unit set (Blink's selection): test/*.mjs, docker/*/test-*.mjs, docker/test-*.mjs and
//                                      test/*.sh (run with bash), minus gateway-e2e, *-live*, model-check (paid/live) and run.mjs
//   node test/run.mjs FILE -- ARGS…    pass ARGS to the test(s), e.g. test/gateway-e2e.mjs -- --require-complete --report /tmp/x.json
//   node test/run.mjs --all --list     print what --all would run (after its skips), run nothing
//   options: -j N (parallel, default 4) · --timeout S (per test, default 600) · --net (share the host network: for tests that
//            need the internet; the pid namespace and masks stay) · --keep (keep the run folder) · --quiet (no output on pass)
//   A test can ask for the network itself with a comment line `// test-guard: net` in its first 20 lines, and be left out of
//   --all with `// test-guard: skip REASON` (a quarantined or live test; listed as skipped with its reason, never silently).
//   Exit 0 = all passed. Logs: one file per test in the run folder (printed at the end).
// No sandbox on this machine (no bwrap / user namespaces): it refuses to run (exit 87); there is no unguarded mode.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRELOAD, spawnSandboxed, sandboxUnavailable } from "./guard/sandbox.mjs";

const TEST = path.dirname(new URL(import.meta.url).pathname), ROOT = path.dirname(TEST);
const dd = process.argv.indexOf("--"), argv = process.argv.slice(2, dd < 0 ? undefined : dd), testArgs = dd < 0 ? [] : process.argv.slice(dd + 1);
const flag = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (f, d) => { const i = argv.indexOf(f); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const all = flag("--all"), listOnly = flag("--list"), netAll = flag("--net"), keep = flag("--keep"), quiet = flag("--quiet");
const jobs = Math.max(1, Number(opt("-j", 4)) || 4), timeoutS = Math.max(5, Number(opt("--timeout", 600)) || 600);
if (argv.some((a) => a.startsWith("-"))) { console.error("usage: node test/run.mjs [--all] [--list] [-j N] [--timeout S] [--net] [--keep] [--quiet] [FILE…]"); process.exit(2); }

const resolve = (a) => {
  for (const c of [a, path.join(TEST, a), path.join(TEST, a + ".mjs"), path.join(ROOT, a)]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
  console.error(`no such test: ${a}`); process.exit(2);
};
const list = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; } };
const unitSet = () => {
  const docker = path.join(ROOT, "docker"), subs = list(docker, /^[^.]/).filter((d) => fs.statSync(d).isDirectory());
  return [...list(TEST, /\.mjs$/), ...subs.flatMap((d) => list(d, /^test-.*\.mjs$/)), ...list(docker, /^test-.*\.mjs$/), ...list(TEST, /\.sh$/)]
    .filter((f) => !/^(run\.mjs|gateway-e2e\.mjs|model-check\.mjs)$/.test(path.basename(f)) && !/-live/.test(path.basename(f)));
};
const files = all ? unitSet() : argv.map(resolve);
if (!files.length) { console.error("no tests given (FILE… or --all)"); process.exit(2); }

const why = sandboxUnavailable();
if (why) { console.error(`test guard: can't build the sandbox here: ${why}. Tests don't run unguarded.`); process.exit(87); }

const skipOf = (f) => { try { return (/^\s*(?:\/\/|#)\s*test-guard:\s*skip\b\s*(.*)$/m.exec(fs.readFileSync(f, "utf8").split("\n").slice(0, 20).join("\n")) || [])[1]?.trim() ?? null; } catch { return null; } };
const skipped = all ? files.filter((f) => skipOf(f) != null) : [];
for (const f of skipped) { console.log(`skip ${path.relative(ROOT, f)} (${skipOf(f) || "marked test-guard: skip"})`); files.splice(files.indexOf(f), 1); }
if (listOnly) { for (const f of files) console.log(path.relative(ROOT, f)); process.exit(0); } // (--list: the selection, nothing run)
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "hyprpi-testrun-"));
const wantsNet = (f) => { try { return /^\s*(?:\/\/|#)\s*test-guard:\s*net\b/m.test(fs.readFileSync(f, "utf8").split("\n").slice(0, 20).join("\n")); } catch { return false; } };
const runOne = (file) => new Promise((done) => {
  const name = path.relative(ROOT, file).replace(/^(\.\.\/)+/, "").replace(/[/\\]/g, "_"), log = path.join(runDir, name + ".log"), guardLog = path.join(runDir, name + ".refusals.jsonl");
  const out = fs.openSync(log, "w"), t0 = Date.now();
  const cmd = file.endsWith(".sh") ? ["bash", file, ...testArgs] : [process.execPath, `--import=${PRELOAD}`, file, ...testArgs];
  const tmp = path.join(runDir, name + ".tmp"); fs.mkdirSync(tmp);
  // a test file that lives in /tmp: its folder's regular files are copied into the private /tmp (sockets and other files there stay out)
  if (file.startsWith("/tmp/")) {
    const dir = path.dirname(file), into = path.join(tmp, path.relative("/tmp", dir)); fs.mkdirSync(into, { recursive: true });
    for (const n of fs.readdirSync(dir)) { const src = path.join(dir, n); try { const st = fs.lstatSync(src); if (st.isFile() && st.size < 5e6) fs.copyFileSync(src, path.join(into, n)); } catch { /* skip */ } }
  }
  const child = spawnSandboxed(cmd, { tmp, net: netAll || wantsNet(file), log: guardLog, cwd: ROOT, stdio: ["ignore", out, out] });
  const timer = setTimeout(() => { fs.appendFileSync(log, `\n[test/run.mjs] timed out after ${timeoutS}s\n`); child.kill("SIGKILL"); }, timeoutS * 1000); // bwrap dies -> the namespace dies with it
  child.on("exit", (code, sig) => {
    clearTimeout(timer); fs.closeSync(out);
    let refusals = []; try { refusals = fs.readFileSync(guardLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).why); } catch { /* none */ }
    done({ file, log, tmp, code: code ?? 128, sig, refusals, secs: ((Date.now() - t0) / 1000).toFixed(1) });
  });
});

const results = [], queue = [...files];
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, async () => {
  while (queue.length) {
    const r = await runOne(queue.shift()); results.push(r);
    const pass = r.code === 0 && !r.refusals.length, rel = path.relative(ROOT, r.file);
    const hint = !pass && !r.refusals.length && (r.code === 143 || r.code === 137 || r.code === 129) ? " - the sandbox was signalled from inside (e.g. kill 0 / kill -1 in a shell): the guard ended the test there" : "";
    if (!pass || !quiet) console.log(`${pass ? "ok  " : "FAIL"} ${rel} (${r.secs}s${r.code ? `, exit ${r.code}${hint}` : ""}${r.refusals.length ? `, ${r.refusals.length} guard refusal(s)` : ""})`);
    if (!pass) {
      for (const w of r.refusals.slice(0, 3)) console.log(`     ⛔ ${w}`);
      console.log(`     (its /tmp is ${r.tmp} on the host)`);
      const tail = fs.readFileSync(r.log, "utf8").trimEnd().split("\n").slice(-12);
      for (const l of tail) console.log(`     | ${l}`);
    }
  }
}));
const failed = results.filter((r) => r.code !== 0 || r.refusals.length);
console.log(`\n${results.length - failed.length}/${results.length} passed under the test guard${skipped.length ? ` (${skipped.length} skipped: ${skipped.map((f) => path.basename(f)).join(", ")})` : ""}${failed.length ? `; failed: ${failed.map((r) => path.basename(r.file)).join(", ")}` : ""}. Logs: ${runDir}`);
if (!keep && !failed.length) fs.rmSync(runDir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
