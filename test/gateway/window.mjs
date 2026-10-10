import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const NAME = 'Doorman window: actual PTY keys 1 / 1 text / 1+ / 1+ duration / 2, removed keys and chat refused, 2-second look-first';

const viewerFiles = repo => ['bin/pi-doorman.mjs', ...fs.readdirSync(path.join(repo, 'src'), { recursive: true }).filter(f => f.endsWith('.mjs')).sort().map(f => 'src/' + f)];
// Does this viewer checkout speak the J412 vocabulary? A source-text gate only (nothing is executed on the host); window-pty.py then
// proves the same thing by parsing and driving the viewer inside the container, so a half-changed viewer FAILS rather than passes.
function viewerVocabulary(repo) {
  const text = viewerFiles(repo).map(f => fs.readFileSync(path.join(repo, f), 'utf8')).join('\n');
  const missing = [];
  if (!/["'`]1\+["'`]/.test(text)) missing.push('no "1+" key');
  // Only the positive new-key surface is readiness. Removals are assertions inside the PTY test:
  // a shipped 1+ viewer that still implements e must FAIL, not hide behind PENDING.
  return missing;
}

export async function runWindow(ctx) {
  // Pending until the relay side of the new keys has landed (ctx.whenPart records that pending itself), and again until the viewer has.
  // Never passed by the old view. ctx.whenPart(part, name, fn) IS the testcase wrapper, so fn below is the case body.
  if (!ctx.whenPart) return ctx.pending(NAME, 'harness has no ctx.whenPart: the key-vocabulary readiness gate is unavailable');
  if (!ctx.parts?.keys) return ctx.whenPart('keys', NAME, async () => {});
  const supplied = ctx.viewerRepo, hostRoot = path.join(ctx.hostHome || os.homedir(), 'Harness');
  // Only an explicit ctx.viewerRepo (the --viewer-repo option) selects a staged checkout; no environment variable does. Otherwise only the standard pi-doorman locations.
  const candidates = supplied ? [path.resolve(supplied)] : [path.resolve(ctx.repoRoot, '../pi-doorman'), path.resolve(ctx.repoRoot, '../../pi-doorman'), path.join(hostRoot, 'pi-doorman')];
  const real = [...new Set(candidates.filter(p => fs.existsSync(path.join(p, 'bin/pi-doorman.mjs'))).map(p => fs.realpathSync(p)))];
  const checked = real.map(repo => ({ repo, missing: viewerVocabulary(repo) })), chosen = checked.find(c => c.missing.length === 0);
  if (real.length && !chosen) return ctx.pending(NAME, 'viewer with the new key vocabulary not landed: ' + checked.map(c => `${c.repo}: ${c.missing.join(', ')}`).join('; '));
  await ctx.whenPart('keys', NAME, async () => {
    assert.ok(chosen, supplied ? 'the supplied viewer checkout has no bin/pi-doorman.mjs: ' + supplied : 'pi-doorman source checkout is a required local prerequisite (a sibling of hyprpi)');
    const viewRepo = chosen.repo, dir = ctx.rig.P('window');
    const gitOut = (...a) => spawnSync('/usr/bin/git', ['-C', viewRepo, ...a], { env: ctx.rig.dockerEnv, encoding: 'utf8' });
    const viewerCommit = gitOut('rev-parse', 'HEAD').stdout.trim(), viewerBranch = gitOut('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    const viewerDirty = !!gitOut('status', '--porcelain').stdout.trim(), viewerMerged = gitOut('merge-base', '--is-ancestor', 'HEAD', 'master').status === 0;
    // Before anything is mounted: a real source checkout under ~/Harness, no alias, a git (work)tree root, and only regular files (no symlinks) as the viewer source.
    const harnessReal = fs.realpathSync(hostRoot), top = gitOut('rev-parse', '--show-toplevel').stdout.trim();
    assert.ok(viewRepo.startsWith(harnessReal + path.sep), 'the viewer checkout must be under ' + harnessReal + ': ' + viewRepo);
    if (supplied) assert.equal(path.resolve(supplied), viewRepo, 'the supplied viewer path is an alias (symlink or non-canonical); give the real path');
    assert.equal(top && fs.realpathSync(top), viewRepo, 'the viewer path must be the root of a git worktree');
    for (const file of viewerFiles(viewRepo)) assert.ok(fs.lstatSync(path.join(viewRepo, file)).isFile(), 'viewer source must be regular files, no symlinks: ' + file);
    if (ctx.viewerCommit) assert.equal(viewerCommit, ctx.viewerCommit, 'the viewer checkout is not at the pinned commit');
    {
      fs.mkdirSync(dir, { mode: 0o700 });
      assert.equal(fs.realpathSync(dir), dir, 'no symlink fixture mount');
      assert.equal(path.dirname(dir), ctx.rig.root);
      fs.writeFileSync(path.join(dir, 'fixture-marker'), 'J376 window fixture\n');
      const viewerHash = () => { const hash = crypto.createHash('sha256'); for (const file of viewerFiles(viewRepo)) hash.update(file + '\0').update(fs.readFileSync(path.join(viewRepo, file))); return hash.digest('hex'); };
      const sourceSha256 = viewerHash();
      const nonce = crypto.randomBytes(12).toString('hex'), name = 'j376-view-' + nonce;
      const label = 'hyprpi.gateway-e2e.owner';
      ctx.rig.registerWindow(name, nonce);
      const docker = (argv, timeout = 15000) => spawnSync('/usr/bin/docker', argv, { env: ctx.rig.dockerEnv, encoding: 'utf8', timeout, maxBuffer: 8 << 20 });
      try {
        // The script honours the two-second look-first guard before each of ~10 decisions, so it needs well over the old 35 s.
        const result = docker(['run', '--pull', 'never', '--rm', '--name', name, '--label', `${label}=${nonce}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--cpus', '1', '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m', '--mount', `type=bind,src=${ctx.repoRoot},dst=${ctx.repoRoot},readonly`, '--mount', `type=bind,src=${viewRepo},dst=${viewRepo},readonly`, '--mount', `type=bind,src=${dir},dst=${dir}`, '--entrypoint', 'python3', ctx.rig.imageId, path.join(ctx.repoRoot, 'test/gateway/window-pty.py'), dir, viewRepo], 150000);
        if (result.error || result.status === null || result.status === 125) ctx.rig.windowCreateUncertain(name);
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
        const proof = JSON.parse(result.stdout.trim().split('\n').pop());
        assert.equal(proof.ok, true); assert.equal(proof.chat_decision_calls, 0); assert.equal(proof.model_fifo, false); assert.equal(proof.answer_ui, true);
        assert.equal(viewerHash(), sourceSha256, 'viewer source changed during the run; repeat on a stable checkout');
        ctx.artifact('window-pty', { ...proof, viewerCommit, viewerBranch, viewerDirty, viewerMergedToMaster: viewerMerged, viewerRepo: viewRepo, sourceSha256 });
        assert.equal(proof.empty_chat_refused, true); assert.equal(proof.held_chat_refused, true); assert.equal(proof.look_first_refused, true);
        // Positive: each key reached decide(id, key, text, { minutes }) exactly once, in order, with the exact text and minutes.
        const rows = proof.decisions.map(([id, k, note, opts]) => [id.replace(/--.*/, ''), k, note, opts.minutes ?? null]);
        assert.deepEqual(rows, [['fixture-neg', '1', '', null], ['fixture-note', '1', 'thanks, go ahead', null], ['fixture-allow', '1+', '', 60], ['fixture-allow2', '1+', 'keep it short', 120], ['fixture-allow3', '1+', '', 480],
          ['fixture-deny', '2', 'not on task', null], ['fixture-deny2', '2', '', null], ['fixture-draft', '1', '', null], ['fixture-question', '1', 'a synthetic fixture answer', null], ['fixture-question2', '2', '', null]]);
        assert.equal(proof.decision_calls, 10);
        // Negative: e / r / 3 / a (bare and with text) and the refusals executed without any decision; nothing opened an editor.
        for (const k of ['e', 'r', '3', 'a']) assert.ok(proof.removed_keys_refused.some(x => x === k || x.startsWith(k + ' ')), 'removed key was exercised: ' + k);
        assert.equal(proof.editor_opened, false); assert.equal(proof.allow_short_refused, true); assert.equal(proof.allow_not_offered_refused, true); assert.equal(proof.bare_answer_refused, true); assert.equal(proof.allow_cap_minutes, 480);
        fs.writeFileSync(path.join(dir, 'proof.json'), JSON.stringify(proof));
      } finally {
        // A timeout can strand Docker after its client is killed. Never remove a container merely by a guessed name.
        ctx.rig.cleanupWindow(name); // The rig retains this registration and any create uncertainty until final cleanup.
        const sweep = docker(['ps', '-aq', '--filter', `label=${label}=${nonce}`]);
        assert.equal(sweep.status, 0, sweep.stderr); assert.equal(sweep.stdout.trim(), '', 'no container remains with the exact window ownership label');
      }
    }
  });
}
