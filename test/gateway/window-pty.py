#!/usr/bin/env python3
"""Drive the real archive window in a disposable container; no live relay hook or model exists here."""
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import termios
import fcntl
import time

root = Path(sys.argv[1]).resolve()
view_repo = Path(sys.argv[2]).resolve()
assert root.name == 'window' and root.parent.name.startswith('gateway-e2e-'), 'not a suite-created window fixture'
assert (root / 'fixture-marker').read_text() == 'J376 window fixture\n', 'missing fixture marker'
assert (view_repo / 'bin/pi-doorman.mjs').is_file(), 'missing read-only viewer source'
state = root / 'state'
state.mkdir(exist_ok=True)
held = root / 'held.json'
trace = root / 'decide.jsonl'
held.write_text('null')
provider = root / 'review.mjs'
provider.write_text('import fs from "node:fs"; export default()=>({current:()=>JSON.parse(fs.readFileSync(' + json.dumps(str(held)) + ',"utf8")),decide:(...args)=>{fs.appendFileSync(' + json.dumps(str(trace)) + ',JSON.stringify(args)+"\\n");return {ok:true,text:"fixture decision"}},info:()=>"synthetic private fixture only"});\n')
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(root), 'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(state), 'PI_DOORMAN_STATE': str(state), 'PI_DOORMAN_REVIEW_MODULE': str(provider), 'PI_DOORMAN_LABEL': 'Fixture Doorman-I', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8'}
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 180, 0, 0))
child = subprocess.Popen(['node', str(view_repo / 'bin/pi-doorman.mjs'), 'view', 'fixture-ui', '--write'], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)
buf = bytearray()

def until(text, seconds=10):
    start = len(buf)
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if text.encode() in buf[start:]:
            return
        if child.poll() is not None:
            raise RuntimeError('viewer exited: ' + str(child.returncode) + '\n' + buf.decode(errors='replace'))
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                raise RuntimeError('viewer PTY closed')
            buf.extend(data)
            if len(buf) > 4 * 1024 * 1024:
                raise RuntimeError('unbounded viewer output')
    raise RuntimeError('timeout waiting for: ' + text + '\n' + buf.decode(errors='replace')[-8000:])

try:
    until('Fixture Doorman-I')
    os.write(master, b'Research: synthetic chat attempt')
    until('Research: synthetic chat attempt')
    os.write(master, b'\r')
    until('Fixture Doorman-I')  # A refreshed frame; refusal is proved by the hook/FIFO assertions, not a caption.
    held.write_text(json.dumps({'id': 'fixture-ui--abcdef', 'text': 'synthetic held request\nNo real request or held item.', 'choices': ['1', '2', 'e', 'r'], 'reason': True}))
    until('synthetic held request')
    os.write(master, b'Please ask the Doorman model a question')
    until('Please ask the Doorman model a question')
    os.write(master, b'\r')
    until('Fixture Doorman-I')
    assert not trace.exists(), 'chat reached the decision hook'
    assert not list(state.rglob('input.fifo')), 'viewer created a model input FIFO'
    held.write_text(json.dumps({'id': 'fixture-question--abcdef', 'text': 'synthetic host-agent question', 'choices': ['a', '2'], 'reason': True}))
    until('synthetic host-agent question')
    time.sleep(2.2)  # Deliberately honour the product's two-second review guard; success is asserted below.
    os.write(master, b'a synthetic fixture answer\r')
    deadline = time.monotonic() + 10
    while not trace.exists() and time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            buf.extend(os.read(master, 65536))
        if child.poll() is not None:
            raise RuntimeError('viewer exited before the answer hook')
    assert trace.exists(), 'answer did not reach the review hook'
    calls = [json.loads(line) for line in trace.read_text().splitlines()]
    assert calls == [['fixture-question--abcdef', 'a', None, 'synthetic fixture answer']], 'answer must reach only the selected held question'
    assert not list(state.rglob('input.fifo')), 'answer created a model input FIFO'
    os.write(master, b'\x03')
    child.wait(timeout=5)
    assert child.returncode == 0, 'viewer quit failed'
    print(json.dumps({'ok': True, 'empty_chat_refused': True, 'held_chat_refused': True, 'chat_decision_calls': 0, 'decision_calls': 1, 'answer_ui': True, 'model_fifo': False, 'real_viewer': str(view_repo), 'tail': buf.decode(errors='replace')[-3000:]}))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
    os.close(master)
