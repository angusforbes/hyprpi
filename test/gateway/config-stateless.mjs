// J376: full subprocess/relay checks for J372, plus the J373 real-Pi fixture when it lands.
// This module never starts a relay, changes a live world, or invokes a provider. All paths/env come from the owned rig.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RESEARCH = 'docker/research/research.mjs';
const RELAY = 'docker/sbx-relay.mjs';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const output = r => `${r.stdout || ''}\n${r.stderr || ''}`;
function succeeded(r, what) { assert.equal(r.status, 0, `${what}: ${output(r)}`); }
function lastJSON(r) {
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
  assert.ok(lines.length, 'CLI must return nonempty JSON, not an empty-output success');
  return JSON.parse(lines.at(-1));
}
function proof(ctx, name, data) {
  const dir = ctx.rig.P('artifacts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(data, null, 2) + '\n');
  // Optional parent hook: keep this synthetic proof in the final report before scratch cleanup.
  if (typeof ctx.artifact === 'function') ctx.artifact(name, data);
}
async function effective(ctx) {
  const r = await ctx.cli(RESEARCH, ['config', '--sandbox', ctx.rig.sandbox, '--json']);
  succeeded(r, 'effective gateway config');
  assert.ok(r.stdout.trim(), 'effective config output is not empty');
  const config = JSON.parse(r.stdout);
  assert.equal(typeof config.search, 'object');
  return config;
}
function bytes(ctx) { return fs.readFileSync(ctx.worldFile); }
function unchanged(ctx, before, what) { assert.deepEqual(bytes(ctx), before, what); }
async function ownerSet(ctx, changes, options = {}) {
  return ctx.rig.owner(['config-set', '--sandbox', ctx.rig.sandbox, ...Object.entries(changes).map(([k, v]) => `${k}=${v}`)], options);
}
async function proposal(ctx, changes, by = 'J376 synthetic proposer') {
  const before = bytes(ctx), r = await ctx.cli(RELAY, ['propose-gateway', ctx.rig.sandbox, '--by', by, '--changes', JSON.stringify(changes)]);
  succeeded(r, 'propose-gateway');
  const result = lastJSON(r);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.id, /^[A-Za-z0-9._-]+--[0-9a-f]{6}$/);
  const held = ctx.pendingItems().find(p => p.id === result.id);
  assert.ok(held, 'proposal is an actual relay pending record');
  assert.equal(held.sandbox, ctx.rig.sandbox);
  assert.equal(held.reviewIn, ctx.rig.doorman);
  assert.equal(held.gatewayChange.sandbox, ctx.rig.sandbox);
  assert.deepEqual(held.gatewayChange.changes, changes);
  assert.match(held.gatewayChange.digest, /^[0-9a-f]{16}$/);
  unchanged(ctx, before, 'a proposal does not modify config before owner review');
  return held;
}
async function gatewayDecision(ctx, held, choice) {
  await ctx.decide(held.id, choice);
  // pending disappearance alone is NOT success: decide removes it before checking/applying.
  const log = await ctx.waitFor('durable gateway outcome ' + held.id, () => ctx.logs().find(l => l.op === 'gateway_change' && l.id === held.id));
  assert.equal(log.sandbox, ctx.rig.sandbox);
  assert.equal(log.decision, choice === '2' ? 'denied' : 'approved');
  assert.equal(typeof log.applied, 'boolean');
  assert.equal(typeof log.outcome, 'string');
  assert.ok(!ctx.pendingItems().some(p => p.id === held.id), 'decided proposal removed from the review queue');
  assert.equal(fs.existsSync(path.join(ctx.relayState, 'decisions', held.id + (choice === '2' ? '.deny' : '.approve'))), false, 'decision file consumed');
  proof(ctx, 'j372-' + held.id, { held, log, config: await effective(ctx), archive: 'durable gateway_change log; no separate proposal archive file exists' });
  return log;
}

