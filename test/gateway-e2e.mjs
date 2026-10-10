#!/usr/bin/env node
// J376: repeatable, offline gateway integration tests with a real disposable Docker sandbox and private relay/daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRig } from './gateway/rig.mjs';
import { installFixtures, jsonLines } from './gateway/fixtures.mjs';
import { runResearch } from './gateway/research.mjs';
import { runWindow } from './gateway/window.mjs';

const hostHome = os.homedir();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let reportFile = '', requireComplete = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--report' && args[i + 1]) reportFile = path.resolve(args[++i]);
  else if (args[i] === '--require-complete') requireComplete = true;
  else throw new Error('usage: node test/gateway-e2e.mjs [--report FILE] [--require-complete]');
}
// Output paths are not a route to live relay/config files either. Refuse symlink ancestors before creating a report.
if (reportFile) {
  const forbidden = [path.join(os.homedir(), '.local/state/hyprpi'), path.join(os.homedir(), '.config/hyprpi'),
    ...(process.env.XDG_STATE_HOME ? [path.join(process.env.XDG_STATE_HOME, 'hyprpi')] : []),
    ...(process.env.XDG_CONFIG_HOME ? [path.join(process.env.XDG_CONFIG_HOME, 'hyprpi')] : [])];
  assert.ok(!forbidden.some(p => reportFile === p || reportFile.startsWith(p + path.sep)), 'reports cannot target live hyprpi state/config');
  let current = path.parse(reportFile).root;
  for (const part of reportFile.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'report paths cannot contain symlinks');
  }
}
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
const testFiles = [path.join(repoRoot, 'test/gateway-e2e.mjs'), ...fs.readdirSync(path.join(repoRoot, 'test/gateway'), { recursive: true }).filter(f => /\.(mjs|py|md)$/.test(f)).sort().map(f => path.join(repoRoot, 'test/gateway', f))];
const suiteHash = crypto.createHash('sha256');
for (const file of testFiles) suiteHash.update(path.relative(repoRoot, file) + '\0').update(fs.readFileSync(file));
const dirty = !!spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
const report = { schema: 1, job: 'J376', commit: sha, dirty, suiteSha256: suiteHash.digest('hex'), started: new Date().toISOString(), cases: [], scope: 'private world I only; no live daemon/relay/world G', providers: 'synthetic offline fixtures', prerequisites: 'cached pi-sandbox image, Docker, Node, Python; pi for J373', cleanup: null };
const kids = new Set(), ownedRigs = new Set();
let rig, relay, daemon, ctx, finishPromise;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function stop(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) { kids.delete(child); return; }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await pause(100);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await Promise.race([new Promise(r => child.once('exit', r)), pause(3000)]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned subprocess exited during cleanup');
  kids.delete(child);
}
function start(name, relative) {
  const fd = fs.openSync(rig.P(name + '.log'), 'a');
  const child = spawn(process.execPath, [path.join(repoRoot, relative), relative === 'bin/hyprpi' ? 'daemon' : 'run'], { env: rig.validate(), cwd: repoRoot, detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child.on('error', e => { child.startError = e; });
  kids.add(child);
  return child;
}
async function waitFor(label, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    for (const child of [daemon, relay]) if (child && (child.startError || child.exitCode !== null || child.signalCode !== null)) throw new Error(label + ': isolated child stopped: ' + (child.startError?.message || child.exitCode || child.signalCode));
    await pause(100);
  }
  throw new Error('timed out: ' + label);
}
function items(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().flatMap(n => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))]; }
    catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return []; throw e; }
  });
}
async function testcase(name, fn) {
  const t = Date.now();
  try { await fn(); report.cases.push({ name, status: 'PASS', ms: Date.now() - t }); console.log('PASS  ' + name); }
  catch (e) { report.cases.push({ name, status: 'FAIL', ms: Date.now() - t, error: e.stack || String(e) }); console.error('FAIL  ' + name + '\n' + (e.stack || e)); }
}
function pending(name, reason) { report.cases.push({ name, status: 'PENDING', reason }); console.log('PENDING  ' + name + ': ' + reason); }
async function feature(job, files, fn) {
  const missing = files.filter(f => !fs.existsSync(path.join(repoRoot, f)));
  if (missing.length) return pending(job + ' coverage', 'not landed in this checkout: ' + missing.join(', '));
  await fn();
}
async function cleanup() {
  if (finishPromise) return finishPromise;
  finishPromise = (async () => {
    const errors = report.constructorCleanupUnconfirmed ? ['constructor cleanup unconfirmed: ' + report.constructorCleanupUnconfirmed] : [];
    for (const child of [...kids].reverse()) try { await stop(child); } catch (e) { errors.push(e.message); }
    if (rig) {
      // Copy only synthetic diagnostics into a requested report. Scratch state is still destroyed on failure.
      report.diagnostics = {};
      for (const f of ['relay.log', 'daemon.log']) try { report.diagnostics[f] = fs.readFileSync(rig.P(f), 'utf8').slice(-20000); } catch { /* startup may not have reached the log */ }
      if (!errors.length) for (const owned of [...ownedRigs].reverse()) try { await owned.close(); } catch (e) { errors.push(e.message); }
      else errors.push('scratch retained because a subprocess did not stop');
      report.ownedScratch = [...ownedRigs].map(owned => ({ root: owned.root, removed: !fs.existsSync(owned.root) }));
      report.scratchRemoved = report.ownedScratch.every(item => item.removed);
    }
    report.cleanup = { ok: errors.length === 0 && (!rig || report.scratchRemoved), errors };
  })();
  return finishPromise;
}
let terminating = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (terminating) return; terminating = true; cleanup().then(() => { emit(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); }); });
for (const event of ['unhandledRejection', 'uncaughtException']) process.on(event, async error => {
  if (terminating) return; terminating = true;
  report.cases.push({ name: event, status: 'FAIL', error: error?.stack || String(error) });
  await cleanup(); emit(); process.exit(1);
});
function emit() {
  report.finished = new Date().toISOString();
  report.counts = Object.fromEntries(['PASS', 'FAIL', 'PENDING'].map(s => [s.toLowerCase(), report.cases.filter(c => c.status === s).length]));
  report.complete = report.counts.pending === 0;
  report.ok = report.counts.fail === 0 && report.cleanup?.ok === true && (!requireComplete || report.counts.pending === 0);
  if (reportFile) { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); }
  console.log(`\n${report.ok ? (report.complete ? 'PASS' : 'PASS (INCOMPLETE)') : 'FAIL'}: ${report.counts.pass} passing, ${report.counts.fail} failing, ${report.counts.pending} pending; cleanup ${report.cleanup?.ok ? 'complete' : 'FAILED'}; ${sha.slice(0, 12)}`);
  if (reportFile) console.log('Report: ' + reportFile);
}

