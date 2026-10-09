#!/usr/bin/env node
// gpu.mjs (J328): the GPU lease worker for a sandboxed world (docs: agent-config docs/sandbox/doorman-design.md, "GPU lease").
//
// DEVELOPER MODE: NOT AN NVIDIA-APPROVED ROUTE. NVIDIA's approved local sandbox is sbx (Docker Sandboxes), which has no GPU
// (sbx v0.47, microVMs). This worker is a plain Docker container with the GPU through the NVIDIA Container Toolkit (CDI),
// which shares the host kernel and driver. That is why the setting is called "developer" everywhere (config, review, README).
//
// What a lease is: one job, approved once by Angus, run in a fresh container that has
//   - only the job's files, COPIED in from a snapshot taken when the request was made (never G's shares, no bind mounts),
//   - no network at all (the image is pulled beforehand, never during a job),
//   - the GPU via CDI, all capabilities dropped, no-new-privileges, read-only root, a pids / memory / cpu cap,
//   - a hard time limit (killed at the limit, also by `timeout` inside the worker) and watchdogs for VRAM (nvidia-smi) and scratch
//     disk (polled ~every 0.4 s, killed when seen over budget: NOT hard caps; a very short spike can slip through).
// Outputs (/out) and the log are copied back; the container and its volumes are destroyed.
// CUDA cannot hard-cap VRAM on this GPU, so the watcher is the enforcement and the framework memory fractions in the
// job's environment are a courtesy. The display shares this GPU (it uses about 3.6 GiB of 8): a job is refused unless
// its budget plus a margin is free, and the budget is capped well under what is left.
//
// Config: ~/.config/hyprpi/worlds/<sandbox>.json   "gpu": "developer" | "off"   or   "gpu": {"mode": "developer", ...limits}
//   mode        developer (the default FOR NOW; should become "off" for new users before any public release) | off
//   max_seconds, max_vram_mib, image   optional tighter or other limits (hard caps below still apply)
//
// Usage (the relay imports this; the CLI is for tests):
//   gpu.mjs check [SANDBOX]                              mode, limits, GPU, CDI, docker, image
//   gpu.mjs run --sandbox S --dir DIR --script F [--runtime python|sh] [--time N] [--vram MIB] [--out DIR] [--no-gpu]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export const GLOBAL_DEFAULT = "developer"; // Angus 2026-10-09: "developer mode (default for now)"; make it "off" before a public release
export const MODES = ["developer", "off"];
export const LABEL = "developer mode: not an approved NVIDIA route (plain Docker + NVIDIA Container Toolkit; sbx has no GPU)";
export const HARD = {
  maxSeconds: 300, defaultSeconds: 60,
  maxVramMib: 3072, defaultVramMib: 1024, // "well under 4 GiB"; the display already holds ~3.6 GiB of 8
  marginMib: 1536,                        // free VRAM that must remain for the display beyond the budget
  files: 20, fileBytes: 1 << 20, totalBytes: 8 << 20,
  outFiles: 20, outFileBytes: 1 << 20, outTotalBytes: 8 << 20, logBytes: 64 * 1024,
  memory: "2g", cpus: "2", pids: "256", tmp: "128m", fileSize: 16 << 20, diskKiB: 32 * 1024, // total in /job + /out, watched
};
export const plain = (v, n = 300) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, "").slice(0, n); // job-controlled text: no terminal controls
export const RUNTIMES = { python: ["python", "-u"], sh: ["sh"] };
export const DEFAULT_IMAGE = "python:3.12-slim";
const CDI_DEVICE = "nvidia.com/gpu=0";

const HOME = os.homedir();
export const cfgDir = () => process.env.HYPRPI_GPU_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "hyprpi", "worlds");
const toInt = (v, d, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(n, hi)) : d; }; // a value below the floor is raised to it (never silently to the default)

