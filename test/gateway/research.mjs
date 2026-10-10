import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jsonLines } from './fixtures.mjs';

export async function runResearch(ctx) {
  const calls = () => jsonLines(ctx.rig.P('reader-calls.jsonl'));
  const plans = () => jsonLines(ctx.rig.P('doorman-calls.jsonl'));
  const setMode = mode => ctx.writeWorld(w => ({ ...w, gateway: { ...w.gateway, mode } }));
  const ask = async want => {
    const r = await ctx.ask('sandbox', { op: 'research', looking_for: want, from: 'Alpha', why: 'Synthetic end-to-end fixture', depth: 'quick' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.research, /^r[0-9a-f]{8}$/);
    return { result: r, held: await ctx.waitFor('research held for ' + r.research, () => ctx.pendingItems().find(x => x.research?.token === r.research)) };
  };
  const deliver = async held => {
    assert.equal(held.research.plan, undefined, 'the deliverable, not just its plan, waits for review');
    assert.match(held.text, /MODEL_REPORT_END/, 'the full deliverable is visible in the held record');
    const before = ctx.inbox('sandbox').filter(x => x.type === 'research' && x.token === held.research.token);
    assert.ok(!before.some(x => x.status === 'approved'), 'no delivery before review');
    await ctx.decide(held.id, '1');
    const receipt = await ctx.waitFor('approved research receipt', () => ctx.inbox('sandbox').find(x => x.type === 'research' && x.id === held.id && x.status === 'approved'));
    assert.ok(receipt.file.startsWith(ctx.rig.P('inbox') + path.sep), 'delivery stays in the fixture inbox');
    const md = fs.readFileSync(receipt.file, 'utf8');
    assert.match(md, /Web research approved by Angus/);
    assert.match(md, /MODEL_REPORT_END/, 'no tail truncation');
    assert.match(md, /## Sources\n\n- https:\/\/example\.org\/reference\n- https:\/\/example\.net\/legacy\n/);
    assert.equal((md.match(/https:\/\/example\.org\/reference/g) || []).length, 1, 'sources deduplicated');
    assert.doesNotMatch(md, /tracking=hidden|#anchor|http:|evil\.example|user:pass|javascript:|a b|FENCED_PAYLOAD_MUST_NOT_SURVIVE|<b>|\[1\]|\]\(https/);
    assert.ok(ctx.logs().some(x => x.op === 'research' && x.id === held.id && x.delivered), 'approval and delivery archived');
    return receipt;
  };
  await ctx.testcase('research: on-task safe request goes out, full cleaned deliverable waits, approval delivers', async () => {
    setMode('doorman-safe');
    const n = calls().length;
    const { held } = await ask('How does humidity degrade perovskite films?');
    assert.equal(calls().length, n + 1);
    assert.deepEqual(calls().at(-1).searches, ['moisture degradation of lead halide perovskite']);
    assert.equal(held.research.mode, 'doorman-safe');
    await deliver(held);
  });
  await ctx.testcase('research: off-task is held before any search; deny-with-reason reaches the asker', async () => {
    setMode('doorman-safe');
    const n = calls().length;
    const { result, held } = await ask('Why do sea otters hold paws while sleeping?');
    assert.equal(held.research.plan, true);
    assert.match(held.text, /Held as an exception[\s\S]*Task: Perovskite/);
    assert.equal(calls().length, n, 'off-task searches have not been sent');
    assert.ok(ctx.inbox('sandbox').some(x => x.token === result.research && x.status === 'planned' && x.exception === 'off-task'));
    await ctx.decide(held.id, '2', { note: 'outside the fixture task' });
    const denied = await ctx.waitFor('off-task deny reason', () => ctx.inbox('sandbox').find(x => x.id === held.id && x.status === 'denied'));
    assert.equal(denied.note, 'outside the fixture task');
    assert.match(denied.reason, /Angus's reason: outside the fixture task/);
    assert.equal(calls().length, n);
    await ctx.waitFor('denied plan removed', () => !fs.existsSync(ctx.rig.P('rstate/plans', held.research.rid + '.json')));
  });
  await ctx.testcase('research plan 1: strict approval runs the displayed searches once, then delivers after review', async () => {
    setMode('doorman-strict');
    const n = calls().length;
    const { held } = await ask('What limits stability in perovskite solar cells?');
    assert.equal(held.research.plan, true);
    assert.equal(calls().length, n);
    const pendingFile = path.join(ctx.relayState, 'pending', held.id + '.json');
    // Relay startup may add notif:null while re-showing a hold. That UI-only metadata is independent of the guard probe.
    const decisionPayload = text => { const value = JSON.parse(text); delete value.notif; return value; };
    const before = decisionPayload(fs.readFileSync(pendingFile, 'utf8'));
    for (const probe of [{ agent: true }, { pipe: true }]) {
      const refused = await ctx.rig.owner(['approve', held.id], probe);
      assert.equal(refused.status, 3, refused.stdout + refused.stderr);
      assert.match(refused.stdout + refused.stderr, /only Angus/);
      assert.deepEqual(decisionPayload(fs.readFileSync(pendingFile, 'utf8')), before, 'refused guard probe leaves the whole decision payload unchanged');
      assert.equal(calls().length, n);
    }
    await ctx.decide(held.id, '1');
    const result = await ctx.waitFor('strict deliverable', () => ctx.pendingItems().find(x => x.research?.token === held.research.token && !x.research.plan));
    assert.equal(calls().length, n + 1);
    assert.deepEqual(calls().at(-1).searches, held.research.searches);
    assert.ok(ctx.logs().some(x => x.op === 'research-plan' && x.id === held.id && x.decision === 'approved'));
    await deliver(result);
    assert.equal(calls().length, n + 1, 'reviewing a result does not run searches again');
  });
  await ctx.testcase('research plan 2: plain denial sends nothing and consumes the plan', async () => {
    setMode('doorman-strict');
    const n = calls().length;
    const { held } = await ask('Which treatments improve perovskite stability?');
    await ctx.decide(held.id, '2');
    await ctx.waitFor('plain denied plan receipt', () => ctx.inbox('sandbox').find(x => x.id === held.id && x.status === 'denied'));
    assert.equal(calls().length, n);
    await ctx.waitFor('plain denied plan removed', () => !fs.existsSync(ctx.rig.P('rstate/plans', held.research.rid + '.json')));
    assert.ok(ctx.logs().some(x => x.id === held.id && x.op === 'research-plan' && x.sent === false));
  });
  await ctx.testcase('research plan e: approval sends the checked edited version, archiving both versions', async () => {
    setMode('doorman-strict');
    const { held } = await ask('How can perovskite devices resist moisture?');
    const edited = 'water ingress and encapsulation of perovskite modules';
    const n = calls().length;
    await ctx.decide(held.id, 'e', { edit: edited + '\n' });
    const result = await ctx.waitFor('edited-plan deliverable', () => ctx.pendingItems().find(x => x.research?.token === held.research.token && !x.research.plan));
    assert.equal(calls().length, n + 1);
    assert.deepEqual(calls().at(-1).searches, [edited]);
    const archive = ctx.logs().find(x => x.op === 'edit' && x.id === held.id && x.applied);
    assert.ok(archive, 'applied edit is archived');
    assert.deepEqual(archive.original, held.research.searches);
    assert.deepEqual(archive.edited, [edited]);
    await deliver(result);
  });
  await ctx.testcase('research plan r: note reaches a fresh replan; revision remains held and old plan cannot run', async () => {
    setMode('doorman-strict');
    const { held } = await ask('What determines perovskite film lifetime?');
    const n = calls().length, note = 'focus on encapsulation instead';
    await ctx.decide(held.id, 'r', { note });
    const receipt = await ctx.waitFor('returned plan receipt', () => ctx.inbox('sandbox').find(x => x.id === held.id && x.status === 'returned'));
    assert.equal(receipt.note, note);
    const revision = await ctx.waitFor('revised held plan', () => ctx.pendingItems().find(x => x.revises === held.id));
    assert.equal(revision.revisesNote, note);
    assert.equal(revision.research.plan, true);
    assert.notEqual(revision.research.rid, held.research.rid);
    assert.equal(calls().length, n, 'return never authorizes the searches');
    assert.ok(plans().some(x => x.owner_note === note && Array.isArray(x.previous)), 'owner note and prior searches supplied to the stateless check');
    assert.equal(fs.existsSync(ctx.rig.P('rstate/plans', held.research.rid + '.json')), false);
    assert.ok(ctx.logs().some(x => x.id === held.id && x.decision === 'returned' && x.sent === false));
    await ctx.decide(revision.id, '2');
    assert.equal(calls().length, n);
  });
  setMode('doorman-safe');
}
