// J376: full subprocess/relay checks for J372, and J373/J395 (no-memory Doorman: real-Pi fixture + real relay asker binding).
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

// J373 + J395: the Doorman has NO memory at all (Angus chose "c": no relay-supplied history either). history.mjs was deleted by J395,
// so it is not a feature dependency. The real-Pi fixture proves fresh sessions; the relay cases prove the asker binding that replaced memory.
const J373_FILES = ['docker/doorman/test-stateless.mjs', 'docker/doorman/doorman-rpc.mjs', 'docker/sbx-dropbox-ext.ts'];
const FIXTURE_PASS_MIN = 16; // the J395 builder fixture's own PASS lines (its no-memory rewrite has 16)
export async function runStateless(ctx) {
  await ctx.feature('J373', J373_FILES, async () => {
    await statelessFixture(ctx);
    await relayBinding(ctx);
  });
}

const msgText = m => typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map(x => x?.text || '').join('') : '';
async function statelessFixture(ctx) {
  await ctx.testcase('J373/J395: real Pi/extension fresh sessions; every captured question is [system, one incoming message]', async () => {
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
    const passLines = String(r.stdout || '').split('\n').filter(l => /^PASS\s+/.test(l));
    const requests = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const questionCalls = requests.filter(q => q.messages?.at(-1)?.role !== 'tool');
    const incoming = q => (q.messages || []).filter(m => m.role === 'user').map(msgText).join('\n');
    const markers = q => incoming(q).match(/SECRET-[A-Z0-9]+/g) || [];
    const callWith = marker => questionCalls.filter(q => incoming(q).includes(marker));
    // Explicit request-level checks over the captured model requests (independent of the fixture's own PASS lines).
    const checks = [];
    const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); };
    check('every question call is exactly [system, user]', questionCalls.length && questionCalls.every(q => q.messages?.length === 2 && q.messages[0]?.role === 'system' && q.messages[1]?.role === 'user'), questionCalls.map(q => (q.messages || []).map(m => m.role).join('+')));
    check('every system message carries the Doorman rules', questionCalls.every(q => /test Doorman/.test(msgText(q.messages[0]))));
    check('every incoming message is the relay-quoted drop-box envelope', questionCalls.every(q => /via the drop-box relay/.test(incoming(q))));
    check('no question call carries any marker but its own', questionCalls.every(q => new Set(markers(q)).size <= 1));
    const b1 = callWith('SECRET-BETA1'), a2 = callWith('SECRET-ALPHA2'), a3 = callWith('SECRET-ALPHA3'), b3 = callWith('SECRET-BETA3');
    check('cross-asker: Beta\'s question holds nothing of Alpha (text, id, answer)', b1.length && b1.every(q => !/SECRET-ALPHA1|rid-a(?![0-9])|answer about/.test(JSON.stringify(q.messages))));
    check('same-asker: Alpha\'s second question holds neither its own first question/answer nor Beta\'s', a2.length && a2.every(q => !/SECRET-ALPHA1|SECRET-BETA1|answer about SECRET|rid-a(?![0-9])|rid-b/.test(JSON.stringify(q.messages))));
    check('receipt omission: no request anywhere carries the task-change receipt', requests.length && !requests.some(q => JSON.stringify(q.messages || []).includes('SECRET-TASK')));
    check('receipt omission: the next questions of both askers carry no receipt or earlier marker', a3.length && b3.length && [...a3, ...b3].every(q => !/SECRET-TASK|SECRET-ALPHA[12]|SECRET-BETA1/.test(JSON.stringify(q.messages))));
    check('no Angus/receipt turn was given to the model as a message of its own', !questionCalls.some(q => /\[hyprpi\] Angus/.test(incoming(q))));
    check('transient retry: the FLAKY question was sent again as the same [system, user] turn', callWith('FLAKY-1').length >= 2 && callWith('FLAKY-1').every(q => q.messages?.length === 2));
    check('long run plus tools, retry, receipt followups and cancelled-session turn all reached the model', questionCalls.length >= n + 12, questionCalls.length);
    proof(ctx, 'j373-stateless-fixture', {
      status: r.status, n, assertions: passLines, checks, stdout: r.stdout, stderr: r.stderr,
      requestCount: requests.length, questionCallCount: questionCalls.length,
      messagesPerQuestion: questionCalls.map(q => q.messages?.length), requests,
      scope: 'real installed Pi + real doorman-rpc controller + real drop-box extension; local fake SSE provider and stand-in relay, NOT the live integration relay',
    });
    assert.ok(r.stdout && r.stdout.trim(), 'stateless fixture must produce assertions, not empty output');
    succeeded(r, 'stateless fixture');
    assert.doesNotMatch(output(r), /(^|\n)FAIL\s|\d+ FAILED|timed out waiting/);
    assert.match(r.stdout, /(^|\n)all passed\s*$/);
    assert.ok(passLines.length >= FIXTURE_PASS_MIN, `all ${FIXTURE_PASS_MIN} J395 fixture assertions must execute (got ${passLines.length})`);
    assert.match(r.stdout, /one session file per message/);
    assert.match(r.stdout, /after a transient error and pi's retry/, 'transient retry assertion executed');
    assert.match(r.stdout, /a cancelled new session ends pi/, 'refused-session restart assertion executed');
    assert.match(r.stdout, /no receipt was delivered.*message of its own/);
    for (const c of checks) assert.ok(c.ok, 'request-level check failed: ' + c.name + (c.detail === undefined ? '' : ' ' + JSON.stringify(c.detail)));
    assert.ok(passLines.length + checks.length >= 17, 'fixture plus explicit request checks cover at least 17 assertions');
  });
}