// The gpu setting of one sandbox. Anything unreadable or unknown fails CLOSED (off) with a reason; a missing key is the default.
export function gpuConf(sandbox) {
  let w = {};
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(String(sandbox || ""))) return { mode: "off", reason: "bad sandbox name", limits: null };
  // Every worlds/*.json naming the sandbox is read (the pattern of research/mode.mjs, J325 review): exactly one is the setting,
  // none is the default, two or more (a stale copy, a backup) is ambiguous and fails closed to off, never "whichever sorts first".
  const hits = []; let names = [];
  try { names = fs.readdirSync(cfgDir()).filter((f) => f.endsWith(".json")).sort(); } catch (e) { if (e.code !== "ENOENT") return { mode: "off", reason: "worlds folder is unreadable", limits: null }; }
  for (const f of names) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(cfgDir(), f), "utf8")); } catch { if (f.slice(0, -5) === sandbox) return { mode: "off", reason: `worlds/${f} is unreadable`, limits: null }; continue; }
    if (j && typeof j === "object" && (typeof j.sandbox === "string" ? j.sandbox : f.slice(0, -5)) === sandbox) hits.push({ f, j });
  }
  if (hits.length > 1) return { mode: "off", reason: `ambiguous: ${hits.map((h) => h.f).join(", ")} all name ${sandbox}`, limits: null };
  if (hits.length) w = hits[0].j;
  const g = w.gpu === undefined ? GLOBAL_DEFAULT : w.gpu;
  const o = typeof g === "string" ? { mode: g } : g && typeof g === "object" && !Array.isArray(g) ? g : null;
  if (!o || !MODES.includes(o.mode)) return { mode: "off", reason: `gpu setting for ${sandbox} is not developer or off`, limits: null };
  const limits = {
    seconds: HARD.defaultSeconds, maxSeconds: toInt(o.max_seconds, HARD.maxSeconds, 5, HARD.maxSeconds),
    vramMib: HARD.defaultVramMib, maxVramMib: toInt(o.max_vram_mib, HARD.maxVramMib, 128, HARD.maxVramMib),
    image: typeof o.image === "string" && /^[a-z0-9][a-z0-9._\/:@-]{0,119}$/i.test(o.image) ? o.image : DEFAULT_IMAGE,
  };
  return { mode: o.mode, limits, ...(w.gpu === undefined ? { defaulted: true } : {}) };
}
export const refusal = (sandbox, c) => c.mode === "off"
  ? `GPU leases are off for ${sandbox} (gpu: off${c.reason ? `; ${c.reason}` : ""}). Nothing was asked of the owner.`
  : "";

// --- the job's files: a snapshot taken from the sandbox's workspace when the request is made ------------------------------
// The sandbox can still change its workspace afterwards, so what Angus reviews (names, sizes, sha256) is what runs.
export function snapshot(root, rels, dest) {
  const rootReal = fs.realpathSync(root);
  if (!Array.isArray(rels) || !rels.length) throw new Error("files is empty");
  if (rels.length > HARD.files) throw new Error(`at most ${HARD.files} files`);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const out = []; let total = 0;
  for (const raw of rels) {
    const rel = String(raw ?? "");
    if (!rel || rel.length > 200 || path.isAbsolute(rel) || /[\u0000-\u001f\u007f\\]/.test(rel)) throw new Error(`bad file path '${rel.slice(0, 60)}'`);
    const parts = rel.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || p.startsWith(".hyprpi"))) throw new Error(`bad file path '${rel}'`);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      const st = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (!st) throw new Error(`no such file '${rel}' in the sandbox's workspace`);
      if (st.isSymbolicLink()) throw new Error(`'${rel}' goes through a symlink`);
      if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`'${rel}': not a directory on the way`);
    }
    const fd = fs.openSync(cur, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error(`'${rel}' is not a regular file`);
      // the path may have been swapped for a symlink between the checks above and the open: what we hold must really sit under the root
      const real = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (real !== path.join(rootReal, rel)) throw new Error(`'${rel}' changed while it was read (not under the workspace)`);
      if (st.nlink !== 1) throw new Error(`'${rel}' is hard-linked`);
      if (st.size > HARD.fileBytes) throw new Error(`'${rel}' is over ${HARD.fileBytes} bytes`);
      total += st.size; if (total > HARD.totalBytes) throw new Error(`files total over ${HARD.totalBytes} bytes`);
      const buf = Buffer.alloc(st.size); fs.readSync(fd, buf, 0, st.size, 0);
      const to = path.join(dest, rel); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.writeFileSync(to, buf, { mode: 0o644, flag: "wx" });
      out.push({ path: rel, bytes: st.size, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
    } finally { fs.closeSync(fd); }
  }
  return out;
}

