// J376: real disposable-sandbox dropboxes -> full scratch relay -> owner PTY -> fixed handlers / host bridge.
// This module never substitutes relay/handler source, writes decision files, or executes a host job's requested text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BRIDGE = 'docker/bridge/doorman-bridge';
const TYPES = ['open_for_owner', 'note_to_owner', 'share_project', 'send_file', 'allow_host'];
const MCP_TOOLS = ['list_jobs', 'show_job', 'claim_job', 'renew_job', 'ask_owner', 'report_job', 'release_job', 'read_settings', 'propose_settings'];
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; } };
const record = (ctx, id) => readJson(path.join(ctx.relayState, 'requests', id + '.json'));
const fileCopies = ctx => fs.readdirSync(ctx.rig.P('inbox')).filter(n => /^file-/.test(n)).sort();

function scratch(ctx) {
  const root = fs.realpathSync(ctx.rig.root);
  assert.match(path.basename(root), /^gateway-e2e-[A-Za-z0-9_-]+$/, 'only the parent-owned disposable fixture may be used');
  for (const p of [ctx.relayState, ctx.worldFile, ctx.rig.P('config'), ctx.rig.P('cache')]) {
    assert.ok(path.resolve(p).startsWith(root + path.sep), 'all bridge/config/state paths must be under the disposable root: ' + p);
  }
  assert.match(ctx.rig.sandbox, /^j376-/);
  assert.match(ctx.rig.doorman, /^j376-/);
  const cfg = readJson(ctx.rig.P('config/hyprpi/sbx-relay.json'));
  assert.equal(cfg.sandboxes.find(s => s.name === ctx.rig.doorman)?.reports_to, 'Thoughts-I', 'the coordinator must be private Thoughts-I, never live G');
}

// Snapshot bytes and names, not timestamps. These are the surfaces an unauthorized bridge operation must never change.
function snapshot(ctx, which = ['config', 'decisions', 'pending']) {
  const h = crypto.createHash('sha256');
  const walk = (dir, label) => {
    if (!fs.existsSync(dir)) { h.update(label + ':absent\n'); return; }
    h.update(label + ':dir\n');
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name), key = label + '/' + e.name;
      assert.ok(!e.isSymbolicLink(), 'scratch snapshot refuses symlinks: ' + p);
      if (e.isDirectory()) walk(p, key);
      else { assert.ok(e.isFile(), 'scratch snapshot expects plain files'); h.update(key + '\0'); h.update(fs.readFileSync(p)); h.update('\0'); }
    }
  };
  for (const name of which) walk(name === 'config' ? ctx.rig.P('config') : path.join(ctx.relayState, name), name);
  return h.digest('hex');
}

function jsonResult(result, expectedStatus = 0) {
  assert.equal(result.status, expectedStatus, 'product CLI exit: ' + result.stdout + result.stderr);
  try { return JSON.parse(result.stdout); } catch { assert.fail('product CLI returned non-JSON: ' + result.stdout + result.stderr); }
}
async function cli(ctx, args, options = {}, expectedStatus = 0) {
  return jsonResult(await ctx.cli(BRIDGE, ['--json', ...args], options), expectedStatus);
}

// Both are real served-inbox messages: Name: routes to the asker; the separate unprefixed message routes to its Thoughts.
// The fixture has no model consuming these messages: verify the actual routing envelope and the private coordinator binding.
async function outcomes(ctx, id, contains) {
  return ctx.waitFor('asker and private coordinator outcomes for ' + id, () => {
    const messages = ctx.inbox('sandbox').filter(x => x.type === 'message' && x.from === 'Outside' && typeof x.text === 'string' && x.text.includes(id));
    const asker = messages.find(x => x.text.startsWith('Alpha: [Outside] ') && x.text.includes(contains));
    const coordinator = messages.find(x => x.text.startsWith('[Outside] ') && x.text.includes(contains) && x.text.endsWith('(asked by Alpha)'));
    if (!asker || !coordinator) return false;
    assert.equal(asker.mode, 'talk'); assert.equal(coordinator.mode, 'talk');
    return { asker, coordinator };
  });
}

async function cleanHeld(ctx, id) {
  if (id && ctx.pendingItems().some(x => x.id === id)) await ctx.decide(id, '2');
}