// --- J395 through the ACTUAL relay: Docker worker -> private daemon -> Doorman. No model runs: the "Doorman" acts through its real drop-box.
// A signed message carries no history; a draft/task_change/request names the message it answers (about) and is bound to that message's
// signed asker, even when the model's "for" is wrong and even after the reply consumed the delivered ID. Outcomes are the relay's real
// served-inbox envelopes ("Asker: [Outside] …" plus the unprefixed coordinator line), decided through the genuine owner PTY.
const MARK = /RELAY-SECRET-[A-Z0-9]+/g;
async function signed(ctx, who, marker, seen) {
  const r = await ctx.ask('sandbox', { op: 'talk', to: ['sbx-' + ctx.rig.doorman], mode: 'demand', text: `[${who}, in world I] ${marker}` });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.request_id, 'worker peer talk returns a real daemon request ID');
  const item = await ctx.waitFor('actual Doorman message ' + marker, () => ctx.inbox('doorman').find(x => x.type === 'message' && x.request_id === r.request_id));
  assert.equal(item.from, ctx.rig.sandbox, 'asker source comes from the actual daemon, not fixture inbox seeding');
  assert.equal(item.history, undefined, 'J395: the relay envelope carries no history field');
  assert.deepEqual(Object.keys(item).filter(k => !['v', 'type', 'mode', 'from', 'request_id', 'text'].includes(k)), [], 'no extra (history/context) field in the envelope');
  assert.ok(String(item.text).startsWith(`🐳 [sandboxed: ${ctx.rig.sandbox}] (message from a sandboxed agent`), 'real relay quoting envelope');
  assert.ok(String(item.text).includes(`🐳│ [${who}, in world I] ${marker}`), 'the sandbox\'s signature reaches the Doorman inside the quote');
  assert.deepEqual(String(item.text).match(MARK), [marker], 'no other asker\'s (or own earlier) message rides along');
  for (const earlier of seen) assert.ok(!String(item.text).includes(earlier.request_id), 'no earlier request ID in the envelope');
  seen.push(item);
  return item;
}
async function answer(ctx, item) {
  const r = await ctx.ask('doorman', { op: 'reply', request_id: item.request_id, text: 'RELAY-ANSWER for ' + item.request_id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.delivered, true, JSON.stringify(r));
  const again = await ctx.ask('doorman', { op: 'reply', request_id: item.request_id, text: 'second reply must be refused' });
  assert.notEqual(again.ok, true, 'the reply consumed the delivered ID: ' + JSON.stringify(again));
  assert.match(JSON.stringify(again), /unknown request_id/);
}
// The relay's real served-inbox envelopes for this held ID: one addressed to the bound asker, one unprefixed to the coordinator.
async function envelopes(ctx, id, asker, wrong, contains) {
  const got = await ctx.waitFor('bound asker + coordinator outcome for ' + id, () => {
    const mine = ctx.inbox('sandbox').filter(x => x.type === 'message' && x.from === 'Outside' && typeof x.text === 'string' && x.text.includes(id));
    const toAsker = mine.find(x => x.text.startsWith(asker + ': [Outside] ') && contains.test(x.text));
    const toCoordinator = mine.find(x => x.text.startsWith('[Outside] ') && contains.test(x.text) && x.text.endsWith(`(asked by ${asker})`));
    return toAsker && toCoordinator ? { mine, toAsker, toCoordinator } : false;
  });
  assert.equal(got.toAsker.mode, 'talk'); assert.equal(got.toCoordinator.mode, 'talk');
  assert.equal(got.toAsker.request_id, ''); assert.equal(got.toCoordinator.request_id, '');
  assert.equal(got.mine.filter(x => /^[^\s:\[]{1,60}: \[Outside\] /.test(x.text)).length, 1, 'exactly one addressed envelope: ' + JSON.stringify(got.mine));
  assert.ok(!got.mine.some(x => x.text.startsWith(wrong + ': ') || x.text.includes(`asked by ${wrong}`)), 'never addressed to the model-chosen name ' + wrong);
  return got;
}
async function relayBinding(ctx) {
  const baseline = ctx.readWorld(), evidence = { cases: {} };
  const relayCase = (name, fn) => ctx.testcase(name, async () => {
    const seen = [], held = [];
    const rec = evidence.cases[name] = { seen, held };
    try { await fn({ seen, held, rec }); }
    finally {
      for (const h of held) if (ctx.pendingItems().some(p => p.id === h.id)) await ctx.decide(h.id, '2'); // never leave a hold behind
      rec.leftPending = held.filter(h => ctx.pendingItems().some(p => p.id === h.id)).map(h => h.id);
    }
  });
  try {
    // Prior cases may leave the bridge on. Agent-free host first: task_change and typed requests are valid there, free-form drafts are not.
    await ctx.restartRelay({ hostAgents: false });

    await relayCase('J395 relay: approved task_change after the reply is bound to the signed asker, not the model\'s for', async ({ seen, held, rec }) => {
      const a = await signed(ctx, 'FixtureAlpha', 'RELAY-SECRET-ALPHA1', seen);
      const b = await signed(ctx, 'FixtureBeta', 'RELAY-SECRET-BETA1', seen);
      await answer(ctx, a); await answer(ctx, b);
      const task = 'RELAY-TASK-ALPHA synthetic perovskite task';
      const draft = await ctx.ask('doorman', { op: 'task_change', task, why: 'J395 binding fixture', for: 'FixtureBeta', about: a.request_id });
      assert.equal(draft.ok, true, JSON.stringify(draft));
      const h = ctx.holdFrom(draft); held.push(h); rec.hold = h;
      assert.equal(h.taskChange.sandbox, ctx.rig.sandbox);
      assert.equal(h.taskChange.for, 'FixtureAlpha', 'bound by about to the asker of the message it answers, not the model\'s for');
      await ctx.decide(h.id, '1');
      const log = await ctx.waitFor('durable task_change log ' + h.id, () => ctx.logs().find(l => l.op === 'task_change' && l.id === h.id));
      assert.equal(log.decision, 'approved'); assert.equal(log.applied, true, log.outcome);
      const receipt = await ctx.waitFor('Doorman task receipt ' + h.id, () => ctx.inbox('doorman').find(x => x.type === 'task_change' && x.id === h.id));
      assert.equal(receipt.status, 'applied');
      assert.equal(ctx.readWorld().task, task, 'the approval actually wrote the task');
      rec.log = log; rec.receipt = receipt;
      rec.envelopes = await envelopes(ctx, h.id, 'FixtureAlpha', 'FixtureBeta', /approved the research task change/);
      // A later signed message gets no receipt or earlier history either.
      const a2 = await signed(ctx, 'FixtureAlpha', 'RELAY-SECRET-ALPHA2', seen);
      assert.doesNotMatch(a2.text, /RELAY-TASK-ALPHA|RELAY-ANSWER|RELAY-SECRET-ALPHA1|RELAY-SECRET-BETA1/);
      await answer(ctx, a2);
    });

    for (const [choice, decision] of [['1', 'approved'], ['2', 'denied']]) {
      await relayCase(`J395 relay: ${decision} typed request is bound to the signed asker, not a wrong for`, async ({ seen, held, rec }) => {
        const b = await signed(ctx, 'FixtureBeta', 'RELAY-SECRET-BETA' + (choice === '1' ? 'T1' : 'T2'), seen);
        const a = await signed(ctx, 'FixtureAlpha', 'RELAY-SECRET-ALPHA' + (choice === '1' ? 'T1' : 'T2'), seen);
        await answer(ctx, b); await answer(ctx, a);
        const draft = await ctx.ask('doorman', { op: 'request', type: 'share_project', for: 'WrongModelName', about: b.request_id, params: { project: 'fixture', mode: 'ro', why: `J395 synthetic (${decision}): a fixed type that is held in safe (J412: notes are auto)` } });
        assert.equal(draft.ok, true, JSON.stringify(draft));
        const h = ctx.holdFrom(draft); held.push(h); rec.hold = h;
        assert.equal(h.typed.for, 'FixtureBeta', 'typed request bound to the real asker');
        assert.equal(h.typed.sandbox, ctx.rig.sandbox);
        await ctx.decide(h.id, choice);
        const log = await ctx.waitFor('durable typed log ' + h.id, () => ctx.logs().find(l => l.op === 'typed' && l.id === h.id));
        assert.equal(log.decision, decision);
        assert.equal(log.ok, choice === '1', 'approved deterministic note must complete; denial executes nothing');
        const note = await ctx.waitFor('Doorman typed receipt ' + h.id, () => ctx.inbox('doorman').find(x => x.type === 'typed' && x.id === h.id));
        assert.equal(note.status, choice === '1' ? 'done' : 'denied');
        rec.log = log; rec.receipt = note;
        rec.envelopes = await envelopes(ctx, h.id, 'FixtureBeta', 'WrongModelName', new RegExp(`Angus ${decision} the request`));
        assert.ok(!rec.envelopes.mine.some(x => x.text.startsWith('FixtureAlpha: ')), 'the other signed asker is not told');
      });
    }

    // A free-form draft needs a host agent: switch the scratch relay's fixture flag to the bridge (no real host agent starts), deny only.
    await ctx.restartRelay({ hostAgents: 'bridge' });
    await relayCase('J395 relay: denied free-form draft is bound via about to the signed asker after the reply', async ({ seen, held, rec }) => {
      const a = await signed(ctx, 'FixtureAlpha', 'RELAY-SECRET-ALPHAD', seen);
      const b = await signed(ctx, 'FixtureBeta', 'RELAY-SECRET-BETAD', seen);
      await answer(ctx, a); await answer(ctx, b);
      const draft = await ctx.ask('doorman', { op: 'draft', for: 'FixtureBeta', about: a.request_id, why: 'J395 binding fixture', tried: 'nothing', action: 'Synthetic denied action; never execute' });
      assert.equal(draft.ok, true, JSON.stringify(draft));
      const h = ctx.holdFrom(draft); held.push(h); rec.hold = h;
      assert.equal(h.draftFor, 'FixtureAlpha', 'draft bound to the real asker, not the model\'s for');
      assert.match(h.text, /drafted by .* for FixtureAlpha\./);
      await ctx.decide(h.id, '2');
      const log = await ctx.waitFor('durable draft decision ' + h.id, () => ctx.logs().find(l => l.id === h.id && l.decision === 'denied'));
      rec.log = log;
      rec.envelopes = await envelopes(ctx, h.id, 'FixtureAlpha', 'FixtureBeta', /Angus denied the request drafted for you/);
    });
  } finally {
    await ctx.testcase('J395 relay: restore agent-free relay and original fixture world; no hold left', async () => {
      await ctx.restartRelay({ hostAgents: false });
      ctx.writeWorld(() => structuredClone(baseline));
      assert.deepEqual(ctx.readWorld(), baseline);
      const left = Object.values(evidence.cases).flatMap(c => c.held.map(h => h.id)).filter(id => ctx.pendingItems().some(p => p.id === id));
      assert.deepEqual(left, [], 'every hold this module made is decided');
      proof(ctx, 'j395-real-relay-binding', { ...evidence, scope: 'actual relay + private daemon + Docker worker outbox; owner decisions via the genuine PTY; outcomes read from the served sandbox inbox and the durable relay log. No model, no host agent, no forged events or history.' });
    });
  }
}