// --- the host side: GPU, CDI, docker ---------------------------------------------------------------------------------------
const run = async (cmd, args, o = {}) => { try { const r = await exec(cmd, args, { timeout: 30000, maxBuffer: 1 << 24, ...o }); return { ok: true, out: String(r.stdout || ""), err: String(r.stderr || "") }; } catch (e) { return { ok: false, out: String(e.stdout || ""), err: String(e.stderr || "") || String(e.message || ""), code: e.code }; } };
export async function gpuState() {
  const r = await run("nvidia-smi", ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"]);
  if (!r.ok) return null;
  const [name, used, total] = r.out.trim().split("\n")[0].split(",").map((s) => s.trim());
  return { name, usedMib: Number(used), totalMib: Number(total), freeMib: Number(total) - Number(used) };
}
export function gpuStateSync() {
  try { const [name, used, total] = execFileSync("nvidia-smi", ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 15000 }).trim().split("\n")[0].split(",").map((x) => x.trim()); return { name, usedMib: Number(used), totalMib: Number(total), freeMib: Number(total) - Number(used) }; }
  catch { return null; }
}
export const cdiSpec = () => ["/etc/cdi", "/var/run/cdi"].some((d) => { try { return fs.readdirSync(d).some((f) => /nvidia.*\.(ya?ml|json)$/.test(f)); } catch { return false; } });
export async function imagePresent(image) { return (await run("docker", ["image", "inspect", "--format", "{{.Id}}", image])).ok; }
export async function check(sandbox) {
  const c = gpuConf(sandbox), g = await gpuState();
  const d = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  return { sandbox, ...c, label: c.mode === "developer" ? LABEL : "", gpu: g, cdi: cdiSpec(), docker: d.ok ? d.out.trim() : null, image: c.limits ? { name: c.limits.image, present: await imagePresent(c.limits.image) } : null };
}
// The line for the host card's GPU section (the Doorman checks a request against it).
export function cardSection(sandbox) {
  const c = gpuConf(sandbox);
  if (c.mode === "off") return ["## GPU", "", `GPU leases are off for this sandbox (gpu: off). Nothing you can ask for here will run on the host's GPU.`, ""];
  const g = gpuStateSync(), L = c.limits;
  return ["## GPU", "",
    `Mode: ${c.mode}. This is ${LABEL}. There is no GPU inside your sandbox; a job can only run as a lease the owner approves one at a time.`,
    g ? `The host's GPU: ${g.name}, ${g.totalMib} MiB of VRAM, shared with the owner's display (it already uses part of it).` : "The host's GPU state is not known right now.",
    `Limits per job: up to ${L.maxSeconds} s (default ${HARD.defaultSeconds}), up to ${L.maxVramMib} MiB of VRAM (default ${HARD.defaultVramMib}), at most ${HARD.files} small files (${HARD.fileBytes >> 10} KiB each) copied from your workspace, no network, a plain ${L.image} image (Python 3 or sh; no pip installs).`,
    `Outputs: files the job writes into /out (up to ${HARD.outFiles} files) and its log come back to your read-only inbox as gpu-<id>-*.`, ""];
}