try {
  rig = await createRig({ repoRoot }); ownedRigs.add(rig);
  const fixture = installFixtures(rig);
  // Helpers can import product modules which capture HOME/XDG paths at import time. Load them only after isolation.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, rig.env);
  const { runTyped, runBridge } = await import('./gateway/typed-bridge.mjs');
  const { runConfig, runStateless } = await import('./gateway/config-stateless.mjs');
  const relayState = rig.P('state/hyprpi/sbx-relay');
  // Stubbed Docker in the product PATH is essential: relay startup/shutdown otherwise reconciles GLOBAL GPU workers.
  assert.ok(fs.existsSync(rig.P('bin/docker')), 'a fake Docker must guard every product subprocess');
  const probe = spawnSync(rig.P('bin/docker'), ['ps', '-a', '--filter', 'label=hyprpi.gpu=1', '-q'], { env: rig.env, encoding: 'utf8' });
  assert.equal(probe.status, 0); assert.equal(probe.stdout.trim(), '', 'product GPU reconciliation sees no real containers');
  await rig.start();
  daemon = start('daemon', 'bin/hyprpi');
  await waitFor('private daemon socket', () => fs.existsSync(rig.P('d.sock')));
  relay = start('relay', 'docker/sbx-relay.mjs');
  await waitFor('private relay outboxes', () => fs.existsSync(rig.P('ws/.hyprpi-dropbox/outbox')) && fs.existsSync(rig.P('dws/.hyprpi-dropbox/outbox')) && fs.existsSync(path.join(relayState, 'decisions')));
  const readWorld = () => JSON.parse(fs.readFileSync(fixture.worldFile, 'utf8'));
  const writeWorld = update => { const value = update(readWorld()); fs.writeFileSync(fixture.worldFile + '.test-tmp', JSON.stringify(value, null, 2)); fs.renameSync(fixture.worldFile + '.test-tmp', fixture.worldFile); };
  const inbox = role => items(rig.P(role === 'sandbox' ? 'inbox' : 'dinbox'));
  ctx = { repoRoot, rig, relayState, worldFile: fixture.worldFile, hostHome, testcase, pending, feature, waitFor, inbox, readWorld, writeWorld,
    artifact: (name, data) => { assert.match(name, /^[A-Za-z0-9_.-]{1,150}$/); (report.artifacts ||= {})[name] = structuredClone(data); },
    logs: () => jsonLines(path.join(relayState, 'log.jsonl')),
    effects: () => jsonLines(rig.P('effects.jsonl')),
    pendingItems: () => items(path.join(relayState, 'pending')),
    ask: async (role, request) => {
      const filename = await rig.request(role, request);
      return waitFor('dropbox result ' + filename, () => inbox(role).find(x => x.type === 'result' && x.for === filename));
    },
    holdFrom: r => JSON.parse(fs.readFileSync(path.join(relayState, 'pending', r.pending[0] + '.json'), 'utf8')),
    decide: async (id, choice, { edit, note } = {}) => {
      const cmd = choice === '2' ? 'deny' : choice === 'r' ? 'return' : choice === 'a' ? 'answer' : 'approve';
      const argv = [cmd, id];
      if (choice === 'e') { const file = rig.P('edits', id + '.txt'); fs.writeFileSync(file, edit); argv.push('--edit-file', file); }
      if (note) argv.push(['return', 'answer'].includes(cmd) ? '--note' : '--reason', note);
      const result = await rig.owner(argv);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      await waitFor('decision consumed for ' + id, () => !fs.existsSync(path.join(relayState, 'pending', id + '.json')));
      return result;
    },
    cli: (relative, argv, options = {}) => rig.cli(path.join(repoRoot, relative), argv, { ...options, env: { DOORMAN_STATE: relayState, XDG_CACHE_HOME: rig.P('cache'), DOORMAN_BRIDGE_AGENT: 'fixture-host', ...options.env } }),
    restartRelay: async ({ hostAgents } = {}) => {
      await stop(relay); relay = null;
      if (hostAgents !== undefined) { const cfg = JSON.parse(fs.readFileSync(fixture.relayFile, 'utf8')); cfg.sandboxes.find(s => s.name === rig.doorman).host_agents = hostAgents; fs.writeFileSync(fixture.relayFile, JSON.stringify(cfg)); }
      relay = start('relay', 'docker/sbx-relay.mjs');
      const marker = fs.statSync(rig.P('relay.log')).size;
      await waitFor('relay restarted', () => fs.statSync(rig.P('relay.log')).size > marker || jsonLines(path.join(relayState, 'log.jsonl')).some(x => x.note === `relay starting (pid ${relay.pid}) for ${rig.sandbox}, ${rig.doorman}`));
      await pause(500);
    },
  };
  await testcase('W1 negative isolation and owner guards: all 26 rig safety checks', async () => {
    rig.validate();
    const { safety } = await import('./gateway/rig-safety.mjs');
    const attempts = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await safety({ repoRoot, onRig: nested => ownedRigs.add(nested) }); assert.equal(result.ok, true); assert.equal(result.checks, 26);
        attempts.push({ status: 'PASS', result }); ctx.artifact('rig-safety', { attempts }); break;
      } catch (error) {
        if (error.cleanupUnconfirmedRoot) report.constructorCleanupUnconfirmed = error.cleanupUnconfirmedRoot;
        attempts.push({ status: 'FAIL', error: error.stack, cleanupVerified: error.cleanupVerified === true });
        ctx.artifact('rig-safety', { attempts });
        if (attempt || !error.cleanupVerified || !/exact owned container cleanup.*(?:ETIMEDOUT|already in progress)/s.test(error.message)) throw error;
        console.log('RETRY W1 safety: Docker removal stalled; exact-label cleanup verified, one bounded retry');
      }
    }
  });
  await testcase('W1: actual sandbox has only private mounts, read-only inbox and no network', async () => {
    const info = await ctx.ask('sandbox', { op: 'room.read', limit: 1 });
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(typeof rig.proof, 'function', 'actual mount/read-only/network proof is required');
    const proof = await rig.proof(); assert.equal(proof.ok, true, JSON.stringify(proof)); report.isolation = proof;
  });
  await runResearch(ctx);
  await runWindow(ctx);
  await runTyped(ctx);
  await runBridge(ctx);
  await runConfig(ctx);
  await runStateless(ctx);
} catch (e) {
  if (e.cleanupUnconfirmedRoot) report.constructorCleanupUnconfirmed = e.cleanupUnconfirmedRoot;
  report.cases.push({ name: 'suite infrastructure', status: 'FAIL', error: e.stack || String(e) });
  console.error(e.stack || e);
} finally { await cleanup(); }
emit();
process.exitCode = report.ok ? 0 : 1;
