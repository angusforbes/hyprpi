import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export async function runWindow(ctx) {
  await ctx.testcase('Doorman window: actual PTY refuses chat and routes only a held-question answer', async () => {
    const candidates = [path.resolve(ctx.repoRoot, '../pi-doorman'), path.resolve(ctx.repoRoot, '../../pi-doorman'), path.join(ctx.hostHome || os.homedir(), 'Harness/pi-doorman')];
    const hit = candidates.find(p => fs.existsSync(path.join(p, 'bin/pi-doorman.mjs')));
    assert.ok(hit, 'pi-doorman source checkout is a required local prerequisite (sibling of hyprpi)');
    const viewRepo = fs.realpathSync(hit), dir = ctx.rig.P('window');
    fs.mkdirSync(dir, { mode: 0o700 });
    assert.equal(fs.realpathSync(dir), dir, 'no symlink fixture mount');
    assert.equal(path.dirname(dir), ctx.rig.root);
    fs.writeFileSync(path.join(dir, 'fixture-marker'), 'J376 window fixture\n');
    const viewerHash = () => { const hash = crypto.createHash('sha256'); for (const file of ['bin/pi-doorman.mjs', ...fs.readdirSync(path.join(viewRepo, 'src'), { recursive: true }).filter(f => f.endsWith('.mjs')).sort().map(f => 'src/' + f)]) hash.update(file + '\0').update(fs.readFileSync(path.join(viewRepo, file))); return hash.digest('hex'); };
    const sourceSha256 = viewerHash(), viewerCommit = spawnSync('/usr/bin/git', ['-C', viewRepo, 'rev-parse', 'HEAD'], { env: ctx.rig.dockerEnv, encoding: 'utf8' }).stdout.trim();
    const nonce = crypto.randomBytes(12).toString('hex'), name = 'j376-view-' + nonce;
    const label = 'hyprpi.gateway-e2e.owner';
    ctx.rig.registerWindow(name, nonce);
    const docker = (argv, timeout = 15000) => spawnSync('/usr/bin/docker', argv, { env: ctx.rig.dockerEnv, encoding: 'utf8', timeout, maxBuffer: 8 << 20 });
    try {
      const result = docker(['run', '--pull', 'never', '--rm', '--name', name, '--label', `${label}=${nonce}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--cpus', '1', '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m', '--mount', `type=bind,src=${ctx.repoRoot},dst=${ctx.repoRoot},readonly`, '--mount', `type=bind,src=${viewRepo},dst=${viewRepo},readonly`, '--mount', `type=bind,src=${dir},dst=${dir}`, '--entrypoint', 'python3', ctx.rig.imageId, path.join(ctx.repoRoot, 'test/gateway/window-pty.py'), dir, viewRepo], 35000);
      if (result.error || result.status === null || result.status === 125) ctx.rig.windowCreateUncertain(name);
      assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
      const proof = JSON.parse(result.stdout.trim().split('\n').pop());
      assert.equal(proof.ok, true); assert.equal(proof.chat_decision_calls, 0); assert.equal(proof.decision_calls, 1); assert.equal(proof.answer_ui, true); assert.equal(proof.model_fifo, false);
      assert.equal(viewerHash(), sourceSha256, 'viewer source changed during the run; repeat on a stable checkout');
      ctx.artifact('window-pty', { ...proof, viewerCommit, sourceSha256 });
      assert.equal(proof.empty_chat_refused, true); assert.equal(proof.held_chat_refused, true);
      fs.writeFileSync(path.join(dir, 'proof.json'), JSON.stringify(proof));
    } finally {
      // A timeout can strand Docker after its client is killed. Never remove a container merely by a guessed name.
      ctx.rig.cleanupWindow(name); // The rig retains this registration and any create uncertainty until final cleanup.
      const sweep = docker(['ps', '-aq', '--filter', `label=${label}=${nonce}`]);
      assert.equal(sweep.status, 0, sweep.stderr); assert.equal(sweep.stdout.trim(), '', 'no container remains with the exact window ownership label');
    }
  });
}
