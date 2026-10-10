// J425 (Angus: "what if the host agent isn't a claude agent"): which agent harness the bridge's per-job runner launches, per world, and
// what each one can really enforce of a job's limits (its tools and folders).
//
//   ~/.config/hyprpi/worlds/<w>.json  "gateway": { "host_runner": "claude-code" | "codex" | "pi" }        (default claude-code)
//                                     or { "host_runner": { "harness": "pi", "command": ["/path/to/pi"], "model": "provider/id" } }
// Angus sets it (research.mjs config-set host_runner=…, or the file); a sandbox can't propose it. An unknown harness or a bad command makes the
// runner unavailable for that world (fail closed): a free-form request is then refused at once, and a job already waiting is reported failed.
//
// Each adapter turns one job into { argv, env, cwd, files, gaps, dropped }: the prompt always goes on stdin; the bridge MCP server is the
// agent's only MCP server, bound to this job (its token reaches it through a private wrapper script, never argv or a log); no session is kept.
//   claude-code  `claude -p`: --strict-mcp-config, --tools = exactly the job's built-in tools (rules like Bash(git status) kept), --add-dir =
//                exactly its folders, dontAsk: tools and folders ENFORCED (as J387).
//   codex        `codex exec`: its OS sandbox. read-only, or workspace-write (only when the job grants a writing tool AND names folders) with
//                writes limited to those folders (/tmp excluded), network off; no user config, rules or connectors (apps); only the bridge MCP.
//                ENFORCED: writes, network. ADVISORY: reads (anywhere the user can read), the tool list (it always has a shell; only
//                read-only vs. write is enforced).
//   pi           `pi -p` with a private agent dir (only the bridge MCP, no extensions, skills or context files; auth and models shared
//                read-through) and --tools = the bridge tools + the job's tools mapped to pi's. ENFORCED: the tool list (bash is absent unless
//                granted). ADVISORY: folders (pi has no sandbox: a granted file or shell tool reaches anything the user can).
// A tool an adapter can't express (a rule-scoped tool on codex or pi, a tool pi lacks) is DROPPED, never widened (fail closed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { worldsFor } from "../research/mode.mjs";
// J380 (Pkgsort): the host's gateway-levels.json limits which harnesses a world may use (allowedHarness); a broken levels file allows none.
// Optional until J380 is on this branch: without levels.mjs every harness is allowed (the same as no levels file).
let LEVELS = null; try { LEVELS = await import("../research/levels.mjs"); } catch { /* not there yet */ }