// The runner scrubs its OWN environment before dynamically loading coverage modules. This read-only product import
// therefore captures scratch XDG paths; refuse to import it at all if a caller has not established that isolation.
async function trackHeld(ctx, id) {
  assert.match(id, /^[A-Za-z0-9._-]+--[0-9a-f]{6}$/);
  assert.equal(process.env.XDG_STATE_HOME, ctx.rig.P('state'), 'tracker must capture only scratch state');
  assert.equal(process.env.HOME, ctx.rig.P('home'), 'tracker must not see the live home');
  const product = await import(pathToFileURL(path.join(ctx.repoRoot, 'lib/held.mjs')).href);
  return product.trackHeld(id);
}

async function typedFinal(ctx, id, type, state) {
  const rec = await ctx.waitFor('terminal typed record ' + id, () => { const r = record(ctx, id); return r?.state === state && r.outcome?.state === state ? r : false; });
  assert.equal(rec.type, type); assert.equal(rec.sandbox, ctx.rig.sandbox); assert.equal(rec.doorman, ctx.rig.doorman); assert.equal(rec.for, 'Alpha');
  assert.equal(rec.outcome.by, 'relay'); assert.ok(rec.decided_at); assert.ok(rec.history.some(x => x.ev === state));
  const note = await ctx.waitFor('Doorman typed inbox outcome ' + id, () => ctx.inbox('doorman').find(x => x.type === 'typed' && x.id === id));
  assert.equal(note.kind, type); assert.equal(note.status, state); assert.equal(note.outcome, rec.outcome.summary);
  const decision = state === 'denied' ? 'denied' : 'approved';
  const log = await ctx.waitFor('durable typed archive ' + id, () => ctx.logs().find(x => x.op === 'typed' && x.id === id && x.decision === decision));
  assert.equal(log.type, type); assert.equal(log.sb, ctx.rig.doorman); assert.equal(log.sandbox, ctx.rig.sandbox);
  assert.equal(log.ok, state === 'done'); assert.equal(log.outcome, rec.outcome.summary);
  await outcomes(ctx, id, rec.outcome.summary);
  const tracked = await trackHeld(ctx, id);
  assert.equal(tracked.done, true); assert.equal(tracked.state, decision);
  assert.match(tracked.text, state === 'denied' ? /denied: nothing was sent/ : state === 'done' ? /^done:.*Thoughts are told/ : /^not done:.*Thoughts are told/);
  if (state !== 'denied') assert.ok(tracked.text.includes(rec.outcome.summary));
  return rec;
}