export async function runConfig(ctx) {
  await ctx.feature('J372', [RESEARCH, 'docker/research/gateway.mjs', 'docker/research/gateway-admin.mjs', 'docker/agent-guard.mjs'], async () => {
    const baseline = ctx.readWorld();
    try {
      await ctx.testcase('J372: effective defaults from the real config CLI', async () => {
        ctx.writeWorld(w => { delete w.gateway; w.doorman = { ...w.doorman, mode: 'doorman-safe' }; w.access = 'safe'; return w; });
        const e = await effective(ctx);
        assert.equal(e.search.provider, 'sonar');
        assert.equal(e.search.quick_model, 'perplexity/perplexity/sonar');
        assert.equal(e.search.deep_model, 'perplexity/perplexity/sonar-deep-research');
        assert.equal(e.report_model, 'azure/openai/gpt-6-sol');
        assert.equal(e.doorman_model, '', 'no check-model override by default');
        assert.equal(e.mode, 'doorman-safe');
        assert.equal(e.level, 'safe');
        for (const key of ['search.provider', 'search.quick_model', 'search.deep_model', 'report_model']) assert.equal(e.sources[key], 'default');
        proof(ctx, 'j372-default-config', e);
      });

      await ctx.testcase('J372: config-set agent PTY and owner pipe are refused byte-identically', async () => {
        const before = bytes(ctx), results = [];
        for (const [options, why] of [[{ agent: true, pipe: false }, /agent/], [{ agent: false, pipe: true }, /no terminal/]]) {
          const r = await ownerSet(ctx, { report_model: 'fixture/forbidden-write', mode: 'doorman-open' }, options);
          assert.equal(r.status, 3, output(r));
          assert.match(output(r), /only Angus can change/);
          assert.match(output(r), why);
          unchanged(ctx, before, 'refused admin CLI leaves exact file bytes unchanged');
          results.push({ options, status: r.status, output: output(r) });
        }
        proof(ctx, 'j372-admin-refusals', { before_sha256: sha(before), after_sha256: sha(bytes(ctx)), results });
      });

      await ctx.testcase('J372: genuine owner PTY changes report, Doorman checks, mode and level', async () => {
        const before = ctx.readWorld(), changes = { report_model: 'fixture/owner-report', doorman_model: 'fixture/owner-doorman', mode: 'doorman-strict', level: 'strict' };
        const r = await ownerSet(ctx, changes, { agent: false, pipe: false });
        succeeded(r, 'owner config-set');
        assert.match(output(r), /Applied: research gateway settings/);
        const after = ctx.readWorld(), e = await effective(ctx);
        for (const [key, value] of Object.entries(changes)) { assert.equal(after.gateway[key], value); assert.equal(e[key], value); assert.equal(e.sources[key] || e.levelWhy, 'gateway.' + key); }
        const nonGateway = w => { const x = structuredClone(w); delete x.gateway; return x; };
        assert.deepEqual(nonGateway(after), nonGateway(before), 'admin CLI preserves task/sandbox and every unrelated world field');
        assert.equal(e.search.provider, 'sonar', 'configuration-only case does not switch search provider');
        proof(ctx, 'j372-owner-config', { changes, effective: e, status: r.status, output: output(r) });
      });

      await ctx.testcase('J372: legitimate proposal is held, guarded, approved once and logged', async () => {
        const changes = { report_model: 'fixture/approved-report', doorman_model: 'fixture/approved-doorman', mode: 'doorman-open', level: 'open' };
        const held = await proposal(ctx, changes, 'J376 proposer\u001b[2J');
        assert.match(held.text, /LOOSENS/);
        assert.doesNotMatch(held.text, /\u001b/);
        assert.equal(held.gatewayChange.before.mode, 'doorman-strict');
        assert.equal(held.gatewayChange.before.level, 'strict');
        const before = bytes(ctx), pendingFile = path.join(ctx.relayState, 'pending', held.id + '.json'), pendingBytes = fs.readFileSync(pendingFile);
        for (const options of [{ agent: true, pipe: false }, { agent: false, pipe: true }]) {
          const r = await ctx.rig.owner(['approve', held.id], options);
          assert.equal(r.status, 3, output(r));
          assert.match(output(r), /only Angus can approve/);
          unchanged(ctx, before, 'refused approval writes no config');
          assert.deepEqual(fs.readFileSync(pendingFile), pendingBytes, 'refused approval leaves proposal intact');
          assert.ok(!ctx.logs().some(l => l.op === 'gateway_change' && l.id === held.id), 'refusal creates no applied outcome');
        }
        const log = await gatewayDecision(ctx, held, '1');
        assert.equal(log.applied, true, log.outcome);
        assert.match(log.outcome, /^applied:/);
        const e = await effective(ctx);
        for (const [key, value] of Object.entries(changes)) assert.equal(e[key], value);
        const appliedBytes = bytes(ctx), again = await ctx.cli(RELAY, ['approve', held.id]);
        assert.equal(again.status, 1, output(again));
        assert.match(output(again), /no pending message/);
        unchanged(ctx, appliedBytes, 'a consumed proposal cannot be applied a second time');
        assert.equal(ctx.logs().filter(l => l.op === 'gateway_change' && l.id === held.id).length, 1);
      });

      await ctx.testcase('J372: deny archives an unapplied outcome without changing config', async () => {
        const held = await proposal(ctx, { report_model: 'fixture/denied-report' }), before = bytes(ctx);
        const log = await gatewayDecision(ctx, held, '2');
        assert.equal(log.applied, false);
        assert.equal(log.outcome, 'nothing changed');
        unchanged(ctx, before, 'denial leaves exact config bytes unchanged');
      });

      await ctx.testcase('J372: changed-since-proposal CAS fails closed and archives outcome', async () => {
        const held = await proposal(ctx, { report_model: 'fixture/stale-proposal' });
        const r = await ownerSet(ctx, { report_model: 'fixture/intervening-owner-write' });
        succeeded(r, 'intervening owner config-set');
        const before = bytes(ctx), log = await gatewayDecision(ctx, held, '1');
        assert.equal(log.applied, false);
        assert.match(log.outcome, /^not applied: report_model is now .* when proposed/);
        unchanged(ctx, before, 'stale approval cannot overwrite the newer owner setting');
        assert.equal((await effective(ctx)).report_model, 'fixture/intervening-owner-write');
      });

      await ctx.testcase('J372: payload and digest tampering are rejected and archived unapplied', async () => {
        for (const kind of ['payload', 'digest']) {
          const held = await proposal(ctx, { report_model: 'fixture/untampered-report' });
          const file = path.join(ctx.relayState, 'pending', held.id + '.json');
          const tampered = structuredClone(held);
          if (kind === 'payload') tampered.gatewayChange.changes.report_model = 'fixture/tampered-report'; // original digest/text unchanged
          else tampered.gatewayChange.digest = held.gatewayChange.digest === '0'.repeat(16) ? '1'.repeat(16) : '0'.repeat(16);
          fs.writeFileSync(file + '.test-tmp', JSON.stringify(tampered, null, 2));
          fs.renameSync(file + '.test-tmp', file);
          const before = bytes(ctx), log = await gatewayDecision(ctx, tampered, '1');
          assert.equal(log.applied, false);
          assert.equal(log.outcome, "not applied: the proposal doesn't match what was shown");
          unchanged(ctx, before, kind + ' tampering makes no config change');
        }
      });

      await ctx.testcase('J372: admin-only key, invalid mode and no-op cannot enter pending queue', async () => {
        for (const changes of [{ 'search.key_file': ctx.rig.P('config/not-a-key') }, { mode: 'invalid' }, { report_model: (await effective(ctx)).report_model }]) {
          const before = bytes(ctx), ids = ctx.pendingItems().map(p => p.id).sort();
          const r = await ctx.cli(RELAY, ['propose-gateway', ctx.rig.sandbox, '--changes', JSON.stringify(changes)]);
          assert.equal(r.status, 1, output(r));
          assert.equal(lastJSON(r).ok, false);
          unchanged(ctx, before, 'rejected proposal leaves config unchanged');
          assert.deepEqual(ctx.pendingItems().map(p => p.id).sort(), ids, 'rejected proposal creates no held item');
        }
      });
    } finally {
      await ctx.testcase('J372: restore original task and safe gateway baseline', async () => {
        ctx.writeWorld(() => structuredClone(baseline));
        assert.deepEqual(ctx.readWorld(), baseline);
        assert.equal((await effective(ctx)).mode, 'doorman-safe', 'later cases resume from fixture safe mode');
      });
    }
  });
}