export const HARNESSES = ["claude-code", "codex", "pi"];
export const BUILTIN = new Set(["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "Bash", "NotebookEdit", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite"]);
const TOOL_RE = /^([A-Za-z]{2,20})(\([^()\n,]{0,200}\))?$/;
export const toolOk = (t) => { const m = TOOL_RE.exec(String(t)); return !!m && BUILTIN.has(m[1]); };
export const BRIDGE = ["list_jobs", "show_job", "renew_job", "ask_owner", "report_job"]; // no claim/release: the runner holds the claim
const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
const PI_TOOL = { Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", Bash: "bash", Grep: "grep", Glob: "find", LS: "ls" };
const home = (p) => String(p).replace(/^~(?=\/|$)/, os.homedir());
export const cfgDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hyprpi");
const envCmd = () => { try { const a = JSON.parse(process.env.DOORMAN_RUNNER_CMD || "null"); if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string" && x)) return a; } catch { /* */ } return null; };
const DEFAULT_CMD = { "claude-code": ["claude"], codex: ["codex"], pi: ["pi"] };
export function which(cmd, PATH = process.env.PATH || "") {
  const ok = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
  if (String(cmd).includes("/")) return path.isAbsolute(cmd) && ok(cmd) ? cmd : "";
  for (const d of PATH.split(":").filter(Boolean)) { const f = path.join(d, cmd); if (ok(f)) return f; }
  return "";
}
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:+-]{0,99}$/;

// The runner choice for the world that serves `sandbox`: { harness, command, model, source } or { error }.
export function runnerChoice(sandbox, dir = cfgDir()) {
  // (J425Review #4) a worlds file that can't be read but may be this sandbox's (its name, or the sandbox named in its text) → unavailable,
  // never silently "no setting"
  try { for (const f of fs.readdirSync(path.join(dir, "worlds")).filter((x) => x.endsWith(".json"))) {
    let raw = ""; try { raw = fs.readFileSync(path.join(dir, "worlds", f), "utf8"); JSON.parse(raw); } catch (e) { if (f.slice(0, -5) === sandbox || raw.includes(JSON.stringify(sandbox))) return { error: `${f} can't be read (${String(e.message).slice(0, 60)})` }; } } } catch { /* no worlds folder */ }
  const hits = worldsFor(dir, sandbox);
  if (hits.length > 1) return { error: `ambiguous: ${hits.map((h) => h.f).join(", ")} all name ${sandbox}` };
  const v = hits[0]?.w?.gateway && typeof hits[0].w.gateway === "object" ? hits[0].w.gateway.host_runner : undefined;
  const o = v === undefined ? {} : typeof v === "string" ? { harness: v } : v && typeof v === "object" && !Array.isArray(v) ? v : null;
  if (!o) return { error: "host_runner must be a harness name or { harness, command, model }" };
  const harness = o.harness === undefined ? "claude-code" : o.harness;
  if (!HARNESSES.includes(harness)) return { error: `unknown host_runner harness ${JSON.stringify(String(harness)).slice(0, 40)} (${HARNESSES.join(", ")})` };
  let command = DEFAULT_CMD[harness];
  if (o.command !== undefined) {
    if (!Array.isArray(o.command) || !o.command.length || o.command.length > 8 || !o.command.every((x) => typeof x === "string" && x && !/[\0\n\r]/.test(x))) return { error: "host_runner.command must be a short argv array of strings" };
    command = o.command;
  } else if (harness === "claude-code" && envCmd()) command = envCmd(); // (J387 DOORMAN_RUNNER_CMD, kept for claude-code)
  if (LEVELS?.loadLevels && LEVELS?.allowedHarness) { const lv = LEVELS.loadLevels(dir); if (!LEVELS.allowedHarness(lv.levels, harness)) return { error: `the host's levels don't allow the ${harness} runner${lv.error ? ` (${String(lv.error).slice(0, 80)})` : ""}` }; }
  // (J425Review #2) the command must be runnable now, else the runner isn't counted (a draft is refused at once, not held for nobody)
  const exe = which(command[0]); if (!exe) return { error: `${harness} isn't installed or runnable here (${String(command[0]).slice(0, 60)} not found on PATH)` };
  const model = o.model !== undefined ? o.model : (process.env.DOORMAN_RUNNER_MODEL || "");
  if (model && (typeof model !== "string" || !MODEL_RE.test(model))) return { error: "host_runner.model must be a model id" };
  return { harness, command, model, source: v === undefined ? "default" : hits[0].f };
}

// What `harness` enforces for a job granting `tools` and `folders`: { granted, dropped, gaps } (gaps empty = all of it enforced).
export function limitsOf(harness, tools = [], folders = [], { readOnly = [], hidden = [] } = {}) {
  const base = (t) => t.replace(/\(.*$/, "");
  const valid = tools.filter(toolOk), dropped = tools.filter((t) => !toolOk(t)).map((t) => ({ tool: String(t).slice(0, 60), why: "not a known tool" }));
  // (J425Review #1, HIGH) Claude Code's --restricted / --add-dir confine its FILE tools; a granted Bash (even a scoped rule) runs outside them
  if (harness === "claude-code") return { granted: valid, dropped, gaps: valid.some((t) => base(t) === "Bash") ? ["folders aren't enforced for the shell: a granted Bash runs outside Claude Code's file limits"] : [] };
  const plain = [];
  for (const t of valid) {
    if (t.includes("(")) dropped.push({ tool: t, why: `${harness} can't limit a tool to a rule; not granted` });
    else if (harness === "pi" && !PI_TOOL[t]) dropped.push({ tool: t, why: "pi has no such tool; not granted" });
    else plain.push(t);
  }
  const gaps = [];
  if (harness === "codex") {
    gaps.push("reads aren't limited to the job's folders (codex's sandbox limits writes and the network, not reads)");
    gaps.push(plain.some((t) => WRITES.has(base(t))) && folders.length ? "its tool list isn't enforced: codex always has a shell; only writing inside the job's folders is" : "its tool list isn't enforced: codex always has a shell (read-only)");
  }
  if (harness === "codex" && hidden.length) gaps.push("the sandbox's hidden paths aren't hidden from it (codex can't deny reads)");
  if (harness === "pi" && plain.length) gaps.push("folders aren't enforced: pi has no sandbox, so a granted file or shell tool reaches anything the user can, read-only folders and hidden paths included");
  return { granted: plain, dropped, gaps };
}

// One line for the held item, the host card and `runner --install`: who will do it, and whether its limits are enforced.
export function runnerLabel(sandbox, { tools = [], folders = [], readOnly = [], hidden = [], dir = cfgDir() } = {}) {
  const c = runnerChoice(sandbox, dir);
  if (c.error) return { ok: false, label: `the per-job runner is unavailable for ${sandbox} (${c.error})`, advisory: false };
  const l = limitsOf(c.harness, tools, folders, { readOnly, hidden });
  return { ok: true, harness: c.harness, advisory: l.gaps.length > 0, gaps: l.gaps, dropped: l.dropped,
    label: `the per-job runner (on demand): ${c.harness}${l.gaps.length ? ` (limits advisory: ${l.gaps.join("; ")})` : " (limits enforced)"}` };
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// The private MCP wrapper: the bridge server with this job's env (token included); 0700 in the run's 0700 temp folder.
export function mcpWrapper(tmp, cli, env) {
  const f = path.join(tmp, "bridge-mcp");
  fs.writeFileSync(f, `#!/bin/sh\n${Object.entries(env).map(([k, v]) => `export ${k}=${sq(v)}`).join("\n")}\nexec ${sq(cli)} mcp\n`, { mode: 0o700 });
  return f;
}

// J428 (Linkpath) moved here from runner.mjs plan(), unchanged: what a job may touch. folders = approved, existing, still the same folder
// (folder_ids), no path the permission parser can't hold; ro / rw split; hidden = the sandbox's unreadable paths; deny = Claude Code
// rules for them. Every adapter starts from this scope.
export function jobScope(job) {
  const tools = (job.approved.tools || []).filter(toolOk);
  const dropped = (job.approved.tools || []).filter((t) => !toolOk(t));
  // (J428Review) a folder approved by identity (beyond the shares) must still be that folder, at that real path: else it's left out
  const ids = job.approved.folder_ids || {};
  const same = (d) => { if (!ids[d]) return true; try { const st = fs.statSync(d); return fs.realpathSync(d) === d && `${st.dev}:${st.ino}` === ids[d]; } catch { return false; } };
  // (J428Review HIGH) a path the permission-rule parser can't hold ( ) [ ] { } * ? , \ quotes): a read-only folder or hidden path like
  // that can't be fenced by a deny rule, so the folder itself, or the writable folder holding it, is left out entirely (fail closed)
  const UNSAFE = /[()[\]{}*?,\\"'`]/, under = (p, r) => p === r || p.startsWith(r + "/");
  const canon = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }; // (J428Check) compared as real paths
  const unsafeInside = [...(job.approved.read_only || []), ...(job.approved.hidden || [])].map(String).flatMap((d) => [d, canon(d)]).filter((d) => UNSAFE.test(d));
  const folders = (job.approved.folders || []).map(home).filter((d) => path.isAbsolute(d) && !UNSAFE.test(d) && !unsafeInside.some((u) => under(u, d)) && fs.existsSync(d) && fs.statSync(d).isDirectory() && same(d));
  // J428: folders approved read-only: Write/Edit denied there (Claude Code permission rules; "//" = an absolute path). A job with
  // no writable folder gets no Write/Edit at all.
  const ro = new Set((job.approved.read_only || []).map(home));
  const roDirs = folders.filter((d) => ro.has(d)), rwDirs = folders.filter((d) => !ro.has(d));
  const noWrite = folders.length > 0 && rwDirs.length === 0;
  const keep = (t) => !(noWrite && /^(Write|Edit|MultiEdit|NotebookEdit)\b/.test(t));
  // writes denied in the read-only folders (also read-only ones nested inside a writable share: protected projects), and the
  // sandbox's hidden (gitignored) paths stay unreadable (J428 v2: the same rights as the sandbox)
  const roAll = [...new Set((job.approved.read_only || []).map(home).filter((d) => path.isAbsolute(d) && !UNSAFE.test(d)))];
  const hidden = [...new Set((job.approved.hidden || []).map(String).filter((d) => path.isAbsolute(d)).flatMap((d) => [d, canon(d)]).filter((d) => !UNSAFE.test(d)))];
  const deny = [...roAll.flatMap((d) => ["Write", "Edit", "MultiEdit", "NotebookEdit"].map((t) => `${t}(/${d}/**)`)), ...hidden.flatMap((d) => [`Read(/${d})`, `Read(/${d}/**)`])];
  return { tools: tools.filter(keep), dropped, folders, ro, roDirs, rwDirs, roAll, hidden, deny };
}
// the claude-code argv (J387 + J428, unchanged): also what runner.mjs plan() returns, so test/bridge-scope.mjs checks this adapter
export function claudeArgv(sc, { cmd, mcpConfig, model = "" }) {
  const builtin = [...new Set(sc.tools.map((t) => t.replace(/\(.*$/, "")))];
  return [...cmd, "-p", "--output-format", "text", "--no-session-persistence", "--restricted",
    "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--tools", builtin.length ? builtin.join(",") : "",
    "--allowedTools", [...BRIDGE.map((t) => `mcp__doorman-bridge__${t}`), ...sc.tools].join(","),
    ...(sc.deny.length ? ["--disallowedTools", ...sc.deny] : []), // (one argument per rule: a path may hold a comma or a space)
    "--permission-mode", "dontAsk",
    ...sc.folders.flatMap((d) => ["--add-dir", d]), ...(model ? ["--model", model] : [])];
}

// argv / env / cwd for one job. job = the bridge view; ctx = { tmp, work, cli, mcpEnv, choice }. The prompt goes on stdin.
// Returns also folders, ro, toolsShown (as this harness names them), gaps (what it can't enforce), dropped.
export function adapterPlan(job, { tmp, work, cli, mcpEnv, choice }) {
  const sc = jobScope(job), cmd = choice.command, model = choice.model;
  const l = limitsOf(choice.harness, sc.tools, sc.folders, { readOnly: sc.roDirs, hidden: sc.hidden }), names = [...new Set(l.granted.map((t) => t.replace(/\(.*$/, "")))];
  const dropped = [...sc.dropped.map((t) => ({ tool: String(t).slice(0, 60), why: "not a known tool" })), ...l.dropped.filter((d) => d.why !== "not a known tool")];
  const common = { folders: sc.folders, ro: sc.ro, gaps: l.gaps, dropped, granted: l.granted };
  if (choice.harness === "claude-code") {
    const mcpConfig = path.join(tmp, "mcp.json");
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { "doorman-bridge": { command: cli, args: ["mcp"], env: mcpEnv } } }), { mode: 0o600 });
    return { ...common, cwd: sc.rwDirs[0] || work, toolsShown: names, argv: claudeArgv(sc, { cmd, mcpConfig, model }), env: {} };
  }
  const wrapper = mcpWrapper(tmp, cli, mcpEnv);
  if (choice.harness === "codex") {
    // writable only: the job's read-write folders (read-only ones are readable anyway: codex doesn't limit reads), and only when it
    // grants a writing tool; the cwd is writable under workspace-write, so it is a read-write folder or the private work folder
    // a read-and-write folder that holds a read-only one can't be fenced by codex's sandbox (it has no deny rule): read-only for codex
    const rw = sc.rwDirs.filter((d) => !sc.roAll.some((r) => r !== d && r.startsWith(d + "/")));
    const write = l.granted.some((t) => WRITES.has(t)) && rw.length > 0, cwd = write ? rw[0] : (sc.folders[0] || work); // (read-only sandbox: the cwd is not writable)
    return { ...common, cwd, toolsShown: write ? ["shell", "apply_patch (writes only in the read-and-write folders)"] : ["shell (read-only)"], env: {},
      argv: [...cmd, "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--color", "never",
        "-s", write ? "workspace-write" : "read-only", "-c", 'approval_policy="never"',
        "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "--disable", "apps", "-c", 'web_search="disabled"', "-c", `mcp_servers.doorman-bridge={command=${JSON.stringify(wrapper)},args=[],enabled_tools=${JSON.stringify(BRIDGE)},default_tools_approval_mode="approve"}`, // only the job's bridge tools, pre-approved (approval "never" would refuse them)
        "-C", cwd, ...(write ? rw.slice(1).flatMap((d) => ["--add-dir", d]) : []), ...(model ? ["-m", model] : []), "-"] };
  }
  // pi: a private agent dir: only the bridge MCP; auth and models are the user's (symlinked, so a token refresh writes through)
  const agent = path.join(tmp, "pi-agent"); fs.mkdirSync(agent, { mode: 0o700 });
  fs.writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { "doorman-bridge": { command: wrapper, args: [], exposure: "direct" } } }), { mode: 0o600 });
  const real = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  for (const f of ["auth.json", "models.json"]) if (fs.existsSync(path.join(real, f))) fs.symlinkSync(path.join(real, f), path.join(agent, f));
  let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(real, "settings.json"), "utf8")); } catch { /* */ }
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify(Object.fromEntries(["defaultProvider", "defaultModel", "defaultThinkingLevel"].filter((k) => k in s).map((k) => [k, s[k]]))), { mode: 0o600 });
  const piTools = [...BRIDGE.map((t) => `mcp__doorman_bridge__${t}`), ...new Set(names.map((t) => PI_TOOL[t]))];
  return { ...common, cwd: sc.rwDirs[0] || sc.folders[0] || work, toolsShown: [...new Set(names.map((t) => PI_TOOL[t]))], env: { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" },
    argv: [...cmd, "-p", "--no-session", "--no-skills", "--no-context-files", "--no-approve", "--tools", piTools.join(","), ...(model ? ["--model", model] : [])] };
}

