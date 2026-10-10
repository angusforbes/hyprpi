// J412: actual plain-message decisions, exact recipient text, asker notes, rules and denial/revision links.
// The peer is a real connection to the PRIVATE daemon, not a window or model. No decision file is seeded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runDecisions(ctx) {
  const names = ['1 text reaches only the asker, never the recipient', '1+ defaults to one hour and authorizes a subsequent similar message', '1+ 5m minimum is accepted', '1+ 2h text sets two hours and preserves the asker note', '1+ over eight hours is capped', '1+ under five minutes refuses without a decision or rule', '2 carries the hold reason and note; the revision cannot use an existing rule', 'removed CLI verbs and edit option refuse without mutation'];
  if (!ctx.parts.keys) { for (const name of names) ctx.pending('J412 message: ' + name, 'new key CLI and asker-only receipt helper have not landed'); return; }
  assert.equal(process.env.HYPRPI_SOCKET, ctx.rig.P('d.sock'), 'peer must capture only the private daemon');
  const { connect } = await import(pathToFileURL(path.join(ctx.repoRoot, 'lib/client.mjs')).href);
  const events = [], peerId = 'fixture-peer-' + path.basename(ctx.rig.root), peerName = 'FixturePeer';
  const baseline = ctx.readWorld(), rulesFile = path.join(ctx.relayState, 'rules.json');
  let peer;
  const rules = () => fs.existsSync(rulesFile) ? JSON.parse(fs.readFileSync(rulesFile, 'utf8')) : [];
  const heldPath = id => path.join(ctx.relayState, 'pending', id + '.json');
  const ask = async text => {
    const r = await ctx.ask('sandbox', { op: 'talk', to: [peerName], mode: 'talk', text: '[Alpha, in world I] ' + text });
    assert.equal(r.ok, true, JSON.stringify(r)); return r;
  };
  const held = async text => {
    const r = await ask(text); assert.equal(r.pending.length, 1, JSON.stringify(r)); return ctx.holdFrom(r);
  };
  const receipt = async (h, decision, note) => {
    const r = await ctx.waitFor('plain message asker receipt ' + h.id, () => ctx.inbox('sandbox').find(x => x.type === 'decision' && x.id === h.id));
    assert.equal(r.decision, decision); assert.match(r.text, new RegExp('Angus ' + decision));
    if (note) { assert.equal(r.note, note); assert.ok(r.text.includes('Note from Angus')); assert.ok(r.text.includes(note)); }
    assert.ok(!ctx.inbox('sandbox').some(x => x.type === 'message' && x.from === 'Outside' && x.text?.includes(h.id)), 'no Thoughts outcome copy');
    return r;
  };
  const delivery = async h => {
    const d = await ctx.waitFor('real private peer delivery ' + h.id, () => events.find(x => x.event === 'talk' && x.data.text === h.body));
    assert.equal(d.data.text, h.body, 'recipient gets exactly the approved envelope, not the asker note'); return d;
  };
  const endRule = async (h, minutes, started) => {
    const list = rules().filter(r => r.recipient === peerId && r.sandbox === ctx.rig.sandbox);
    assert.equal(list.length, 1, 'one rule for this exact private peer');
    assert.equal(list[0].kind, 'talk'); assert.equal(list[0].recipientKind, 'agent');
    assert.ok(list[0].until >= started + minutes * 60000 - 1000 && list[0].until <= Date.now() + minutes * 60000 + 1000, 'rule expiry matches the selected duration');
  };
  const clearRules = async () => { const r = await ctx.cli('docker/sbx-relay.mjs', ['revoke', 'all']); assert.equal(r.status, 0, r.stdout + r.stderr); };
  try {
    ctx.writeWorld(w => ({ ...w, gateway: { ...w.gateway, mode: 'safe' } }));
    await ctx.restartRelay({ hostAgents: 'bridge' });
    peer = await connect({ path: ctx.rig.P('d.sock'), onEvent: (event, data) => events.push({ event, data }) });
    const hello = await peer.call('agent.hello', { agent_id: peerId, name: peerName, pid: process.pid, cwd: ctx.rig.P('home'), want_workspace: 81, model: 'fixture-no-model', acks: false });
    assert.equal(hello.agent_id, peerId);
    await ctx.testcase('J412 message: ' + names[0], async () => {
      const h = await held('fixture approval text'), note = 'PRIVATE-OWNER-NOTE';
      assert.ok(!events.some(x => x.event === 'talk' && x.data.text === h.body));
      await ctx.decide(h.id, '1', { note }); await delivery(h); await receipt(h, 'approved', note);
      assert.ok(!events.some(x => String(x.data.text).includes(note)), 'owner note never reaches the peer'); assert.deepEqual(rules(), []);
    });
    for (const [index, duration, minutes, note] of [[1, undefined, 60, undefined], [2, '5m', 5, undefined], [3, '2h', 120, 'PRIVATE-RULE-NOTE'], [4, '12h', 480, undefined]]) {
      await ctx.testcase('J412 message: ' + names[index], async () => {
        await clearRules(); const h = await held('fixture rule ' + index), started = Date.now();
        const result = await ctx.decide(h.id, '1+', { ...(duration ? { duration } : {}), ...(note ? { note } : {}) });
        if (index === 4) assert.match(result.stderr, /cap|8 hours|8 h/i);
        await delivery(h); await receipt(h, 'approved', note); await endRule(h, minutes, started);
        if (note) assert.ok(!events.some(x => String(x.data.text).includes(note)));
        if (index === 1) {
          const r = await ask('fixture subsequent similar message'); assert.deepEqual(r.pending, []); assert.ok(r.ruled); assert.ok(r.delivered.includes(peerId));
          await ctx.waitFor('similar message delivered under rule', () => events.some(x => x.event === 'talk' && x.data.text.includes('fixture subsequent similar message') && x.data.text.includes('sent without asking under')));
        }
      });
    }
    await ctx.testcase('J412 message: ' + names[5], async () => {
      await clearRules(); const h = await held('fixture short duration refusal'), before = fs.readFileSync(heldPath(h.id));
      const r = await ctx.rig.owner(['approve', h.id, '--allow-similar', '3m']); assert.equal(r.status, 4, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /5 min|5 minutes|at least 5/); assert.deepEqual(fs.readFileSync(heldPath(h.id)), before); assert.deepEqual(rules(), []);
      assert.ok(!events.some(x => x.event === 'talk' && x.data.text === h.body)); await ctx.decide(h.id, '1'); await delivery(h);
    });
    await ctx.testcase('J412 message: ' + names[6], async () => {
      await clearRules();
      // Hold a demand before creating a talk rule: rules never apply to demands, so both are genuine holds.
      const r = await ctx.ask('sandbox', { op: 'talk', to: [peerName], mode: 'demand', text: '[Alpha, in world I] fixture denied original' });
      assert.equal(r.ok, true, JSON.stringify(r)); const original = ctx.holdFrom(r);
      const granting = await held('fixture existing rule before denial'); await ctx.decide(granting.id, '1+'); await delivery(granting);
      await ctx.decide(original.id, '2', { note: 'PRIVATE-DENIAL-NOTE' }); const denied = await receipt(original, 'denied', 'PRIVATE-DENIAL-NOTE');
      assert.match(denied.text, /Why it was held/); assert.match(denied.text, /Revise it and send again, or drop it\./);
      assert.ok(!events.some(x => x.event === 'talk' && x.data.text === original.body));
      const revision = await held('fixture revised original'); assert.equal(revision.revises, original.id); assert.match(revision.text + ' ' + revision.body, /revision of/i);
      const bytes = fs.readFileSync(heldPath(revision.id)), refused = await ctx.rig.owner(['approve', revision.id, '--allow-similar', '1h']);
      assert.equal(refused.status, 4, refused.stdout + refused.stderr); assert.deepEqual(fs.readFileSync(heldPath(revision.id)), bytes);
      await ctx.decide(revision.id, '1'); await delivery(revision);
    });
    await ctx.testcase('J412 message: ' + names[7], async () => {
      await clearRules(); const h = await held('fixture removed CLI probes'), before = fs.readFileSync(heldPath(h.id));
      for (const argv of [['allow', h.id], ['return', h.id], ['answer', h.id, '--note', 'not an answer'], ['approve', h.id, '--edit-file', ctx.rig.P('projects/fixture/notes.md')]]) {
        const r = await ctx.cli('docker/sbx-relay.mjs', argv); assert.notEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /usage|removed|unknown|edit|option/i);
        assert.deepEqual(fs.readFileSync(heldPath(h.id)), before); assert.ok(!events.some(x => x.event === 'talk' && x.data.text === h.body));
      }
      await ctx.decide(h.id, '1'); await delivery(h);
    });
    ctx.artifact('message-decisions', { peerId, scope: 'actual private daemon talk events; real guarded owner CLI; exact asker decision envelopes', deliveries: events.filter(x => x.event === 'talk') });
  } finally {
    for (const h of ctx.pendingItems().filter(x => x.sandbox === ctx.rig.sandbox && x.targets?.some(t => t.id === peerId))) await ctx.decide(h.id, '2');
    peer?.close(); await clearRules(); ctx.writeWorld(() => baseline); await ctx.restartRelay({ hostAgents: false });
  }
}