// --- run one approved lease ------------------------------------------------------------------------------------------------
// opts: { id, sandbox, dir (the snapshot), script, runtime, seconds, vramMib, outDir, noGpu (tests only) }
export async function runWorker(opts) {
  const c = gpuConf(opts.sandbox);
  if (c.mode === "off") return { status: "refused", reason: refusal(opts.sandbox, c) };
  const L = c.limits, id = String(opts.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 24) || crypto.randomBytes(3).toString("hex");
  const seconds = toInt(opts.seconds, Math.min(L.seconds, L.maxSeconds), 1, 1 << 30), vramMib = toInt(opts.vramMib, Math.min(HARD.defaultVramMib, L.maxVramMib), 64, 1 << 30); // (above the max = refused below, never silently lowered or raised)
  const interp = RUNTIMES[opts.runtime || "python"]; if (!interp) return { status: "refused", reason: "runtime must be python or sh" };
  const script = String(opts.script || ""); if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(script) || script.includes("..")) return { status: "refused", reason: "bad script path" };
  if (!fs.existsSync(path.join(opts.dir, script))) return { status: "refused", reason: `script '${script}' is not among the job's files` };
  const t0 = Date.now(), res = { id, status: "failed", seconds, vramMib, image: opts.image || L.image, mode: c.mode, noGpu: !!opts.noGpu };
  const cname = `hyprpi-gpu-${id}`;
  if (!opts.noGpu) {
    if (!cdiSpec()) return { ...res, status: "refused", reason: "the NVIDIA Container Toolkit's CDI spec (/etc/cdi/nvidia.yaml) isn't there yet" };
    const g = await gpuState();
    if (!g) return { ...res, status: "refused", reason: "nvidia-smi isn't answering" };
    res.gpu = g.name; res.freeBefore = g.freeMib;
    if (g.freeMib < vramMib + HARD.marginMib) return { ...res, status: "refused", reason: `not enough free VRAM: ${g.freeMib} MiB free, the job needs ${vramMib} MiB plus ${HARD.marginMib} MiB kept for the display` };
  }
  // the image Angus reviewed is the image that runs: the lease carries its name and immutable id; a changed id, a revoked mode or
  // tightened limits (checked above through gpuConf) refuse the run instead of substituting something else
  const image = opts.image && /^[a-z0-9][a-z0-9._\/:@-]{0,119}$/i.test(opts.image) ? opts.image : L.image;
  if (opts.seconds > L.maxSeconds || opts.vramMib > L.maxVramMib) return { ...res, status: "refused", reason: "the host's limits were tightened after this lease was approved; ask again" };
  const ins = await run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  if (!ins.ok) return { ...res, status: "refused", reason: `image ${image} isn't pulled (a job never pulls: run docker pull ${image} first)` };
  if (opts.imageId && ins.out.trim() !== opts.imageId) return { ...res, status: "refused", reason: `image ${image} changed since the lease was reviewed; ask again` };
  res.image = image;
  const frac = opts.noGpu ? 0 : Math.max(0.01, Math.min(1, vramMib / (res.freeBefore + 1)));
  const args = ["create", "--name", cname, "--label", "hyprpi.gpu=1", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", HARD.pids, "--memory", HARD.memory, "--memory-swap", HARD.memory, "--cpus", HARD.cpus, "--read-only", "--ulimit", `fsize=${HARD.fileSize}`, "--ulimit", "nofile=256", "--log-driver", "json-file", "--log-opt", "max-size=256k", "--log-opt", "max-file=1", "--tmpfs", `/tmp:rw,size=${HARD.tmp},mode=1777`,
    "-v", "/job", "-v", "/out", "-w", "/job",
    "-e", "HOME=/tmp", "-e", "JOB_OUT=/out", "-e", `GPU_VRAM_BUDGET_MIB=${vramMib}`, "-e", "TF_FORCE_GPU_ALLOW_GROWTH=true", "-e", "XLA_PYTHON_CLIENT_PREALLOCATE=false",
    "-e", `XLA_PYTHON_CLIENT_MEM_FRACTION=${frac.toFixed(3)}`, "-e", "PYTORCH_CUDA_ALLOC_CONF=max_split_size_mb:128", "-e", `PYTORCH_PER_PROCESS_MEMORY_FRACTION=${frac.toFixed(3)}`,
    ...(opts.noGpu ? [] : ["--device", CDI_DEVICE]), image, "timeout", "-s", "KILL", String(seconds + 2), ...interp, `/job/${script}`]; // the in-container timeout is an independent backstop: it still ends the job if the watcher dies
  const cleanup = async () => { await run("docker", ["rm", "-f", "-v", cname]); };
  try {
    let r = await run("docker", args); if (!r.ok) return { ...res, status: "refused", reason: `docker create failed: ${r.err.trim().split("\n").pop().slice(0, 200)}` };
    r = await run("docker", ["cp", `${opts.dir}/.`, `${cname}:/job`]); if (!r.ok) throw new Error(`copying the job in failed: ${r.err.trim().slice(0, 200)}`);
    r = await run("docker", ["start", cname]);
    if (!r.ok) { await new Promise((ok) => setTimeout(ok, 1500)); r = await run("docker", ["start", cname]); } // once more: right after another worker was killed the runtime can still be settling
    if (!r.ok) throw new Error(`docker start failed: ${(r.err + r.out).trim().slice(0, 300)}`);
    const t1 = Date.now(); let peak = 0, peakDisk = 0, tick = 0, duFail = 0, smiFail = 0, state = "running", exit = null;
    const base = opts.noGpu ? null : await gpuState();
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 400));
      const i = await run("docker", ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", cname]);
      const [running, code] = i.out.trim().split(" ");
      if (i.ok && running !== "true") { exit = Number(code); state = exit === 0 ? "ok" : exit === 137 && Date.now() - t1 >= seconds * 1000 ? "timeout" : "failed"; break; }
      if (Date.now() - t1 > seconds * 1000) { await run("docker", ["kill", cname]); state = "timeout"; break; }
      if (++tick) { // disk: /job and /out are plain volumes, so their total is watched like VRAM (and one file is capped by ulimit fsize)
        const du = await run("docker", ["exec", cname, "du", "-sk", "/job", "/out"]);
        if (!du.ok) duFail++; else duFail = 0;
        if (duFail >= 4 && (await run("docker", ["inspect", "--format", "{{.State.Running}}", cname])).out.trim() === "true") { await run("docker", ["kill", cname]); state = "disk"; res.reason = "disk use could not be measured"; break; } // fail closed
        const kib = du.out.split("\n").reduce((a, l) => a + (Number(l.split("\t")[0]) || 0), 0);
        peakDisk = Math.max(peakDisk, kib);
        if (kib > HARD.diskKiB) { await run("docker", ["kill", cname]); state = "disk"; break; }
      }
      if (!opts.noGpu) {
        const top = await run("docker", ["top", cname, "-eo", "pid"]);
        const pids = new Set(top.out.split("\n").slice(1).map((s) => s.trim()).filter(Boolean));
        const q = await run("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]);
        if (!q.ok) smiFail++; else smiFail = 0;
        if (smiFail >= 4) { await run("docker", ["kill", cname]); state = "vram"; res.reason = "VRAM could not be measured"; break; } // fail closed
        let used = 0, seen = false;
        for (const ln of q.out.split("\n")) { const [p, m] = ln.split(",").map((s) => s.trim()); if (pids.has(p)) { seen = true; used += Number(m) || 0; } }
        if (!seen && pids.size && base) { const g = await gpuState(); if (g && g.usedMib - base.usedMib > 0) used = g.usedMib - base.usedMib; } // per-process figures unavailable: whole-GPU growth
        peak = Math.max(peak, used);
        if (used > vramMib) { await run("docker", ["kill", cname]); state = "vram"; break; }
      }
    }
    Object.assign(res, { status: state, exit, peakVramMib: peak, peakDiskKiB: peakDisk, ranSeconds: Math.round((Date.now() - t1) / 100) / 10 });
    const lg = await run("docker", ["logs", cname], { maxBuffer: 1 << 22 });
    res.log = Buffer.from(lg.out + lg.err).subarray(0, HARD.logBytes).toString("utf8").replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, ""); // no terminal escapes from a job into a host terminal or an agent
    // outputs: copied to a staging dir, then only plain files within the caps are kept
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-out-"));
    try {
      await run("docker", ["cp", `${cname}:/out/.`, stage]);
      res.outputs = []; let total = 0;
      const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), n = pre ? `${pre}__${e.name}` : e.name; if (e.isDirectory()) walk(p, n); else if (e.isFile()) { const sz = fs.statSync(p).size; if (!res.outputs.some((o) => o.name === n) && res.outputs.length < HARD.outFiles && sz <= HARD.outFileBytes && total + sz <= HARD.outTotalBytes && /^[A-Za-z0-9._-]{1,100}$/.test(n)) { total += sz; res.outputs.push({ name: n, bytes: sz, from: p }); } else (res.skippedOutputs ||= []).push(plain(n, 80)); } } };
      walk(stage, "");
      if (opts.outDir) { fs.mkdirSync(opts.outDir, { recursive: true, mode: 0o700 }); for (const o of res.outputs) { fs.copyFileSync(o.from, path.join(opts.outDir, o.name)); } }
      for (const o of res.outputs) delete o.from;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    return res;
  } catch (e) { return { ...res, status: "failed", reason: String(e.message || e).slice(0, 300) }; }
  finally { await cleanup(); res.wallSeconds = Math.round((Date.now() - t0) / 100) / 10; }
}