export async function runTyped(ctx) {
  await ctx.feature('J368', ['docker/gateway/types.mjs', 'lib/held.mjs'], async () => {
    scratch(ctx);
    // Prior research cases use this same Doorman. Reset only the parent's exact scratch relay, never a live service.
    await ctx.restartRelay({ hostAgents: false });
    const fixture = ctx.rig.P('projects/fixture/notes.md');
    assert.ok(fs.existsSync(fixture), 'parent must seed the fixture project');
    const params = {
      open_for_owner: { what: 'https://example.org/gateway-fixture?tracking=remove#fragment', why: 'look at the synthetic result' },
      note_to_owner: { text: 'Synthetic fixture note for the owner; no action or model should run.' },
      share_project: { project: 'fixture', mode: 'ro', why: 'read the synthetic fixture' },
      send_file: { path: fixture, why: 'read the synthetic fixture notes' },
      allow_host: { host: 'Example.ORG.', why: 'read synthetic public documentation' },
    };
    // 10 matrix requests plus 5 refusal/change probes below: 15 Doorman requests total, below the relay's 20/minute cap.
    // Approve then deny per type also avoids three consecutive denials tripping the real circuit breaker.
    for (const type of TYPES) for (const choice of ['1', '2']) {
      await ctx.testcase(`J368 ${type}: ${choice === '1' ? 'approve' : 'deny'} routes asker + Thoughts-I + durable archive`, async () => {
        let id;
        const effectsBefore = ctx.effects(), copiesBefore = fileCopies(ctx), worldBefore = fs.readFileSync(ctx.worldFile, 'utf8');
        try {
          const result = await ctx.ask('doorman', { op: 'request', type, for: 'Alpha', params: params[type] });
          assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.pending?.length, 1);
          const held = ctx.holdFrom(result); id = held.id;
          assert.equal(held.sandbox, ctx.rig.doorman); assert.equal(held.draft, true);
          assert.equal(held.typed.type, type); assert.equal(held.typed.for, 'Alpha'); assert.equal(held.typed.sandbox, ctx.rig.sandbox);
          assert.deepEqual(held.to, ['Thoughts-I']); assert.deepEqual(held.rooms, ['I']);
          const pending = record(ctx, id); assert.equal(pending.state, 'pending'); assert.deepEqual(pending.params, held.typed.params);
          assert.equal((await trackHeld(ctx, id)).state, 'pending');
          assert.deepEqual(ctx.effects(), effectsBefore, 'no fixed handler runs before the owner decides');
          assert.deepEqual(fileCopies(ctx), copiesBefore, 'no host file is copied before approval');
          assert.equal(fs.readFileSync(ctx.worldFile, 'utf8'), worldBefore, 'no sharing/config change before approval');
          await ctx.decide(id, choice);
          const rec = await typedFinal(ctx, id, type, choice === '1' ? 'done' : 'denied');
          const addedEffects = ctx.effects().slice(effectsBefore.length);
          if (choice === '2') {
            assert.match(rec.outcome.summary, /denied: nothing was done/);
            assert.deepEqual(ctx.effects(), effectsBefore, 'deny executes no opener or sbx action');
            assert.deepEqual(fileCopies(ctx), copiesBefore, 'deny copies no host file');
            assert.equal(fs.readFileSync(ctx.worldFile, 'utf8'), worldBefore, 'deny changes no world/share settings');
          } else if (type === 'open_for_owner') {
            assert.equal(rec.params.what, 'https://example.org/gateway-fixture');
            // The URL gate Popen-spawns the fixture browser; its effect can arrive after the typed outcome.
            const opens = await ctx.waitFor('fixture browser effect', () => {
              const list = ctx.effects().slice(effectsBefore.length).filter(x => x.kind === 'opener'); return list.length ? list : false;
            });
            assert.equal(opens.length, 1); assert.deepEqual(opens[0].args, ['--', rec.params.what]);
            assert.match(rec.outcome.summary, /opened .*own Brave window/);
          } else if (type === 'allow_host') {
            assert.equal(rec.params.host, 'example.org');
            assert.deepEqual(addedEffects.filter(x => x.kind === 'sbx').map(x => x.args), [['policy', 'allow', 'network', 'example.org', '--sandbox', ctx.rig.sandbox]]);
            assert.match(rec.outcome.summary, /example\.org is allowed/);
          } else if (type === 'share_project') {
            assert.ok(ctx.readWorld().projects.includes('fixture:ro'), 'owner-approved share is explicitly listed read-only');
            assert.match(rec.outcome.summary, /shared read-only/);
            // addProject deliberately lists the project; the real shares watcher mounts it on its next apply.
            assert.deepEqual(addedEffects, [], 'this handler does not run a host agent or a mount watcher');
          } else if (type === 'send_file') {
            const copies = fileCopies(ctx).filter(n => !copiesBefore.includes(n)); assert.equal(copies.length, 1);
            assert.deepEqual(fs.readFileSync(ctx.rig.P('inbox', copies[0])), fs.readFileSync(fixture));
            assert.equal(rec.params.sha256, crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'));
            assert.ok(rec.outcome.summary.includes(ctx.rig.P('inbox', copies[0])));
            assert.deepEqual(addedEffects, [], 'copy uses the pinned inbox, not a host agent');
          } else {
            assert.match(rec.outcome.summary, /Angus has read the note/);
            assert.deepEqual(addedEffects, [], 'a note executes nothing');
          }
        } finally { await cleanHeld(ctx, id); }
      });
    }

    await ctx.testcase('J368 send_file: changed after review fails closed and tells both recipients', async () => {
      let id; const original = fs.readFileSync(fixture), copiesBefore = fileCopies(ctx), effectsBefore = ctx.effects();
      try {
        const result = await ctx.ask('doorman', { op: 'request', type: 'send_file', for: 'Alpha', params: params.send_file });
        assert.equal(result.ok, true, JSON.stringify(result)); id = ctx.holdFrom(result).id;
        fs.appendFileSync(fixture, 'Changed by the test after owner review.\n');
        await ctx.decide(id, '1');
        const rec = await typedFinal(ctx, id, 'send_file', 'failed'); assert.match(rec.outcome.summary, /not sent: the file changed since Angus saw it/);
        assert.deepEqual(fileCopies(ctx), copiesBefore); assert.deepEqual(ctx.effects(), effectsBefore);
      } finally { fs.writeFileSync(fixture, original); await cleanHeld(ctx, id); }
    });
    for (const [name, role, request, error] of [
      ['malformed typed parameters', 'doorman', { op: 'request', type: 'note_to_owner', for: 'Alpha', params: ['not an object'] }, /text: 1 to 1500/],
      ['unsupported request type', 'doorman', { op: 'request', type: 'run_command', for: 'Alpha', params: { why: 'try unsupported action', command: 'never executed' } }, /unknown request type/],
      ['send_file outside allowed project roots', 'doorman', { op: 'request', type: 'send_file', for: 'Alpha', params: { path: ctx.rig.P('card/card.md'), why: 'must refuse outside projects' } }, /not inside a project or role folder/],
      ['free-form draft on agent-free host', 'doorman', { op: 'draft', for: 'Alpha', why: 'unsupported host action', tried: 'nothing', action: 'Do not execute this synthetic action' }, /free-form request needs a host agent.*host has none/],
      ['served sandbox cannot draft typed requests', 'sandbox', { op: 'request', type: 'note_to_owner', for: 'Alpha', params: { text: 'not from the Doorman' } }, /only a Doorman drafts requests/],
    ]) await ctx.testcase('J368 refusal: ' + name, async () => {
      const before = snapshot(ctx, ['config', 'decisions', 'pending', 'requests']), effectsBefore = ctx.effects(), copiesBefore = fileCopies(ctx);
      const result = await ctx.ask(role, request); assert.equal(result.ok, false, JSON.stringify(result)); assert.match(result.error, error);
      assert.equal(result.pending, undefined); assert.equal(snapshot(ctx, ['config', 'decisions', 'pending', 'requests']), before);
      assert.deepEqual(ctx.effects(), effectsBefore); assert.deepEqual(fileCopies(ctx), copiesBefore);
    });
  });
}

