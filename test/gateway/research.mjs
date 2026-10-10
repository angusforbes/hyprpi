// J412 (simplification spec v3, ~/Obsidian/Papers/Doorman/simplification-spec.md, sections 1.4, 1.8, 2.3, 2.2, 3):
// the research pipeline under the ONE dial (strict / safe / open / yolo) in the real private relay + research runner (synthetic doorman and reader).
// Parts: dial + host are present on this branch; every case that needs the new decision keys (1, "1 text", 1+, 2 with the send-back receipt) goes
// through ctx.whenPart('keys', ...): PENDING until they land, never silently skipped, and the old e / r positives are gone.
// Hourly limits of the research runner (docker/research/research.mjs LIMITS): 10 quick requests and 3 off-task/no-task "exceptions" per sandbox
// per hour, counted in <rstate>/caps.json and <rstate>/exceptions.json. The suite stays under both inside each segment and, where a segment needs
// a fresh budget, resets exactly those two files in this rig's own scratch research state (freshLimits); the final case proves the 4th exception
// is refused. Mode and task are restored, and every held item this file creates is cleared, at the end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jsonLines, TASK } from './fixtures.mjs';

export async function runResearch(ctx) {
  const calls = () => jsonLines(ctx.rig.P('reader-calls.jsonl'));
  const plans = () => jsonLines(ctx.rig.P('doorman-calls.jsonl'));
  const rlog = () => jsonLines(ctx.rig.P('rstate/log.jsonl'));
  const setMode = mode => ctx.writeWorld(w => ({ ...w, gateway: { ...w.gateway, mode } }));
  const keysReady = () => !!ctx.parts?.keys;
  // Parent supplies ctx.whenPart; this fallback only keeps the file runnable on its own (same contract: unavailable → PENDING, ready → testcase).
  const whenPart = ctx.whenPart || ((part, name, fn) => (ctx.parts?.[part] ? ctx.testcase(name, fn) : ctx.pending(name, `${part} part has not landed`)));
  const freshLimits = () => { for (const f of ['caps.json', 'exceptions.json']) fs.rmSync(ctx.rig.P('rstate', f), { force: true }); };
  const exceptionsUsed = () => { try { return (JSON.parse(fs.readFileSync(ctx.rig.P('rstate/exceptions.json'), 'utf8'))[ctx.rig.sandbox] || []).length; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
  const items = token => ctx.pendingItems().filter(x => x.research?.token === token);
  const inboxOf = token => ctx.inbox('sandbox').filter(x => x.type === 'research' && x.token === token);
  const OUTCOMES = ['planned', 'held', 'refused', 'error', 'delivered-open'];
  const start = async want => {
    const r = await ctx.ask('sandbox', { op: 'research', looking_for: want, from: 'Alpha', why: 'Synthetic end-to-end fixture', depth: 'quick' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.research, /^r[0-9a-f]{8}$/);
    return r.research;
  };
  const outcome = async (token, label = 'first outcome') => ctx.waitFor(`research ${label} for ${token}`, () => inboxOf(token).find(x => OUTCOMES.includes(x.status)));
  // ask → the pending item (plan, exception or summary) the relay holds for Angus
  const ask = async want => {
    const token = await start(want);
    return { result: { research: token }, held: await ctx.waitFor('research held for ' + token, () => items(token)[0]) };
  };
  const cleanBody = md => {
    assert.match(md, /MODEL_REPORT_END/, 'no tail truncation');
    assert.match(md, /## Sources\n\n- https:\/\/example\.org\/reference\n- https:\/\/example\.net\/legacy\n/);
    assert.equal((md.match(/https:\/\/example\.org\/reference/g) || []).length, 1, 'sources deduplicated');
    assert.doesNotMatch(md, /tracking=hidden|#anchor|http:|evil\.example|user:pass|javascript:|a b|FENCED_PAYLOAD_MUST_NOT_SURVIVE|<b>|\[1\]|\]\(https/);
  };
  const deliver = async (held, { note } = {}) => {
    assert.equal(held.research.plan, undefined, 'the deliverable, not just its plan, waits for review');
    assert.match(held.text, /MODEL_REPORT_END/, 'the full deliverable is visible in the held record');
    const before = ctx.inbox('sandbox').filter(x => x.type === 'research' && x.token === held.research.token);
    assert.ok(!before.some(x => x.status === 'approved'), 'no delivery before review');
    await ctx.decide(held.id, '1', note ? { note } : {});
    const receipt = await ctx.waitFor('approved research receipt', () => ctx.inbox('sandbox').find(x => x.type === 'research' && x.id === held.id && x.status === 'approved'));
    assert.ok(receipt.file.startsWith(ctx.rig.P('inbox') + path.sep), 'delivery stays in the fixture inbox');
    const md = fs.readFileSync(receipt.file, 'utf8');
    assert.match(md, /Web research approved by Angus/);
    assert.doesNotMatch(md, /NOT reviewed/, 'a reviewed summary is never labelled unreviewed');
    cleanBody(md);
    assert.ok(ctx.logs().some(x => x.op === 'research' && x.id === held.id && x.delivered), 'approval and delivery archived');
    if (note) assert.match(JSON.stringify(receipt), new RegExp('Note from Angus[\\s\\S]*' + note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the note reaches the asking agent inside the approval receipt');
    return receipt;
  };
  // a held summary the test does not want delivered: deny it and prove nothing was delivered
  const dropSummary = async held => {
    assert.equal(held.research.plan, undefined, 'dropSummary is for summaries');
    await ctx.decide(held.id, '2');
    await ctx.waitFor('summary denial receipt', () => inboxOf(held.research.token).find(x => x.status === 'denied'));
    assert.ok(!inboxOf(held.research.token).some(x => ['approved', 'delivered-open'].includes(x.status)), 'a denied summary is never delivered');
  };
  const restoreFixture = () => { setMode('safe'); ctx.writeWorld(w => ({ ...w, task: TASK })); };
  const clearHeld = async () => { for (const x of ctx.pendingItems().filter(i => i.research && i.sandbox === ctx.rig.sandbox)) await ctx.decide(x.id, '2'); };
  const dailyCount = async () => {
    const r = await ctx.cli('docker/research/research.mjs', ['digest', '--daily', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const SEARCH_ON = ['moisture degradation of lead halide perovskite'], SEARCH_OFF = ['sea otter social bonding observations'];
  const OFF = 'Why do sea otters hold paws while sleeping?', ON = 'How does humidity degrade perovskite films?';

  try {
    freshLimits();
    setMode('safe');
    // ---------------- segment A: safe and strict (<= 10 quick requests, <= 3 exceptions) ----------------
    await ctx.testcase('research (safe): on-task plan goes out unheld; only the summary waits (in the panel, not the window); approval delivers', async () => {
      setMode('safe');
      const n = calls().length, pn = plans().length;
      const { held, result } = await ask('How does humidity degrade perovskite films?');
      assert.equal(calls().length, n + 1);
      assert.deepEqual(calls().at(-1).searches, SEARCH_ON);
      assert.equal(held.research.mode, 'safe');
      assert.equal(held.reviewIn, undefined, 'safe decides in the panel; only open routes to the Doorman window');
      assert.ok(!inboxOf(result.research).some(x => x.status === 'planned'), 'safe never holds an on-task plan');
      assert.ok(!rlog().some(x => x.ev === 'flagged' && x.looking_for === ON), 'an on-task request is not flagged');
      const modes = plans().slice(pn).map(x => x.mode);
      assert.deepEqual(modes, ['plan', 'deliverable'], 'the Doorman wrote the plan and vetted the result');
      await deliver(held);
    });
    await ctx.testcase('research (safe): off-task is a held exception before any search; the denial reaches the asker', async () => {
      setMode('safe');
      const n = calls().length;
      const { result, held } = await ask('Why do sea otters hold paws while sleeping?');
      assert.equal(held.research.plan, true);
      assert.equal(held.research.mode, 'safe');
      assert.equal(held.reviewIn, undefined);
      assert.match(held.research.exception, /unrelated to this sandbox's task/);
      assert.match(held.text, /Held as an exception[\s\S]*Task: Perovskite/);
      assert.equal(calls().length, n, 'off-task searches have not been sent');
      assert.ok(inboxOf(result.research).some(x => x.status === 'planned' && x.exception === 'off-task'));
      await ctx.decide(held.id, '2', { note: 'outside the fixture task' });
      const denied = await ctx.waitFor('off-task deny reason', () => ctx.inbox('sandbox').find(x => x.id === held.id && x.status === 'denied'));
      if (keysReady()) { // spec 2.3: the asker always hears it was denied, why it was held, Angus's text, and what to do next
        assert.match(denied.text, /Angus denied/);
        assert.match(denied.text, /Why it was held/);
        assert.ok(denied.text.includes(held.research.exception), 'the actual off-task exception is carried verbatim in the denial');
        assert.match(denied.text, /Note from Angus[\s\S]*outside the fixture task/);
        assert.match(denied.text, /Revise it and send again, or drop it\./);
      } else {
        assert.equal(denied.note, 'outside the fixture task');
        assert.match(denied.reason, /Angus's reason: outside the fixture task/);
      }
      assert.equal(calls().length, n);
      await ctx.waitFor('denied plan removed', () => !fs.existsSync(ctx.rig.P('rstate/plans', held.research.rid + '.json')));
    });
    await ctx.testcase('research (safe): no task set is a held exception ("no-task"); the task is restored afterwards', async () => {
      setMode('safe');
      ctx.writeWorld(w => { const { task, ...rest } = w; return rest; });
      try {
        const n = calls().length;
        const { result, held } = await ask(ON);
        assert.equal(held.research.plan, true);
        assert.match(held.research.exception, /^no task is set for this sandbox/);
        assert.match(held.text, /Held as an exception: no task is set[\s\S]*Task: \(none set\)/);
        assert.equal(calls().length, n, 'nothing was searched without a task');
        assert.ok(inboxOf(result.research).some(x => x.status === 'planned' && x.exception === 'no-task'));
        await ctx.decide(held.id, '2');
        await ctx.waitFor('no-task plan receipt', () => inboxOf(result.research).find(x => x.status === 'denied'));
        assert.equal(calls().length, n);
        await ctx.waitFor('no-task plan removed', () => !fs.existsSync(ctx.rig.P('rstate/plans', held.research.rid + '.json')));
      } finally { ctx.writeWorld(w => ({ ...w, task: TASK })); }
      assert.equal(ctx.readWorld().task, TASK);
    });
    await ctx.testcase('research (strict): every plan waits, an off-task one as an exception with the task beside it; denial sends nothing', async () => {
      setMode('strict');
      const n = calls().length, pn = plans().length;
      const { result, held } = await ask('Why do sea otters hold paws while sleeping?');
      assert.equal(held.research.plan, true);
      assert.equal(held.research.mode, 'strict');
      assert.equal(held.reviewIn, undefined, 'strict decides in the panel');
      assert.match(held.research.exception, /unrelated to this sandbox's task/);
      assert.match(held.text, /Held as an exception[\s\S]*Task: Perovskite/);
      assert.deepEqual(held.research.searches, SEARCH_OFF);
      assert.deepEqual(plans().slice(pn).map(x => x.mode), ['plan'], 'only the plan check ran; no search, no vet');
      assert.equal(calls().length, n);
      assert.ok(inboxOf(result.research).some(x => x.status === 'planned' && x.exception === 'off-task'));
      await ctx.decide(held.id, '2');
      await ctx.waitFor('strict off-task plan denied', () => inboxOf(result.research).find(x => x.status === 'denied'));
      assert.equal(calls().length, n);
      await ctx.waitFor('strict off-task plan removed', () => !fs.existsSync(ctx.rig.P('rstate/plans', held.research.rid + '.json')));
    });
    await ctx.testcase('research plan 1 (strict): approval runs the displayed searches once, then delivers after review', async () => {
      setMode('strict');
      const n = calls().length;
      const { held } = await ask('What limits stability in perovskite solar cells?');
      assert.equal(held.research.plan, true);
      assert.equal(held.research.mode, 'strict');
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
    await ctx.testcase('research plan 2 (strict): plain denial sends nothing and consumes the plan', async () => {
      setMode('strict');
      const n = calls().length;
      const { held } = await ask('Which treatments improve perovskite stability?');
      await ctx.decide(held.id, '2');
      await ctx.waitFor('plain denied plan receipt', () => ctx.inbox('sandbox').find(x => x.id === held.id && x.status === 'denied'));
      assert.equal(calls().length, n);
      await ctx.waitFor('plain denied plan removed', () => !fs.existsSync(ctx.rig.P('rstate/plans', held.research.rid + '.json')));
      assert.ok(ctx.logs().some(x => x.id === held.id && x.op === 'research-plan' && x.sent === false));
    });

    // ---- keys-only cases (spec 2.2, 2.3, 2.1): replace the old e / r positives ----
    await whenPart('keys', 'research plan 2 (v3, strict): "2 text" sends the plan back with the hold reason, the note and a checked suggestion; nothing runs, nothing is re-planned into the pipeline', async () => {
      setMode('strict');
      const { held } = await ask('How can perovskite devices resist moisture?');
      const n = calls().length, pn = plans().length, note = 'focus on encapsulation instead';
      await ctx.decide(held.id, '2', { note });
      const receipt = await ctx.waitFor('send-back receipt', () => ctx.inbox('sandbox').find(x => x.type === 'research' && x.id === held.id && x.status === 'denied'));
      assert.match(receipt.text, /Angus denied/);
      assert.match(receipt.text, /nothing (was )?(done|sent)/i);
      assert.match(receipt.text, /Why it was held/);
      assert.ok(receipt.text.includes('strict mode: every research plan waits for Angus before any search goes out'), 'the concrete strict-mode hold reason reaches the asker');
      assert.match(receipt.text, /Note from Angus[\s\S]*focus on encapsulation instead/);
      assert.match(receipt.text, /suggested plan/i, 'the Doorman attached a plan that passed the host checks');
      assert.match(receipt.text, /water ingress and encapsulation of perovskite modules|moisture degradation of lead halide perovskite/, 'the suggested searches are shown to the agent');
      assert.match(receipt.text, /Revise it and send again, or drop it\./);
      assert.ok(plans().slice(pn).some(x => x.mode === 'plan'), 'the Doorman was asked for a suggested plan');
      assert.equal(calls().length, n, 'a suggestion never runs a search');
      assert.deepEqual(items(held.research.token), [], 'nothing is held again: the agent decides whether to ask again');
      assert.equal(ctx.pendingItems().some(x => x.revises === held.id), false, 'no revision is queued for Angus on his behalf');
      await ctx.waitFor('sent-back plan removed', () => !fs.existsSync(ctx.rig.P('rstate/plans', held.research.rid + '.json')));
      assert.ok(ctx.logs().some(x => x.id === held.id && x.sent === false), 'archived as not sent');
    });
    await whenPart('keys', 'research plan 1 (v3, strict): "1 text" runs exactly the displayed searches and the asker is told "running" with Angus\'s note', async () => {
      setMode('strict');
      const { held } = await ask('What determines perovskite film lifetime?');
      const n = calls().length, note = 'thanks, keep it short';
      await ctx.decide(held.id, '1', { note });
      const running = await ctx.waitFor('running receipt', () => ctx.inbox('sandbox').find(x => x.type === 'research' && x.id === held.id && x.status === 'running'));
      assert.match(JSON.stringify(running), /Note from Angus[\s\S]*thanks, keep it short/);
      const summary = await ctx.waitFor('summary after approved plan', () => ctx.pendingItems().find(x => x.research?.token === held.research.token && !x.research.plan));
      assert.equal(calls().length, n + 1);
      assert.deepEqual(calls().at(-1).searches, held.research.searches, 'exactly the displayed searches ran');
      await dropSummary(summary);
    });
    await whenPart('keys', 'research summary (v3, safe): 1+ is refused (a summary cannot take a rule); "1 text" then delivers and the note reaches the asker', async () => {
      setMode('safe');
      const { held } = await ask('What limits stability in perovskite solar cells?');
      const pending = path.join(ctx.relayState, 'pending', held.id + '.json');
      const refused = await ctx.rig.owner(['approve', held.id, '--allow-similar', '1h']);
      assert.equal(refused.status, 4, refused.stdout + refused.stderr);
      assert.match(refused.stdout + refused.stderr, /similar|rule|1\+/i, 'one line says why');
      assert.ok(fs.existsSync(pending), 'the refused 1+ left the summary held');
      assert.ok(!inboxOf(held.research.token).some(x => x.status === 'approved'), 'nothing delivered by a refused decision');
      await deliver(held, { note: 'read the sources list first' });
    });

    // ---------------- segment B: open and yolo (fresh hourly budget: exceptions 3 of 3 used, then the 4th is refused) ----------------
    freshLimits();
    await ctx.restartRelay({ hostAgents: false }); // fresh segment's per-minute relay budget, not a test retry
    let daily0 = null, flaggedWants = [], yoloWants = [];
    await ctx.testcase('research (open): off-task goes out unheld and flagged; only the summary waits, in the Doorman window', async () => {
      setMode('open');
      daily0 = await dailyCount();
      const n = calls().length;
      const { result, held } = await ask(OFF);
      flaggedWants.push(OFF);
      assert.equal(held.research.plan, undefined, 'open never holds a plan, even off task');
      assert.equal(held.research.mode, 'open');
      assert.equal(held.reviewIn, ctx.rig.doorman, 'open decides in the Doorman window of the sandbox it serves');
      assert.equal(calls().length, n + 1, 'the off-task search WENT OUT');
      assert.deepEqual(calls().at(-1).searches, SEARCH_OFF);
      assert.ok(!inboxOf(result.research).some(x => x.status === 'planned'), 'no plan receipt in open');
      const flag = rlog().find(x => x.ev === 'flagged' && x.looking_for === OFF);
      assert.ok(flag, 'the research log flags it');
      assert.match(flag.reason, /unrelated to this sandbox's task/);
      assert.equal(flag.mode, 'open');
      assert.equal(exceptionsUsed(), 1, 'a flagged plan still takes one of the hourly off-task slots');
      assert.match(held.text, /MODEL_REPORT_END/, 'the full summary is what waits');
      await dropSummary(held);
    });
    await ctx.testcase('research (open): no task set goes out flagged; the summary waits; the task is restored afterwards', async () => {
      setMode('open');
      ctx.writeWorld(w => { const { task, ...rest } = w; return rest; });
      try {
        const n = calls().length;
        const { result, held } = await ask(ON);
        flaggedWants.push(ON);
        assert.equal(held.research.plan, undefined);
        assert.equal(calls().length, n + 1);
        assert.deepEqual(calls().at(-1).searches, SEARCH_ON);
        assert.ok(!inboxOf(result.research).some(x => x.status === 'planned'));
        const flag = rlog().find(x => x.ev === 'flagged' && x.looking_for === ON && x.sandbox === ctx.rig.sandbox);
        assert.ok(flag, 'flagged in the research log');
        assert.match(flag.reason, /^no task is set for this sandbox/);
        assert.equal(exceptionsUsed(), 2);
        await dropSummary(held);
      } finally { ctx.writeWorld(w => ({ ...w, task: TASK })); }
      assert.equal(ctx.readWorld().task, TASK);
    });
    await ctx.testcase('research (yolo): on-task result is delivered at once, labelled NOT reviewed; every code check still ran; nothing is held', async () => {
      setMode('yolo');
      const n = calls().length, pn = plans().length, want = 'What limits stability in perovskite solar cells?';
      const token = await start(want);
      const receipt = await outcome(token);
      assert.equal(receipt.status, 'delivered-open');
      assert.deepEqual(items(token), [], 'yolo holds nothing');
      assert.equal(calls().length, n + 1);
      assert.deepEqual(calls().at(-1).searches, SEARCH_ON);
      assert.deepEqual(plans().slice(pn).map(x => x.mode), ['plan', 'deliverable'], 'the Doorman plan check and the vet of the result both ran');
      assert.ok(receipt.file.startsWith(ctx.rig.P('inbox') + path.sep));
      const md = fs.readFileSync(receipt.file, 'utf8');
      assert.match(md, /^<!-- Web research, Doorman mode yolo[^\n]*NOT reviewed by a human/);
      assert.doesNotMatch(md, /approved by Angus/, 'never presented as reviewed');
      assert.match(md, /Doorman mode: yolo \(no human review/);
      cleanBody(md); // link and markup rule, source cleaning, no truncation: the code checks still run
      const delivered = rlog().find(x => x.ev === 'delivered-open' && x.looking_for === want);
      assert.ok(delivered, 'research log: delivered-open');
      assert.ok(ctx.logs().some(x => x.op === 'research' && x.mode === 'yolo' && x.rid === delivered.rid && x.reviewed === false), 'relay log: reviewed:false');
      yoloWants.push(want);
    });
    await ctx.testcase('research (yolo): off-task also goes out and is delivered NOT reviewed, flagged for the digest', async () => {
      setMode('yolo');
      const n = calls().length;
      const token = await start(OFF);
      const receipt = await outcome(token);
      assert.equal(receipt.status, 'delivered-open');
      assert.deepEqual(items(token), []);
      assert.equal(calls().length, n + 1);
      assert.deepEqual(calls().at(-1).searches, SEARCH_OFF);
      assert.match(fs.readFileSync(receipt.file, 'utf8'), /NOT reviewed by a human/);
      assert.ok(rlog().some(x => x.ev === 'flagged' && x.looking_for === OFF && x.mode === 'yolo'), 'flagged in yolo too');
      assert.equal(exceptionsUsed(), 3);
      flaggedWants.push(OFF); yoloWants.push(OFF);
    });
    await ctx.testcase('research (yolo): the hourly off-task limit still refuses the 4th, before any search', async () => {
      setMode('yolo');
      const n = calls().length, pn = plans().length;
      assert.equal(exceptionsUsed(), 3, 'precondition: three off-task/no-task slots used this hour');
      const token = await start(OFF);
      const refused = await outcome(token);
      assert.equal(refused.status, 'refused');
      assert.match(refused.reason, /3 such requests already wait for Angus this hour/);
      assert.equal(calls().length, n, 'nothing was searched');
      assert.deepEqual(items(token), []);
      assert.ok(!ctx.inbox('sandbox').some(x => x.token === token && x.status === 'delivered-open'));
      assert.deepEqual(plans().slice(pn).map(x => x.mode), ['plan'], 'the plan check ran; the result vet did not');
      assert.ok(rlog().some(x => x.ev === 'refused' && x.stage === 'task' && x.looking_for === OFF));
      assert.equal(exceptionsUsed(), 3, 'a refused request does not take a slot');
    });
    await ctx.testcase('research digests: hourly digest and the daily line count what went out flagged or unreviewed', async () => {
      const hourly = await ctx.cli('docker/research/research.mjs', ['digest', '--since', '1h', '--json']);
      assert.equal(hourly.status, 0, hourly.stdout + hourly.stderr);
      const h = JSON.parse(hourly.stdout.trim().split('\n').pop());
      assert.equal((h.text.match(/⚑/g) || []).length, flaggedWants.length, 'one flagged line per plan sent flagged: ' + h.text);
      for (const w of flaggedWants) assert.ok(h.text.includes(`⚑ "${w}"`), 'flagged line for ' + w);
      assert.equal((h.text.match(/delivered WITHOUT human review \(yolo\)/g) || []).length, yoloWants.length, 'one unreviewed line per yolo delivery');
      assert.match(h.text, new RegExp(`${yoloWants.length} delivered without human review \\(yolo\\)`));
      const d1 = await dailyCount();
      assert.equal(d1.count - daily0.count, flaggedWants.length + yoloWants.length, 'daily line: flagged plans + unreviewed deliveries since segment B started');
      assert.match(d1.text, /^Daily digest \(J412\)/);
      assert.match(d1.text, new RegExp(`${yoloWants.length} research results? delivered without review`));
      assert.match(d1.text, new RegExp(`${flaggedWants.length} research plans? sent flagged \\(off task or no task\\)`));
    });

    // ---------------- segment C: code checks run in every mode (fresh budget: 4 quick requests) ----------------
    freshLimits();
    await ctx.restartRelay({ hostAgents: false }); // no in-flight work/holds; starts a new explicit limit segment
    await ctx.testcase('research: request pre-check refuses at once in strict, safe, open and yolo, before any Doorman call or search', async () => {
      for (const mode of ['strict', 'safe', 'open', 'yolo']) {
        setMode(mode);
        const n = calls().length, pn = plans().length;
        const token = await start('Please look up the contact alice@example.org about perovskite stability');
        const refused = await outcome(token, mode + ' pre-check');
        assert.equal(refused.status, 'refused', mode);
        assert.match(refused.reason, /email address/, mode);
        assert.equal(plans().length, pn, mode + ': the Doorman was never asked');
        assert.equal(calls().length, n, mode + ': nothing searched');
        assert.deepEqual(items(token), [], mode);
        assert.ok(rlog().some(x => x.ev === 'refused' && x.stage === 'precheck' && x.mode === mode && /email/.test(x.reason)), mode + ': logged');
      }
    });
    await ctx.testcase('research: the number/copy rule on the Doorman\'s own searches runs in every mode (one retry, then refused; nothing held or sent)', async () => {
      for (const mode of ['strict', 'safe', 'open', 'yolo']) {
        setMode(mode);
        const n = calls().length, pn = plans().length;
        const token = await start('Explain moisture degradation of lead halide perovskite films');
        const refused = await outcome(token, mode + ' copy rule');
        assert.equal(refused.status, 'refused', mode);
        assert.match(refused.reason, /paraphrase check[\s\S]*word for word/, mode);
        const asked = plans().slice(pn);
        assert.deepEqual(asked.map(x => x.mode), ['plan', 'plan'], mode + ': the plan and exactly one retry');
        assert.match(asked[1].feedback, /word for word/, mode + ': only the host\'s own complaint goes back');
        assert.equal(calls().length, n, mode + ': nothing searched');
        assert.deepEqual(items(token), [], mode + ': not even a plan was held');
      }
    });
  } finally {
    restoreFixture();
    await clearHeld();
    freshLimits();
  }
}