// --- CLI (tests) ---------------------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === "check") console.log(JSON.stringify(await check(rest[0] || "world-g"), null, 1));
  else if (cmd === "run") {
    const r = await runWorker({ id: opt("id"), sandbox: opt("sandbox"), dir: opt("dir"), script: opt("script"), runtime: opt("runtime"), seconds: opt("time"), vramMib: opt("vram"), outDir: opt("out"), noGpu: rest.includes("--no-gpu") });
    console.log(JSON.stringify(r, null, 1)); process.exit(r.status === "ok" ? 0 : 1);
  } else { console.error("usage: gpu.mjs check [SANDBOX] | run --sandbox S --dir DIR --script F [--runtime python|sh] [--time N] [--vram MIB] [--out DIR] [--no-gpu]"); process.exit(2); }
}

// Containers of leases that are still around (a relay that died mid-job): removed. Called when the relay starts and stops.
export function reconcileSync() {
  try { const ids = execFileSync("docker", ["ps", "-aq", "--filter", "label=hyprpi.gpu=1"], { encoding: "utf8", timeout: 20000 }).split("\n").filter(Boolean); if (ids.length) execFileSync("docker", ["rm", "-f", "-v", ...ids], { timeout: 60000, stdio: "ignore" }); return ids.length; } catch { return 0; }
}