const J373_FILES = ['docker/doorman/test-stateless.mjs', 'docker/doorman/doorman-rpc.mjs', 'docker/doorman/history.mjs'];
export async function runStateless(ctx) {
  await ctx.feature('J373', J373_FILES, async () => {
    await ctx.testcase('J373: real Pi/extension fresh sessions with local SSE fixture and captured requests', async () => {
      const dir = ctx.rig.P('artifacts/j373-fixture');
      fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
      // The rig provides regular executable bin/pi and bin/bash wrappers: real Pi, no login profiles.
      // test-stateless.mjs creates its own HOME under TMPDIR. Protected rig HOME/XDG/PATH remain unchanged.
      for (const command of ['pi', 'bash']) {
        const file = ctx.rig.P('bin', command), st = fs.lstatSync(file);
        assert.ok(st.isFile() && !st.isSymbolicLink(), 'J373 requires a regular scratch ' + command + ' wrapper');
      }
      const dump = path.join(dir, 'requests.jsonl'), env = { TMPDIR: path.join(dir, 'tmp'), PI_OFFLINE: '1', KEEP: '1', DUMP: dump };
      const n = 6, r = await ctx.cli(J373_FILES[0], [String(n)], { env, timeout: 450000 });
      fs.writeFileSync(path.join(dir, 'stdout.txt'), String(r.stdout || ''));
      fs.writeFileSync(path.join(dir, 'stderr.txt'), String(r.stderr || ''));
      assert.ok(r.stdout && r.stdout.trim(), 'stateless fixture must produce assertions, not empty output');
      const passLines = r.stdout.split('\n').filter(l => /^PASS\s+/.test(l));
      const requests = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      const questionCalls = requests.filter(q => q.messages?.at(-1)?.role !== 'tool');
      proof(ctx, 'j373-stateless-fixture', {
        status: r.status, n, assertions: passLines, stdout: r.stdout, stderr: r.stderr,
        requestCount: requests.length, questionCallCount: questionCalls.length,
        messagesPerQuestion: questionCalls.map(q => q.messages?.length), requests,
        scope: 'real Pi + real controller/extension; local fake SSE provider and stand-in relay, NOT the live integration relay',
      });
      succeeded(r, 'stateless fixture');
      assert.doesNotMatch(output(r), /(^|\n)FAIL\s|\d+ FAILED|timed out waiting/);
      assert.match(r.stdout, /(^|\n)all passed\s*$/);
      assert.ok(passLines.length >= 17, 'all expected fixture assertions must execute, including five tools, retry and refused-session restart');
      assert.ok(questionCalls.length >= n + 12, 'model request dump proves long run, five tool turns, retry, receipt followups and cancelled-session turn');
      assert.ok(questionCalls.every(q => q.messages?.length === 2), 'every question is system + one user envelope, including relay-supplied history');
      assert.ok(questionCalls.every(q => q.messages[0]?.role === 'system'), 'fresh sessions retain the system rules');
      assert.match(r.stdout, /one session file per message/);
      assert.match(r.stdout, /no receipt was delivered.*message of its own/);
    });
    await relayHistory(ctx);
  });
}