// the tools / folders a world's bridge jobs get: its Doorman entry's "bridge" in sbx-relay.json
function bridgeOf(dir, sandbox) {
  try { const d = (JSON.parse(fs.readFileSync(process.env.HYPRPI_RELAY_CONF || path.join(dir, "sbx-relay.json"), "utf8")).sandboxes || []).find((x) => x && x.doorman_for === sandbox)?.bridge || {};
    return { tools: Array.isArray(d.tools) ? d.tools : [], folders: Array.isArray(d.folders) ? d.folders : [] }; } catch { return { tools: [], folders: [] }; }
}
// For `runner --install` / --status: every world's runner and what it enforces; advisory ones are marked with a warning.
export function describeWorlds(dir = cfgDir()) {
  let names = []; try { names = fs.readdirSync(path.join(dir, "worlds")).filter((f) => f.endsWith(".json")).sort(); } catch { /* none */ }
  const out = [];
  for (const f of names) {
    let w; try { w = JSON.parse(fs.readFileSync(path.join(dir, "worlds", f), "utf8")); } catch { continue; }
    if (!w || typeof w !== "object") continue;
    const sb = typeof w.sandbox === "string" ? w.sandbox : f.slice(0, -5), b = bridgeOf(dir, sb);
    const r = runnerLabel(sb, { dir, tools: b.tools, folders: b.folders }); // judged with the tools and folders this world's jobs get
    out.push(`${!r.ok ? "ERROR  " : r.advisory ? "WARNING" : "ok     "} ${sb}: ${r.ok ? r.label.replace(/^the per-job runner \(on demand\): /, "") : r.label}`);
  }
  return out;
}