// Minimal JSON-line MCP client. Uses the actual product server, with scratch env only; one RPC is awaited before the next.
function startMcp(ctx) {
  const env = ctx.rig.validate({ DOORMAN_STATE: ctx.relayState, XDG_CACHE_HOME: ctx.rig.P('cache'), DOORMAN_BRIDGE_AGENT: 'fixture-mcp' });
  const child = spawn(process.execPath, [path.join(ctx.repoRoot, BRIDGE), 'mcp'], { cwd: ctx.repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', stderr = '', next = 1, stopped = false;
  const waiting = new Map();
  const fail = e => { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(e); } waiting.clear(); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-10000); });
  child.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { fail(new Error('MCP emitted non-JSON: ' + line)); continue; }
      const w = waiting.get(message.id); if (!w) continue;
      waiting.delete(message.id); clearTimeout(w.timer); w.resolve(message);
    }
  });
  child.on('error', fail);
  child.on('close', (code, signal) => { stopped = true; fail(new Error(`scratch MCP stopped (${code ?? signal}): ${stderr}`)); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (stopped) return reject(new Error('scratch MCP already stopped'));
    const id = next++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('MCP timeout: ' + method + ' ' + JSON.stringify(params) + '\n' + stderr)); }, 20000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n', e => { if (e) fail(e); });
  });
  return {
    rpc,
    async tool(name, args = {}, ok = true) {
      const reply = await rpc('tools/call', { name, arguments: args }); assert.equal(reply.error, undefined, JSON.stringify(reply));
      assert.equal(!!reply.result.isError, !ok, JSON.stringify(reply.result));
      assert.equal(reply.result.content[0].type, 'text'); const result = JSON.parse(reply.result.content[0].text);
      if (Object.hasOwn(result, 'ok')) assert.equal(result.ok, ok, JSON.stringify(result));
      return result;
    },
    notify() { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); },
    async close() {
      fail(new Error('scratch MCP cleanup'));
      if (stopped) return;
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (!stopped) child.kill('SIGKILL'); }, 2000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (stopped) { clearTimeout(timer); resolve(); }
      });
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'the exact owned MCP child was reaped');
    },
  };
}