async function relayHistory(ctx) {
  await ctx.testcase('J373: actual relay isolates two signed same-sandbox askers and receipts', async () => {
    const baseline = ctx.readWorld(), captured = [];
    let held, receipt;
    const send = async (who, marker) => {
      const r = await ctx.ask('sandbox', { op: 'talk', to: ['sbx-' + ctx.rig.doorman], mode: 'demand', text: `[${who}, in world I] ${marker}` });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.request_id, 'worker peer talk returns a real daemon request ID');
      const item = await ctx.waitFor('actual Doorman message ' + marker, () => ctx.inbox('doorman').find(x => x.type === 'message' && x.request_id === r.request_id));
      assert.equal(item.from, ctx.rig.sandbox, 'asker source comes from the actual daemon, not fixture inbox seeding');
      captured.push(item);
      return item;
    };
    const reply = async item => {
      const r = await ctx.ask('doorman', { op: 'reply', request_id: item.request_id, text: 'RELAY-ANSWER-' + item.text });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.delivered, true, JSON.stringify(r));
    };
    const historyText = item => JSON.stringify(item.history || []);
    try {
      const a = await send('FixtureAlpha', 'RELAY-SECRET-ALPHA1');
      const draft = await ctx.ask('doorman', { op: 'task_change', task: 'RELAY-RECEIPT-ALPHA synthetic perovskite task', why: 'fixture receipt attribution', about: a.request_id });
      assert.equal(draft.ok, true, JSON.stringify(draft));
      held = ctx.holdFrom(draft);
      assert.equal(held.taskChange.sandbox, ctx.rig.sandbox);
      await reply(a);
      await ctx.decide(held.id, '1');
      receipt = await ctx.waitFor('actual relay task receipt ' + held.id, () => ctx.inbox('doorman').find(x => x.type === 'task_change' && x.id === held.id));
      assert.equal(receipt.status, 'applied');
      assert.match(receipt.outcome, /RELAY-RECEIPT-ALPHA/);
      const b = await send('FixtureBeta', 'RELAY-SECRET-BETA1');
      assert.doesNotMatch(historyText(b), /RELAY-SECRET-ALPHA1|RELAY-RECEIPT-ALPHA/);
      await reply(b);
      const a2 = await send('FixtureAlpha', 'RELAY-SECRET-ALPHA2');
      assert.match(historyText(a2), /RELAY-SECRET-ALPHA1/);
      assert.match(historyText(a2), /RELAY-ANSWER-/);
      assert.match(historyText(a2), /RELAY-RECEIPT-ALPHA/);
      assert.doesNotMatch(historyText(a2), /RELAY-SECRET-BETA1/);
      await reply(a2);
      const b2 = await send('FixtureBeta', 'RELAY-SECRET-BETA2');
      assert.match(historyText(b2), /RELAY-SECRET-BETA1/);
      assert.doesNotMatch(historyText(b2), /RELAY-SECRET-ALPHA|RELAY-RECEIPT-ALPHA/);
      await reply(b2);
    } finally {
      ctx.writeWorld(() => structuredClone(baseline));
      proof(ctx, 'j373-real-relay-history', { captured, receipt, held, scope: 'actual relay+private daemon+Docker outbox worker; checks signed-label history isolation through the real sandbox quoting envelope. Pi freshness and receipt omission are proven by the separate real-Pi fixture, not this worker.' });
    }
  });
}
