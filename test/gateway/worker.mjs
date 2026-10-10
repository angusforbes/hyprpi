#!/usr/bin/env node
// A fixed Docker fixture: it can write requests only into its two mounted outboxes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [command, root, role, encoded] = process.argv.slice(2);
if (!/^gateway-e2e-[A-Za-z0-9_-]+$/.test(path.basename(root || '')) || !path.isAbsolute(root || '')) throw new Error('unsafe fixture root');
if (command === 'idle') {
  setInterval(() => {}, 60_000);
} else if (command === 'request') {
  const dir = { sandbox: 'ws', doorman: 'dws' }[role];
  if (!dir) throw new Error('unknown fixture role');
  const raw = Buffer.from(encoded || '', 'base64').toString('utf8');
  if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('fixture request too large');
  const req = JSON.parse(raw);
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('request must be an object');
  let at = path.join(root, dir);
  for (const part of ['', '.hyprpi-dropbox', 'outbox']) {
    if (part) { at = path.join(at, part); try { fs.mkdirSync(at); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    const st = fs.lstatSync(at);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('outbox is not a plain directory');
  }
  const name = `${req.op === 'status' ? 'status-' : 'req-'}${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`;
  const tmp = path.join(at, `.${name}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, raw + '\n'); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path.join(at, name));
  console.log(name);
} else throw new Error('unknown fixture command');
