#!/usr/bin/env node
// Fail-closed isolation regression checks. Requires the cached pi-sandbox image
// and a working Docker daemon; there is deliberately no skip on prerequisites.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRig, settleLateCreates } from './rig.mjs';

const HOME = os.userInfo().homedir;

export async function safety({ repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), onRig = () => {} } = {}) {
  const rig = await createRig({ repoRoot });
  let checks = 0, failure;
  const rejects = async (fn, re) => { await assert.rejects(fn, re); checks++; };
  try {
    onRig(rig);
    const originalWrite = fs.writeFileSync;
    let failedRoot;
    try {
      fs.writeFileSync = (file, ...args) => {
        if (String(file).endsWith('/config/hyprpi/sbx-relay.json')) { failedRoot = String(file).slice(0, -'/config/hyprpi/sbx-relay.json'.length); throw new Error('synthetic constructor write failure'); }
        return originalWrite(file, ...args);
      };
      await assert.rejects(createRig({ repoRoot }), error => { if (error.cleanupUnconfirmedRoot) throw error; assert.match(error.message, /synthetic constructor write failure/); return true; });
    } finally { fs.writeFileSync = originalWrite; }
    assert.ok(failedRoot); assert.equal(fs.existsSync(failedRoot), false, 'constructor failure removes its unregistered root'); checks++;
    let clock = 0, inspected = 0, removed = [];
    const late = new Set(['j376-owner-unit-fixture']);
    settleLateCreates(late, { now: () => clock, wait: ms => { clock += ms; }, timeout: 500,
      inspect: () => ++inspected < 3 ? null : { Id: 'a'.repeat(64) }, remove: (info, name) => removed.push([info.Id, name]) });
    assert.equal(inspected, 3); assert.equal(late.size, 0); assert.deepEqual(removed, [['a'.repeat(64), 'j376-owner-unit-fixture']]); checks++;
    clock = 0;
    const unknown = new Set(['j376-owner-unit-unknown']);
    assert.throws(() => settleLateCreates(unknown, { now: () => clock, wait: ms => { clock += ms; }, timeout: 200,
      inspect: () => null, remove: () => assert.fail('must not remove an unobserved creation') }), /cleanup unconfirmed/);
    assert.equal(unknown.size, 1, 'an empty sweep cannot settle an unknown creation'); checks++;
    await rejects(() => createRig({ repoRoot, root: path.join(HOME, '.local/state/hyprpi') }), /only repoRoot/);
    await rejects(() => createRig({ repoRoot: HOME }), /inside .*Harness/);
    assert.throws(() => rig.P('..', 'live-state'), /escapes/); checks++;
    const forbidden = ['HYPRPI_AGENT_ID', 'PI_CODING_AGENT', 'PI_SESSION_FILE', 'HYPRPI_THOUGHTS_ROOM', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE'];
    for (const k of forbidden) assert.equal(rig.env[k], undefined, `inherited ${k}`);
    checks++;
    await rejects(() => rig.owner(['approve', 'world-g--123abc']), /unsafe or foreign/);
    await rejects(() => rig.owner(['approve', `${rig.sandbox}--123abc`], { env: { XDG_STATE_HOME: path.join(HOME, '.local/state') } }), /overrides forbidden/);
    await rejects(() => rig.owner(['approve', `${rig.sandbox}--123abc`], { root: path.join(HOME, '.local/state/hyprpi') }), /overrides forbidden/);
    await rejects(() => rig.cli('docker/sbx-relay.mjs', ['pending'], { env: { XDG_STATE_HOME: path.join(HOME, '.local/state') } }), /override not permitted/);
    await rejects(() => rig.cli('docker/sbx-relay.mjs', ['pending'], { env: { HYPRPI_AGENT_ID: 'bad' } }), /override not permitted/);
    const oldHome = rig.env.HOME;
    rig.env.HOME = HOME;
    await rejects(() => rig.start(), /protected environment changed/);
    rig.env.HOME = oldHome;
    const config = rig.P('config/hyprpi/sbx-relay.json'), original = fs.readFileSync(config, 'utf8'), cfg = JSON.parse(original);
    cfg.sandboxes[0].workspace = HOME;
    fs.writeFileSync(config, JSON.stringify(cfg));
    await rejects(() => rig.start(), /not a scratch path/);
    fs.writeFileSync(config, original);
    fs.symlinkSync(path.join(HOME, '.local/state/hyprpi'), rig.P('config', 'no-live-state'));
    await rejects(() => rig.start(), /symlink refused/);
    fs.unlinkSync(rig.P('config', 'no-live-state'));
    const stub = spawnSync(rig.P('bin/docker'), ['ps', '-a', '--filter', 'label=hyprpi.gpu=1', '-q'], { env: rig.env, encoding: 'utf8' });
    assert.equal(stub.status, 0); assert.equal(stub.stdout, '');
    assert.equal(spawnSync(rig.P('bin/docker'), ['rm', '-f', 'NEVER_A_CONTAINER'], { env: rig.env }).status, 97); checks++;
    await rig.start();
    const proof = await rig.proof();
    assert.equal(proof.ok, true); assert.equal(proof.network, 'none'); assert.equal(proof.mounts.length, 5);
    assert.ok(proof.writeRefusals.every(r => ['EROFS', 'EACCES'].includes(r.code))); checks++;
    const id = `${rig.sandbox}--123abc`, pending = rig.P('state/hyprpi/sbx-relay/pending', id + '.json');
    const record = { id, sandbox: rig.sandbox, mode: 'talk', text: 'synthetic fixture request', body: 'fixture header\nsynthetic fixture request', targets: [], to: [], shown: [] };
    fs.writeFileSync(pending, JSON.stringify({ ...record, sandbox: 'world-g' }));
    await rejects(() => rig.owner(['approve', id]), /must match fixture/);
    fs.writeFileSync(pending, JSON.stringify(record));
    for (const opts of [{ agent: true }, { pipe: true }]) {
      const r = await rig.owner(['approve', id], opts);
      assert.equal(r.status, 3, JSON.stringify(r));
      assert.match(r.stderr, opts.agent ? /called from an agent/ : /no terminal/);
      assert.equal(fs.existsSync(rig.P('state/hyprpi/sbx-relay/decisions', id + '.approve')), false); checks++;
    }
    await rejects(() => rig.owner(['approve', id, '--edit-file', path.join(HOME, '.config/hyprpi/config.json')]), /not a scratch path/);
    const edit = rig.P('edits', id + '.txt');
    fs.writeFileSync(edit, 'Modified synthetic fixture request.');
    const approved = await rig.owner(['approve', id, '--edit-file', edit]);
    assert.equal(approved.status, 0, JSON.stringify(approved));
    assert.match(fs.readFileSync(rig.P('state/hyprpi/sbx-relay/decisions', id + '.approve'), 'utf8'), /^terminal\nedit:[a-f0-9]{16}$/);
    checks++;
    for (const opts of [{ agent: true }, { pipe: true }]) {
      const r = await rig.owner(['config-set', '--sandbox', rig.sandbox, 'mode=doorman-strict'], opts);
      assert.equal(r.status, 3, JSON.stringify(r)); checks++;
    }
    const changed = await rig.owner(['config-set', '--sandbox', rig.sandbox, 'mode=doorman-strict']);
    assert.equal(changed.status, 0, JSON.stringify(changed));
    assert.equal(JSON.parse(fs.readFileSync(rig.P('config/hyprpi/worlds', rig.sandbox + '.json'), 'utf8')).gateway.mode, 'doorman-strict');
    assert.match(changed.stdout, /J376 isolated fixture refuses/); checks++;
    const request = await rig.request('sandbox', { op: 'room.read', limit: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(rig.P('ws/.hyprpi-dropbox/outbox', request), 'utf8')), { op: 'room.read', limit: 1 }); checks++;
    return { ok: true, checks, proof };
  } catch (error) { failure = error; throw error; }
  finally { await rig.close(); assert.equal(fs.existsSync(rig.root), false); if (failure) failure.cleanupVerified = true; }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await safety();
  console.log(`PASS rig safety: ${result.checks} checks; real PTY approval, agent/pipe refusal, exact Docker mounts, readonly inbox, no network; cleanup complete`);
}
