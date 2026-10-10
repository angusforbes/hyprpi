// J376: real, disposable Docker boundaries; no product or agent-guard stubs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const NAME = /^j376-[a-z0-9-]{1,64}$/;
const ID = /^(j376-[a-z0-9-]{1,64})--[0-9a-f]{6}$/;
const DOCKER = '/usr/bin/docker', NODE = '/usr/local/bin/node';
const MAX_OUTPUT = 1024 * 1024;
const PATH_ENV = new Set(['HYPRPI_RESEARCH_FAKE_DOORMAN', 'HYPRPI_RESEARCH_FAKE_READER', 'HYPRPI_SBX', 'HYPRPI_G_AGENT_OPENER', 'DUMP']);
const OTHER_ENV = new Set(['HYPRPI_HELD_VIA', 'HYPRPI_RESEARCH_DIRECT', 'DOORMAN_STATE', 'XDG_CACHE_HOME', 'DOORMAN_BRIDGE_AGENT', 'KEEP', 'TMPDIR', 'PI_OFFLINE']);
const fail = message => { throw new Error(`gateway rig: ${message}`); };
const below = (base, p) => p !== base && p.startsWith(base + path.sep);
function execution(file, args, env, opts = {}) {
  const r = spawnSync(file, args, { env, cwd: opts.cwd, input: opts.input, encoding: 'utf8', timeout: opts.timeout ?? 30000,
    maxBuffer: MAX_OUTPUT, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal, error: r.error };
}
function must(r, what) {
  if (r.error || r.status !== 0) fail(`${what} failed (${r.status ?? r.error?.code}): ${r.stderr || r.error?.message || r.stdout}`);
  return r;
}
function plainTree(base, { sockets = false } = {}) {
  let n = 0;
  const visit = p => {
    if (++n > 10000) fail('fixture tree exceeds validation limit');
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) fail(`symlink refused: ${p}`);
    if (st.uid !== process.getuid()) fail(`unowned fixture path: ${p}`);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) { try { visit(path.join(p, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    else if (st.isFile()) { if (st.nlink !== 1) fail(`hard link refused: ${p}`); }
    else if (!(sockets && st.isSocket())) fail(`special file refused: ${p}`);
  };
  visit(base);
}

// Testable transport-race policy: an empty inspection does not settle an uncertain create.
export function settleLateCreates(names, { inspect, remove, timeout = 60000, now = Date.now,
  wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }) {
  const deadline = now() + timeout;
  for (const name of [...names]) {
    for (;;) {
      const info = inspect(name);
      if (info) { remove(info, name); names.delete(name); break; }
      if (now() >= deadline) fail('cleanup unconfirmed: Docker creation may still finish for ' + name);
      wait(100);
    }
  }
}

export async function createRig(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['repoRoot', 'image'].includes(k))) fail('only repoRoot and cached image may configure a rig');
  const { repoRoot, image = 'pi-sandbox' } = options;
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) fail('repoRoot must be an absolute authorized checkout');
  const repo = fs.realpathSync(repoRoot), harness = fs.realpathSync(path.join(os.homedir(), 'Harness'));
  if (repo !== repoRoot || !below(harness, repo)) fail('repoRoot must resolve inside ~/Harness without aliases');
  const git = execution('/usr/bin/git', ['-C', repo, 'rev-parse', '--show-toplevel'], { PATH: '/usr/bin:/bin', HOME: '/nonexistent' });
  if (git.status !== 0 || git.stdout.trim() !== repo) fail('repoRoot is not a git worktree root');
  for (const f of ['docker/sbx-relay.mjs', 'docker/research/research.mjs', 'test/gateway/worker.mjs', 'test/gateway/owner-pty.py']) {
    const p = path.join(repo, f);
    if (fs.realpathSync(p) !== p || !fs.statSync(p).isFile()) fail(`missing or aliased source ${f}`);
  }
  if (typeof image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,200}$/.test(image)) fail('unsafe cached image name');
  const tmp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(tmp, 'gateway-e2e-'));
  let allocated;
  try {
  allocated = fs.lstatSync(root);
  fs.chmodSync(root, 0o700);
  const rootStat = allocated, nonce = crypto.randomBytes(8).toString('hex');
  const sandbox = `j376-sandbox-${nonce}`, doorman = `j376-doorman-${nonce}`, reader = `j376-reader-${nonce}`;
  const workerName = `j376-worker-${nonce}`, owners = new Map(), windows = new Map(), uncertainCreates = new Set();
  let closed = false, workerId = '', workerAttempted = false, imageId = '';
  const marker = JSON.stringify({ root, nonce, uid: process.getuid(), ino: rootStat.ino });
  fs.writeFileSync(path.join(root, '.j376-owned'), marker, { flag: 'wx', mode: 0o600 });
  const P = (...parts) => {
    if (parts.some(s => typeof s !== 'string' || s.includes('\0'))) fail('invalid scratch path');
    const p = path.resolve(root, ...parts);
    if (p !== root && !below(root, p)) fail('path escapes scratch root');
    return p;
  };
  for (const d of ['ws', 'inbox', 'dws', 'dinbox', 'config/hyprpi/worlds', 'state/hyprpi/sbx-relay/pending',
    'state/hyprpi/sbx-relay/decisions', 'dstate', 'rstate', 'home', 'run', 'edits', 'bin', 'cards', 'cache']) fs.mkdirSync(P(d), { recursive: true, mode: 0o700 });
  for (const d of ['ws', 'dws']) fs.mkdirSync(P(d, '.hyprpi-dropbox', 'outbox'), { recursive: true });
  const inert = '#!/bin/sh\necho "J376 isolated fixture refuses $0" >&2\nexit 97\n';
  for (const name of ['busctl', 'notify-send', 'gdbus', 'hyprctl', 'systemd-run', 'systemctl', 'sbx', 'hyprpi', 'xdg-open']) fs.writeFileSync(P('bin', name), inert, { mode: 0o700 });
  // Product relay startup AND shutdown reconcile global GPU container labels.
  // This stub must exist before running any product process. Lifecycle uses the
  // absolute real Docker above, never this product PATH or an inherited context.
  fs.writeFileSync(P('bin/docker'), '#!/bin/sh\nif [ "$1" = ps ]; then exit 0; fi\necho "J376 isolated fixture refuses Docker mutation" >&2\nexit 97\n', { mode: 0o700 });
  const env = { HOME: P('home'), XDG_CONFIG_HOME: P('config'), XDG_STATE_HOME: P('state'), XDG_RUNTIME_DIR: P('run'),
    HYPRPI_STATE: P('dstate'), HYPRPI_SOCKET: P('d.sock'), HYPRPI_RESEARCH_STATE: P('rstate'), HYPRPI_TEST: '1',
    HYPRPI_NO_ADOPT: '1', HYPRPI_NO_ENSURE: '1', HYPRPI_RESEARCH_DIRECT: '1',
    PATH: `${P('bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8' };
  const baseline = { ...env };
  const json = (f, o) => fs.writeFileSync(P(f), JSON.stringify(o, null, 2) + '\n', { mode: 0o600 });
  json('config/hyprpi/sbx-relay.json', { sandboxes: [
    { name: sandbox, workspace: P('ws'), inbox: P('inbox'), workspace_num: 61, agent_id: `sbx-${sandbox}` },
    { name: doorman, workspace: P('dws'), inbox: P('dinbox'), workspace_num: 61, agent_id: `sbx-${doorman}`, doorman_for: sandbox, reports_to: 'Thoughts-A' },
  ] });
  json(`config/hyprpi/worlds/${sandbox}.json`, { sandbox, workspace: P('ws'), inbox: P('inbox'), card: P('cards'), task: 'Study public gateway fixture sources', gateway: { mode: 'doorman-safe', level: 'safe' } });
  json('config/hyprpi/research.json', { sandboxes: { [sandbox]: { doorman, reader, reports_to: 'Thoughts-A' } } });
  const assertRoot = () => {
    if (closed) fail('rig is closed');
    if (path.dirname(root) !== tmp || !/^gateway-e2e-[A-Za-z0-9_-]+$/.test(path.basename(root)) || fs.realpathSync(root) !== root) fail('unsafe scratch root');
    const st = fs.lstatSync(root);
    if (!st.isDirectory() || st.uid !== process.getuid() || st.ino !== rootStat.ino || st.dev !== rootStat.dev) fail('owned root changed');
    const mf = P('.j376-owned'), ms = fs.lstatSync(mf);
    if (!ms.isFile() || ms.isSymbolicLink() || ms.nlink !== 1 || ms.uid !== process.getuid() || fs.readFileSync(mf, 'utf8') !== marker) fail('owned root marker changed');
    // Include directories added by parent fixtures (projects/card/window/
    // artifacts), not just the initial skeleton. The sole top-level socket
    // is the private daemon endpoint; it is never mounted into a container.
    for (const name of fs.readdirSync(root)) {
      const p = P(name);
      if (name === 'd.sock') {
        const sock = fs.lstatSync(p);
        if (!sock.isSocket() || sock.uid !== process.getuid()) fail('private daemon endpoint is not an owned socket');
      } else plainTree(p, { sockets: ['dstate', 'run'].includes(name) });
    }
  };
  const scratchPath = (value, { file = false, base = root, exists = true } = {}) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !below(base, value) || path.resolve(value) !== value) fail(`not a scratch path: ${String(value)}`);
    let p = value;
    while (p !== root) {
      let st; try { st = fs.lstatSync(p); } catch (e) { if (exists || e.code !== 'ENOENT') throw e; }
      if (st?.isSymbolicLink()) fail(`symlink refused: ${p}`);
      p = path.dirname(p);
    }
    if (exists && fs.realpathSync(value) !== value) fail('scratch path realpath mismatch');
    if (file) { const st = fs.statSync(value); if (!st.isFile() || st.nlink !== 1) fail('not a plain scratch file'); }
    return value;
  };
  const fixtureName = s => { if (typeof s !== 'string' || !NAME.test(s)) fail(`not a fixture sandbox name: ${String(s)}`); return s; };
  const validateConfig = () => {
    const cfgDir = P('config/hyprpi'), entries = JSON.parse(fs.readFileSync(path.join(cfgDir, 'sbx-relay.json'), 'utf8')).sandboxes;
    if (!Array.isArray(entries) || entries.length !== 2) fail('fixture relay must contain exactly two sandboxes');
    for (const e of entries) {
      fixtureName(e.name);
      if (![sandbox, doorman].includes(e.name)) fail('relay names must belong to this rig');
      const role = e.name === sandbox ? ['ws', 'inbox'] : ['dws', 'dinbox'];
      if (scratchPath(e.workspace) !== P(role[0]) || scratchPath(e.inbox) !== P(role[1])) fail('relay workspace/inbox must be fixed fixture mounts');
      if (e.doorman_for !== undefined && e.doorman_for !== sandbox) fail('unsafe doorman_for');
    }
    if (new Set(entries.map(e => e.name)).size !== 2) fail('duplicate relay fixture name');
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (['workspace', 'inbox', 'card', 'key_file'].includes(k) && v) scratchPath(v);
        if (['sandbox', 'doorman_for', 'reader'].includes(k) && typeof v === 'string') fixtureName(v);
        if (k === 'doorman' && typeof v === 'string') fixtureName(v);
        if (k === 'folders' && Array.isArray(v)) v.forEach(p => scratchPath(p));
        if (typeof v === 'object') walk(v);
      }
    };
    walk(entries);
    for (const f of fs.readdirSync(path.join(cfgDir, 'worlds')).filter(f => f.endsWith('.json'))) {
      const w = JSON.parse(fs.readFileSync(path.join(cfgDir, 'worlds', f), 'utf8'));
      fixtureName(w.sandbox ?? f.slice(0, -5)); walk(w);
      for (const item of Array.isArray(w.projects) ? w.projects : []) {
        const name = typeof item === 'string' ? item.split(':')[0] : item?.name;
        if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name) || ['.', '..'].includes(name)) fail('world projects must be plain fixture project names');
      }
      for (const share of w.shares || []) {
        if (typeof share === 'string') scratchPath(share); else { scratchPath(share.host || share.path); if (share.at) scratchPath(share.at, { exists: false }); }
      }
    }
    const globalFile = path.join(cfgDir, 'config.json');
    if (fs.existsSync(globalFile)) {
      const g = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
      if (g.cwd) scratchPath(g.cwd);
      if (g.projectFolders !== undefined && !Array.isArray(g.projectFolders)) fail('projectFolders must be a fixture array');
      for (const p of g.projectFolders || []) scratchPath(p);
      if (g.roleFolders !== undefined && (!g.roleFolders || typeof g.roleFolders !== 'object' || Array.isArray(g.roleFolders))) fail('roleFolders must be a fixture object');
      for (const p of Object.values(g.roleFolders || {})) scratchPath(p);
      if (g.screenshotsDir) scratchPath(g.screenshotsDir);
    }
    const research = JSON.parse(fs.readFileSync(path.join(cfgDir, 'research.json'), 'utf8'));
    if (research.sandboxes) for (const [n, settings] of Object.entries(research.sandboxes)) { fixtureName(n); walk(settings); }
  };
  const safeEnv = (extra = {}) => {
    const e = { ...env };
    for (const [k, v] of Object.entries(extra)) {
      if (!PATH_ENV.has(k) && !OTHER_ENV.has(k)) fail(`environment override not permitted: ${k}`);
      e[k] = v;
    }
    for (const [k, v] of Object.entries(baseline)) if (e[k] !== v) fail(`protected environment changed: ${k}`);
    for (const [k, v] of Object.entries(e)) {
      if (!(k in baseline) && !PATH_ENV.has(k) && !OTHER_ENV.has(k)) fail(`unexpected environment variable: ${k}`);
      if (typeof v !== 'string' || v.includes('\0')) fail(`invalid environment value: ${k}`);
      if (PATH_ENV.has(k)) scratchPath(v, k === 'DUMP' ? { exists: false } : { file: true });
      if (k === 'DOORMAN_STATE' && v !== P('state/hyprpi/sbx-relay')) fail('DOORMAN_STATE must be this rig relay state');
      if (k === 'XDG_CACHE_HOME' && v !== P('cache')) fail('XDG_CACHE_HOME must be this rig cache');
      if (k === 'DOORMAN_BRIDGE_AGENT' && !/^fixture-[A-Za-z0-9_.-]{1,64}$/.test(v)) fail('not a fixture bridge agent');
      if (k === 'KEEP' && !['0', '1'].includes(v)) fail('invalid KEEP');
      if (k === 'PI_OFFLINE' && v !== '1') fail('PI_OFFLINE fixture must stay offline');
      if (k === 'TMPDIR') scratchPath(v);
      if (k === 'HYPRPI_HELD_VIA' && !['panel', 'room panel', 'doorman window', 'terminal'].includes(v)) fail('invalid decision route');
    }
    return e;
  };
  const dockerTrace = [];
  const docker = (args, opts = {}) => {
    const started = Date.now(), timeoutMs = opts.timeout ?? 30000;
    const result = execution(DOCKER, args, baseline, { timeout: timeoutMs, ...opts });
    const name = args.indexOf('--name');
    dockerTrace.push({ started: new Date(started).toISOString(), elapsedMs: Date.now() - started, operation: args.slice(0, 2).join(' '),
      target: name >= 0 ? args[name + 1] : args.find(a => NAME.test(a) || /^[a-f0-9]{64}$/.test(a)) || '', timeoutMs,
      status: result.status, signal: result.signal, error: result.error?.code || '', stderr: result.stderr.slice(-1000) });
    return result;
  };
  const prerequisites = () => {
    assertRoot(); validateConfig(); safeEnv();
    if (imageId) return;
    must(docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 15000 }), 'Docker daemon prerequisite');
    const info = JSON.parse(must(docker(['image', 'inspect', image], { timeout: 15000 }), `cached image ${image} (no pulls)`).stdout)[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(info?.Id)) fail('cached image did not return an immutable ID');
    if (Object.keys(info.Config?.Volumes || {}).length) fail('fixture image cannot declare anonymous volumes');
    if ((info.Config?.Env || []).some(v => /^(?:.*(?:TOKEN|SECRET|PASSWORD|API_KEY)|DOCKER_HOST)=/i.test(v))) fail('fixture image declares secret-looking environment');
    imageId = info.Id;
  };
  const ownedStart = (args, name, what) => {
    // A measured CREATE completed at the host's 30-second NVMe completion poll, just beyond our old deadline.
    // Give a SINGLE create 90s, not another attempt: it must succeed, then all ID/label/mount checks still run.
    const result = docker(args, { timeout: 90000 });
    // A killed client does not cancel Docker's POST. A missing name is NOT cleanup proof until this creation is observed.
    if (result.error || result.status !== 0) uncertainCreates.add(name);
    return must(result, what);
  };
  const removeContainer = (target, expectedName) => {
    if (!NAME.test(expectedName) || !(/^[a-f0-9]{64}$/.test(target) || target === expectedName)) fail('unsafe cleanup target');
    const deadline = Date.now() + 60000;
    let observed = false;
    for (;;) {
      const r = docker(['container', 'inspect', target], { timeout: 5000 });
      if (r.error?.code === 'ETIMEDOUT' && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); continue; }
      if (r.status !== 0 && !r.error && /No such (?:object|container)/i.test(r.stderr)) { if (observed) uncertainCreates.delete(expectedName); return; }
      const info = JSON.parse(must(r, 'cleanup ownership inspection').stdout)[0];
      if (!/^[a-f0-9]{64}$/.test(info?.Id) || info.Name !== '/' + expectedName || info.Config?.Labels?.[windows.has(expectedName) ? 'hyprpi.gateway-e2e.owner' : 'hyprpi.j376'] !== (windows.get(expectedName) || nonce)) fail('refusing to remove container without this rig ownership label/name');
      if (/^[a-f0-9]{64}$/.test(target) && info.Id !== target) fail('cleanup container ID mismatch');
      observed = true;
      const removed = docker(['rm', '-f', '-v', info.Id], { timeout: 5000 });
      if (!removed.error && removed.status === 0) { uncertainCreates.delete(expectedName); return; }
      if (Date.now() >= deadline || (removed.error?.code !== 'ETIMEDOUT' && !/already in progress|No such (?:object|container)/i.test(removed.stderr))) must(removed, 'exact owned container cleanup');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  };
  const mount = (p, ro = false) => {
    if (p.includes(',') || p.includes('\n')) fail('unsafe mount path');
    return ['--mount', `type=bind,src=${p},dst=${p}${ro ? ',readonly' : ''}`];
  };
  const hardened = name => ['--pull', 'never', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`, '--pids-limit', '64',
    '--memory', '256m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,mode=1777', '--label', `hyprpi.j376=${nonce}`];
  const workerMounts = () => ['ws', 'dws'].map(d => ({ path: P(d), rw: true })).concat(['inbox', 'dinbox'].map(d => ({ path: P(d), rw: false })), { path: repo, rw: false });
  const inspectBoundary = (cid, expected) => {
    const info = JSON.parse(must(docker(['inspect', cid]), 'container boundary inspection').stdout)[0];
    if (info.HostConfig.NetworkMode !== 'none' || !info.HostConfig.ReadonlyRootfs || info.HostConfig.Privileged || info.HostConfig.PidMode || info.HostConfig.IpcMode === 'host') fail('container isolation flags differ from policy');
    if (!info.HostConfig.CapDrop?.includes('ALL') || !info.HostConfig.SecurityOpt?.includes('no-new-privileges')) fail('container capability boundary differs from policy');
    const binds = info.Mounts.filter(m => m.Type === 'bind');
    if (binds.length !== expected.length || binds.some(m => !expected.some(x => x.path === m.Source && x.path === m.Destination && x.rw === m.RW))) fail('unexpected container bind mounts');
    if (info.Config.User !== `${process.getuid()}:${process.getgid()}`) fail('container UID differs from fixture owner');
    return { container: cid, network: info.HostConfig.NetworkMode, readonlyRoot: info.HostConfig.ReadonlyRootfs,
      mounts: binds.map(m => ({ source: m.Source, destination: m.Destination, readOnly: !m.RW })) };
  };
  const proof = async () => {
    assertRoot(); validateConfig(); safeEnv();
    if (!workerId) fail('worker is not started');
    const info = inspectBoundary(workerId, workerMounts());
    const hidden = [P('state'), P('config'), P('dstate'), P('rstate'), P('d.sock'), path.join(os.homedir(), '.local/state/hyprpi'), path.join(os.homedir(), '.config/hyprpi'), '/run/user/' + process.getuid() + '/hyprpi.sock', '/var/run/docker.sock'];
    const probe = `const fs=require('fs');const hidden=${JSON.stringify(hidden)},inboxes=${JSON.stringify([P('inbox'), P('dinbox')])};for(const p of hidden)if(fs.existsSync(p))throw Error('host path visible '+p);const denied=[];for(const p of inboxes){try{fs.writeFileSync(p+'/.j376-write-probe','x');throw Error('readonly inbox writable')}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e;denied.push({path:p,code:e.code})}}console.log(JSON.stringify({hidden,writeRefusals:denied}))`;
    const checked = JSON.parse(must(docker(['exec', workerId, NODE, '-e', probe]), 'worker actual read/write boundary probe').stdout);
    return { ok: true, ...info, ...checked, image: imageId };
  };
  const start = async () => {
    prerequisites();
    if (workerId) fail('worker already started');
    const mounts = workerMounts().flatMap(m => mount(m.path, !m.rw));
    workerAttempted = true;
    const r = ownedStart(['run', '-d', ...hardened(workerName), ...mounts, '--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
      '--entrypoint', NODE, imageId, path.join(repo, 'test/gateway/worker.mjs'), 'idle', root], workerName, 'worker start');
    workerId = r.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(workerId)) fail('worker did not return an exact container ID');
    await proof();
    return rig;
  };
  const request = async (role, req) => {
    assertRoot(); validateConfig(); safeEnv();
    if (!workerId) fail('worker is not started');
    if (role === sandbox || role === 'worker') role = 'sandbox';
    if (role === doorman) role = 'doorman';
    if (!['sandbox', 'doorman'].includes(role)) fail('unknown fixture role');
    const raw = JSON.stringify(req);
    if (!raw || Buffer.byteLength(raw) > 16384) fail('request exceeds fixture limit');
    const r = must(docker(['exec', workerId, NODE, path.join(repo, 'test/gateway/worker.mjs'), 'request', root, role, Buffer.from(raw).toString('base64')]), 'worker outbox request');
    const filename = r.stdout.trim();
    if (!/^(?:status|req)-[0-9]+-[a-f0-9]{12}\.json$/.test(filename)) fail('worker returned invalid filename');
    return filename;
  };
  const validateOwnerArgs = args => {
    if (!Array.isArray(args) || args.length > 12 || args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 40000)) fail('invalid owner arguments');
    if (args[0] === 'config-set') {
      if (args.length < 4 || args[1] !== '--sandbox' || ![sandbox, doorman].includes(args[2])) fail('config-set needs this rig sandbox explicitly');
      for (const a of args.slice(3)) {
        if (a.startsWith('--') || !/^[a-z_.]+=/.test(a)) fail('config-set only permits key=value');
        if (a.startsWith('search.key_file=')) scratchPath(a.slice('search.key_file='.length), { file: true, base: P('config') });
      }
      return;
    }
    if (!['approve', 'deny', 'return', 'allow', 'answer'].includes(args[0])) fail('owner operation not permitted');
    const match = ID.exec(args[1] || '');
    if (!match || ![sandbox, doorman].includes(match[1])) fail('unsafe or foreign pending ID');
    const pending = scratchPath(P('state/hyprpi/sbx-relay/pending', args[1] + '.json'), { file: true });
    const rec = JSON.parse(fs.readFileSync(pending, 'utf8'));
    if (rec.id !== args[1] || rec.sandbox !== match[1]) fail('pending record must match fixture ID and sandbox');
    const rest = args.slice(2);
    if (args[0] === 'allow') {
      if (rest.length > 3 || rest.some(s => !/^[A-Za-z0-9 ]{1,40}$/.test(s))) fail('invalid fixture duration');
    } else {
      const flag = { approve: '--edit-file', deny: '--reason', return: '--note', answer: '--note' }[args[0]];
      if (args[0] === 'answer' && (!rec.hostJob || rest.length !== 2 || !rest[1].trim() || rest[1].length > 500 || /[\x00-\x1f\x7f]/.test(rest[1]))) fail('answer requires a fixture host-job question and plain nonempty note');
      if (rest.length && (rest.length !== 2 || rest[0] !== flag)) fail('owner option not permitted');
      if (rest[0] === '--edit-file') scratchPath(rest[1], { file: true, base: P('edits') });
    }
  };
  const owner = async (args, opts = {}) => {
    if (Object.keys(opts).some(k => !['agent', 'pipe'].includes(k))) fail('owner environment, executable and mount overrides forbidden');
    const { agent = false, pipe = false } = opts;
    if (typeof agent !== 'boolean' || typeof pipe !== 'boolean') fail('invalid owner mode');
    assertRoot(); validateConfig(); safeEnv(); validateOwnerArgs(args); prerequisites();
    const name = `j376-owner-${nonce}-${crypto.randomBytes(4).toString('hex')}`;
    const expected = ['config', 'state', 'rstate', 'edits'].map(d => ({ path: P(d), rw: true }))
      .concat(['bin', 'home'].map(d => ({ path: P(d), rw: false })), { path: repo, rw: false });
    owners.set(name, '');
    try {
      const r = ownedStart(['create', ...hardened(name), ...expected.flatMap(m => mount(m.path, !m.rw)),
        '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'HOME=/tmp', '--entrypoint', '/usr/bin/python3',
        imageId, path.join(repo, 'test/gateway/owner-pty.py'), JSON.stringify({ root, repo, home: os.homedir(), args, agent, pipe })], name, 'decision container creation');
      const cid = r.stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(cid)) fail('decision container did not return an exact ID');
      owners.set(name, cid);
      inspectBoundary(cid, expected);
      const run = docker(['start', '-a', cid], { timeout: 35000 });
      if (run.error) must(run, 'decision execution');
      let result; try { result = JSON.parse(run.stdout.trim()); } catch { fail(`decision helper did not return JSON: ${run.stderr || run.stdout}`); }
      if (!Number.isInteger(result.status) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') fail('invalid decision execution result');
      return result;
    } finally {
      const target = owners.get(name) || name;
      removeContainer(target, name);
      owners.delete(name);
    }
  };
  const cli = async (script, args = [], opts = {}) => {
    assertRoot(); validateConfig();
    if (Object.keys(opts).some(k => !['env', 'input', 'timeout', 'cwd'].includes(k))) fail('unsupported isolated CLI option');
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) fail('invalid CLI arguments');
    const p = path.resolve(repo, script);
    if (!below(repo, p) || fs.realpathSync(p) !== p || !fs.statSync(p).isFile()) fail('CLI script must be a plain worktree file');
    const e = safeEnv(opts.env), cwd = opts.cwd === undefined ? P('home') : scratchPath(opts.cwd);
    const timeoutLimit = p === path.join(repo, 'docker/doorman/test-stateless.mjs') ? 450000 : 120000;
    if (opts.timeout !== undefined && (!Number.isInteger(opts.timeout) || opts.timeout < 1 || opts.timeout > timeoutLimit)) fail('invalid CLI timeout');
    const isJS = /\.(?:mjs|cjs|js)$/.test(p);
    if (!isJS && (!fs.readFileSync(p, 'utf8').startsWith('#!') || !(fs.statSync(p).mode & 0o111))) fail('non-JS fixture CLI must be an executable shebang launcher');
    return execution(isJS ? process.execPath : p, isJS ? [p, ...args] : args, e, { ...opts, cwd });
  };
  const close = async () => {
    if (closed) return;
    const errors = [];
    for (const [n, id] of owners) {
      try { removeContainer(id || n, n); owners.delete(n); } catch (e) { errors.push(e.message); }
    }
    if (workerAttempted) {
      try { removeContainer(workerId || workerName, workerName); workerId = ''; workerAttempted = false; } catch (e) { errors.push(e.message); }
    }
    for (const name of windows.keys()) try { removeContainer(name, name); } catch (error) { errors.push(error.message); }
    if (errors.length) fail('cleanup refused scratch removal: ' + errors.join('; '));
    settleLateCreates(uncertainCreates, {
      inspect: name => {
        const result = docker(['container', 'inspect', name], { timeout: 5000 });
        if (result.error?.code === 'ETIMEDOUT' || (result.status !== 0 && /No such (?:object|container)/i.test(result.stderr))) return null;
        const info = JSON.parse(must(result, 'late-create ownership inspection').stdout)[0];
        if (!/^[a-f0-9]{64}$/.test(info?.Id) || info.Name !== '/' + name || info.Config?.Labels?.[windows.has(name) ? 'hyprpi.gateway-e2e.owner' : 'hyprpi.j376'] !== (windows.get(name) || nonce)) fail('late-create container ownership mismatch');
        return info;
      },
      remove: (info, name) => removeContainer(info.Id, name),
    });
    const remaining = must(docker(['ps', '-aq', '--filter', `label=hyprpi.j376=${nonce}`]), 'exact-label cleanup verification').stdout.trim();
    if (remaining) fail('cleanup still has containers with this exact ownership label');
    for (const value of windows.values()) {
      if (must(docker(['ps', '-aq', '--filter', `label=hyprpi.gateway-e2e.owner=${value}`]), 'window cleanup verification').stdout.trim()) fail('window container remains with exact ownership label');
    }
    // Parent stops its isolated daemon/relay children first. No broad prune.
    const st = fs.lstatSync(root);
    if (fs.realpathSync(root) !== root || st.ino !== rootStat.ino || st.dev !== rootStat.dev || fs.readFileSync(P('.j376-owned'), 'utf8') !== marker) fail('cleanup ownership mismatch');
    fs.rmSync(root, { recursive: true, force: true }); closed = true;
  };
  const rig = { root, env, sandbox, doorman, reader, P, start, proof, request, owner, cli, close,
    get dockerTrace() { return structuredClone(dockerTrace); },
    validate: (extra = {}) => { assertRoot(); validateConfig(); return safeEnv(extra); },
    registerWindow: (name, value) => { if (!/^[0-9a-f]{24}$/.test(value) || name !== 'j376-view-' + value) fail('invalid window ownership'); windows.set(name, value); },
    windowCreateUncertain: name => { if (!windows.has(name)) fail('unregistered window'); uncertainCreates.add(name); },
    cleanupWindow: name => { if (!windows.has(name)) fail('unregistered window'); removeContainer(name, name); },
    get imageId() { prerequisites(); return imageId; }, dockerEnv: Object.freeze({ ...baseline }) };
  return rig;
  } catch (error) {
    // No Docker operation occurs before this constructor returns. Clean a partially initialised root by its original inode only.
    try {
      if (fs.existsSync(root)) {
        const current = fs.lstatSync(root);
        if (!allocated || fs.realpathSync(root) !== root || current.ino !== allocated.ino || current.dev !== allocated.dev) throw new Error('constructor root ownership is unconfirmed');
        fs.rmSync(root, { recursive: true, force: true });
      }
    } catch (cleanupError) { error.cleanupUnconfirmedRoot = root; error.message += '; constructor cleanup failed: ' + cleanupError.message; }
    throw error;
  }
}