async function newBridgeJob(ctx, tag) {
  let id;
  try {
    const result = await ctx.ask('doorman', { op: 'draft', for: 'Alpha', why: 'exercise a synthetic host-job lifecycle', tried: 'the fixed request types do not cover this test', action: 'Inspect the synthetic fixture only; tag ' + tag });
    assert.equal(result.ok, true, JSON.stringify(result)); const held = ctx.holdFrom(result); id = held.id;
    assert.equal(held.draft, true); assert.equal(held.typed, undefined); assert.deepEqual(held.to, ['Thoughts-I']);
    assert.equal(record(ctx, id), null, 'a draft is not a host job until the owner approves');
    assert.ok(!(await cli(ctx, ['list', '--all'])).some(x => x.id === id), 'unapproved draft is not bridge-visible');
    await ctx.decide(id, '1');
    const job = await ctx.waitFor('owner-approved bridge job ' + id, () => { const r = record(ctx, id); return r?.type === 'host_job' ? r : false; });
    assert.equal(job.state, 'waiting'); assert.equal(job.for, 'Alpha'); assert.equal(job.sandbox, ctx.rig.sandbox);
    assert.equal(job.approved.action, held.text, 'bridge exposes exactly the owner-approved text');
    assert.deepEqual(job.approved.tools, ['Read']); assert.deepEqual(job.approved.folders, [ctx.rig.P('projects/fixture')]); assert.equal(job.approved.time_limit_s, 300);
    assert.equal(job.claim, null); assert.equal(job.outcome, null);
    return { id, job, held };
  } finally { await cleanHeld(ctx, id); }
}

async function hostFinal(ctx, id, state, summary, ran, changed) {
  const rec = await ctx.waitFor('final host-job record ' + id, () => { const r = record(ctx, id); return r?.state === state ? r : false; });
  assert.equal(rec.type, 'host_job'); assert.equal(rec.claim, null); assert.equal(rec.outcome.state, state); assert.equal(rec.outcome.summary, summary);
  assert.deepEqual(rec.outcome.ran, ran); assert.deepEqual(rec.outcome.changed, changed);
  const archive = await ctx.waitFor('durable host-job archive ' + id, () => ctx.logs().find(x => x.op === 'host_job' && x.id === id && x.state === state));
  assert.equal(archive.outcome, summary); assert.deepEqual(archive.ran, ran); assert.deepEqual(archive.changed, changed);
  await outcomes(ctx, id, 'ended ' + state + ': ' + summary);
  return rec;
}

async function followup(ctx, id, ask, show, choice = '2') {
  let heldId;
  try {
    const text = 'Should this synthetic inspection use only the fixture notes?';
    const asked = await ask(text); assert.equal(asked.ok, true, JSON.stringify(asked)); assert.equal(asked.n, 1);
    const held = await ctx.waitFor('host-job follow-up held in Doorman window', () => ctx.pendingItems().find(x => x.hostJob?.id === id)); heldId = held.id;
    assert.equal(held.hostJob.n, 1); assert.equal(held.sandbox, ctx.rig.doorman); assert.deepEqual(held.shown, ['Angus']); assert.deepEqual(held.rooms, ['I']); assert.ok(held.text.includes(text));
    const waiting = await show(); assert.equal(waiting.state, 'asked'); assert.equal(waiting.questions[0].answer, null);
    assert.equal(record(ctx, id).questions[0].held_id, heldId, 'question is bound to the exact held item');
    // The actual owner CLI / PTY path, not a decision-file bypass.
    const answer = choice === 'a' ? 'Use only the synthetic fixture notes; do not execute commands.' : '(the owner declined to answer)';
    if (choice === 'a') {
      for (const options of [{ agent: true }, { pipe: true }]) {
        const r = await ctx.rig.owner(['answer', heldId, '--note', answer], options);
        assert.equal(r.status, 3, r.stdout + r.stderr);
        assert.equal((await show()).questions[0].answer, null, 'refused answer cannot change the question');
      }
      await assert.rejects(ctx.rig.owner(['answer', 'foreign--abcdef', '--note', answer]), /unsafe or foreign/);
      await assert.rejects(ctx.rig.owner(['answer', heldId, '--note', answer, '--extra']), /answer requires|option not permitted/);
    }
    await ctx.decide(heldId, choice, choice === 'a' ? { note: answer } : {});
    const answered = await ctx.waitFor('owner follow-up readable through show', async () => { const r = await show(); return r.questions[0]?.answer ? r : false; });
    assert.equal(answered.state, 'claimed'); assert.equal(answered.questions[0].answer, answer); assert.ok(answered.questions[0].answered_at);
    assert.equal(record(ctx, id).questions[0].held_id, heldId, 'answer remains bound to the exact held question');
    assert.ok(ctx.logs().some(x => x.op === 'host_job_answer' && x.job === id && x.id === heldId && x.applied === true));
  } finally { await cleanHeld(ctx, heldId); }
}

async function proposal(ctx, submit, target) {
  let id;
  const beforeWorld = ctx.readWorld(), beforeConfig = snapshot(ctx, ['config']);
  try {
    const result = await submit(); assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(result.id); id = result.id;
    const held = await ctx.waitFor('gateway proposal held for owner ' + id, () => ctx.pendingItems().find(x => x.id === id));
    assert.equal(held.gatewayChange.sandbox, ctx.rig.sandbox); assert.deepEqual(held.gatewayChange.changes, { level: target });
    assert.ok(held.text.includes('level:')); assert.ok(held.text.includes(target));
    assert.equal(snapshot(ctx, ['config']), beforeConfig, 'a legitimate proposal holds; it cannot modify config itself');
    await ctx.decide(id, '1');
    await ctx.waitFor('approved gateway settings applied', () => ctx.readWorld().gateway?.level === target);
    const expected = { ...beforeWorld, gateway: { ...(beforeWorld.gateway || {}), level: target } };
    assert.deepEqual(ctx.readWorld(), expected, 'owner approval applies exactly the intended setting');
    assert.ok(ctx.logs().some(x => x.op === 'gateway_change' && x.id === id && x.applied === true));
  } finally { await cleanHeld(ctx, id); }
}

export async function runBridge(ctx) {
  await ctx.feature('J371', [BRIDGE, 'docker/bridge/core.mjs', 'docker/bridge/mcp.mjs', 'docker/bridge/relay-bridge.mjs'], async () => {
    scratch(ctx);
    await ctx.restartRelay({ hostAgents: 'bridge' });
    await ctx.waitFor('scratch bridge request directory', () => fs.existsSync(path.join(ctx.relayState, 'bridge/in')));
    await ctx.testcase('J371 CLI list/show/claim/renew/release/ask/report: approved job, exclusive claims, owner follow-up and routed outcome', async () => {
      const { id, job } = await newBridgeJob(ctx, 'CLI');
      assert.ok((await cli(ctx, ['list'])).some(x => x.id === id && x.state === 'waiting'));
      let shown = await cli(ctx, ['show', id]); assert.deepEqual(shown.approved, job.approved);
      assert.equal(shown.claim, undefined, 'the public job view does not disclose claim tokens');
      const claimers = await Promise.all(Array.from({ length: 4 }, (_, i) => {
        const by = 'fixture-cli-' + i;
        // rig.cli may serialize subprocesses: this checks exclusive claims, not timing/atomicity under contention.
        // Only the successful claimer writes a token to the parent's permitted scratch cache.
        return ctx.cli(BRIDGE, ['--json', 'claim', id, '--by', by, '--lease', '120']).then(raw => ({ by, raw, result: JSON.parse(raw.stdout) }));
      }));
      const winners = claimers.filter(x => x.raw.status === 0 && x.result.ok); assert.equal(winners.length, 1, 'exactly one CLI claimer obtains the job');
      for (const loser of claimers.filter(x => x !== winners[0])) { assert.equal(loser.raw.status, 1); assert.equal(loser.result.ok, false); assert.match(loser.result.text, /claimed by/); }
      const winner = winners[0]; assert.equal(record(ctx, id).claim.token, winner.result.token);
      assert.equal((await cli(ctx, ['renew', id, '--by', winner.by])).ok, true);
      assert.equal((await cli(ctx, ['release', id, '--by', winner.by])).ok, true);
      assert.equal(record(ctx, id).state, 'waiting'); assert.equal(record(ctx, id).claim, null);
      assert.equal((await cli(ctx, ['claim', id, '--by', 'fixture-host'])).ok, true);
      await followup(ctx, id, text => cli(ctx, ['ask', id, text]), () => cli(ctx, ['show', id]));
      const summary = 'Synthetic CLI inspection complete; no requested host action executed.';
      const ran = ['fixture: read-only synthetic inspection (no shell execution)'], changed = [];
      assert.equal((await cli(ctx, ['report', id, 'done', '--summary', summary, '--ran', ran[0]])).ok, true);
      await hostFinal(ctx, id, 'done', summary, ran, changed);
      shown = await cli(ctx, ['show', id]); assert.equal(shown.state, 'done');
      assert.equal((await cli(ctx, ['claim', id], {}, 1)).ok, false, 'completed job cannot be reclaimed');
    });

    let mcp;
    try {
      mcp = startMcp(ctx);
      await ctx.testcase('J371 MCP initialize/tools/list: all nine supported tools, no owner decision/config-write capability', async () => {
        const initialized = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gateway-fixture', version: '1' } });
        assert.equal(initialized.error, undefined); assert.equal(initialized.result.serverInfo.name, 'doorman-bridge'); assert.equal(initialized.result.protocolVersion, '2025-06-18');
        mcp.notify();
        const list = await mcp.rpc('tools/list'); assert.equal(list.error, undefined);
        assert.deepEqual(list.result.tools.map(x => x.name).sort(), [...MCP_TOOLS].sort());
        assert.ok(list.result.tools.every(x => x.inputSchema.additionalProperties === false));
      });
      await ctx.testcase('J371 MCP list/show/claim/renew/release/ask/report: actual relay lifecycle and routed partial outcome', async () => {
        const { id, job } = await newBridgeJob(ctx, 'MCP');
        assert.ok((await mcp.tool('list_jobs')).jobs.some(x => x.id === id));
        assert.deepEqual((await mcp.tool('show_job', { id })).approved, job.approved);
        assert.equal((await mcp.tool('claim_job', { id, lease_s: 120 })).ok, true);
        assert.equal((await mcp.tool('renew_job', { id, lease_s: 120 })).ok, true);
        assert.equal((await mcp.tool('release_job', { id })).ok, true); assert.equal(record(ctx, id).state, 'waiting');
        assert.equal((await mcp.tool('claim_job', { id })).ok, true);
        await followup(ctx, id, question => mcp.tool('ask_owner', { id, question }), () => mcp.tool('show_job', { id }));
        const summary = 'Synthetic MCP inspection is partial; the owner declined the follow-up.';
        const ran = ['fixture: inspected synthetic notes'], changed = ['fixture-only: no product or host files changed'];
        await mcp.tool('report_job', { id, state: 'partial', summary, ran, changed });
        await hostFinal(ctx, id, 'partial', summary, ran, changed);
        assert.equal((await mcp.tool('show_job', { id })).state, 'partial');
        await mcp.tool('report_job', { id, state: 'done', summary: 'late report' }, false);
      });
      await ctx.testcase('J371 unauthorized CLI and MCP approve/deny/config-write refuse without config/decisions/pending mutations', async () => {
        const before = snapshot(ctx), effectsBefore = ctx.effects();
        for (const args of [['approve', 'invalid'], ['deny', 'invalid'], ['edit', 'invalid'], ['create', 'invalid'], ['config-write', ctx.rig.sandbox, 'level=open'], ['set', ctx.rig.sandbox, 'level=open']]) {
          const r = await ctx.cli(BRIDGE, ['--json', ...args]); assert.equal(r.status, 2, r.stdout + r.stderr);
          assert.equal(snapshot(ctx), before, 'unsupported CLI ' + args[0] + ' changed protected surfaces');
        }
        for (const name of ['approve_job', 'deny_job', 'edit_job', 'create_job', 'config_write', 'write_settings']) {
          const r = await mcp.tool(name, { sandbox: ctx.rig.sandbox, changes: { level: 'open' } }, false); assert.match(r.text, /unknown tool/);
          assert.equal(snapshot(ctx), before, 'unsupported MCP ' + name + ' changed protected surfaces');
        }
        const invalid = await mcp.rpc('approve', {}); assert.equal(invalid.error.code, -32601);
        assert.equal(snapshot(ctx), before); assert.deepEqual(ctx.effects(), effectsBefore);
      });
      await ctx.feature('J371 settings/proposals (J372 host commands)', ['docker/bridge/settings.mjs', 'docker/research/gateway-admin.mjs'], async () => {
        const initial = ctx.readWorld();
        try {
          await ctx.testcase('J371 CLI settings/propose: read-only settings, legitimate held proposal applies only after owner approval', async () => {
            const before = snapshot(ctx);
            const viewed = await cli(ctx, ['settings', ctx.rig.sandbox]); assert.equal(viewed.ok, true); assert.equal(viewed.sandbox, ctx.rig.sandbox); assert.equal(typeof viewed.settings, 'object');
            assert.equal(snapshot(ctx), before, 'reading settings changes no protected state');
            const target = viewed.settings.level === 'strict' ? 'safe' : 'strict';
            await proposal(ctx, () => cli(ctx, ['propose', ctx.rig.sandbox, 'level=' + target]), target);
          });
          await ctx.testcase('J371 MCP read_settings/propose_settings: read-only view, owner-approved held settings proposal', async () => {
            const before = snapshot(ctx);
            const viewed = await mcp.tool('read_settings', { sandbox: ctx.rig.sandbox }); assert.equal(viewed.sandbox, ctx.rig.sandbox); assert.equal(typeof viewed.settings, 'object');
            assert.equal(snapshot(ctx), before);
            const target = ctx.readWorld().gateway?.level === 'strict' ? 'safe' : 'strict';
            await proposal(ctx, () => mcp.tool('propose_settings', { sandbox: ctx.rig.sandbox, changes: { level: target } }), target);
          });
          await ctx.testcase('J371 prohibited settings proposal refuses without creating a hold or changing config', async () => {
            const before = snapshot(ctx);
            const r = await mcp.tool('propose_settings', { sandbox: ctx.rig.sandbox, changes: { 'search.key_file': ctx.rig.P('synthetic-key') } }, false);
            assert.match(r.text, /only be set by Angus/); assert.equal(snapshot(ctx), before);
          });
        } finally {
          // Restore only the parent-created fixture world so subsequent config tests begin with their own baseline.
          ctx.writeWorld(() => initial);
        }
      });
    } finally { if (mcp) await mcp.close(); }
    if (fs.readFileSync(path.join(ctx.repoRoot, 'docker/sbx-relay.mjs'), 'utf8').includes('cmd === "answer"')) {
      await ctx.testcase('J385 bridge question: genuine owner PTY answer reaches show bound to its held item', async () => {
        const { id } = await newBridgeJob(ctx, 'ANSWER');
        assert.equal((await cli(ctx, ['claim', id, '--by', 'fixture-host'])).ok, true);
        await followup(ctx, id, text => cli(ctx, ['ask', id, text]), () => cli(ctx, ['show', id]), 'a');
        const summary = 'Synthetic owner-answer round trip completed.';
        assert.equal((await cli(ctx, ['report', id, 'done', '--summary', summary])).ok, true);
        await hostFinal(ctx, id, 'done', summary, [], []);
      });
    } else ctx.pending('J385 owner free-text follow-up answer', 'product answer hook has not landed; deny/show/report paths still run without a decision-file bypass');
    await ctx.testcase('J371 denied free-form draft never becomes a host job', async () => {
      let id;
      try {
        const result = await ctx.ask('doorman', { op: 'draft', for: 'Alpha', why: 'test owner refusal', tried: 'nothing', action: 'Synthetic denied action; never execute' });
        assert.equal(result.ok, true); id = ctx.holdFrom(result).id;
        await ctx.decide(id, '2'); assert.equal(record(ctx, id), null);
        assert.ok(!(await cli(ctx, ['list', '--all'])).some(x => x.id === id));
        assert.ok(ctx.logs().some(x => x.id === id && x.decision === 'denied'));
      } finally { await cleanHeld(ctx, id); }
    });
  });
}
