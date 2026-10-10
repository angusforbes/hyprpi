#!/usr/bin/env python3
"""Drive the real archive window in a disposable container; no live relay hook or model exists here.

J412 key vocabulary (spec v3, section 2): 1 / 1 <text> / 1+ / 1+ <duration> [text] / 2 / 2 <text>; on a host-agent question 1 <text> is the
answer and a bare 1 is refused; e, r, 3 and a are gone. Everything below is typed into the real viewer through a genuine PTY and the
only evidence of a decision is the exact argument list the viewer passes to the review hook's decide(id, key, text, { minutes }).
"""
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

# 0. The viewer's own parser must already speak the new vocabulary (a bare parse check, no PTY). The host side only gates on source text;
# this is the authoritative check, so an old or half-changed viewer FAILS here rather than being passed by its old behaviour.
probe_js = ('import { pathToFileURL } from "node:url"; const m = await import(pathToFileURL(process.argv[1]).href); '
            'const lines = ["1", "1 thanks", "1+", "1+ 2h keep it", "1+ 12h", "1+ 3m", "2", "2 not on task", "e", "e x", "r", "r note", "3", "3 x", "a", "a yes"]; '
            'console.log(JSON.stringify(Object.fromEntries(lines.map((l) => [l, m.choiceLine(l)]))));')
probe = subprocess.run(['node', '--input-type=module', '-e', probe_js, str(view_repo / 'src/view.mjs')], env=env, capture_output=True, text=True, timeout=20)
assert probe.returncode == 0, 'viewer parse probe failed: ' + probe.stderr[-2000:]
parsed = json.loads(probe.stdout.strip().splitlines()[-1])
want = {'1': ('1', '', None), '1 thanks': ('1', 'thanks', None), '1+': ('1+', '', 60), '1+ 2h keep it': ('1+', 'keep it', 120), '1+ 12h': ('1+', '', 480), '2': ('2', '', None), '2 not on task': ('2', 'not on task', None)}
for line, (k, note, minutes) in want.items():
    got = parsed[line]
    assert got and got.get('k') == k and (got.get('note') or '') == note and got.get('minutes') == minutes, f'parse {line!r}: {got}'
assert parsed['1+ 3m'] and parsed['1+ 3m'].get('short') is True, 'a 3 minute rule must be flagged too short'
for line in ['e', 'e x', 'r', 'r note', '3', '3 x', 'a', 'a yes']:
    assert parsed[line] is None, f'removed key {line!r} still parses as a choice: {parsed[line]}'

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 180, 0, 0))
child = subprocess.Popen(['node', str(view_repo / 'bin/pi-doorman.mjs'), 'view', 'fixture-ui', '--write'], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)
buf = bytearray()


def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if child.poll() is not None:
            raise RuntimeError('viewer exited: ' + str(child.returncode) + '\n' + buf.decode(errors='replace')[-4000:])
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                raise RuntimeError('viewer PTY closed')
            buf.extend(data)
            if len(buf) > 8 * 1024 * 1024:
                raise RuntimeError('unbounded viewer output')


def until(text, seconds=10):
    start = len(buf)
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if text.encode() in buf[start:]:
            return
        pump(.1)
    raise RuntimeError('timeout waiting for: ' + text + '\n' + buf.decode(errors='replace')[-8000:])


def calls():
    return [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []


def show(item_id, title, choices, answer=False, reason=True):
    """Make the host's record offer one held item and wait until the window has drawn it. Returns when it first appeared."""
    held.write_text(json.dumps({'id': item_id, 'text': title + '\nsynthetic body, no real request or held item.', 'title': title, 'choices': choices, 'reason': reason, 'answer': answer}))
    until(title)
    return time.monotonic()


def settle(shown_at):
    """Honour the product's two-second look-first guard: the decision key is only typed once the item has been on screen over 2 s."""
    wait = 2.25 - (time.monotonic() - shown_at)
    if wait > 0:
        pump(wait)


def decide(keys, expected):
    """Type keys + Enter, wait for the viewer's single decide() call, and compare its exact argument list."""
    before = len(calls())
    os.write(master, keys.encode() + b'\r')
    deadline = time.monotonic() + 8
    while len(calls()) == before and time.monotonic() < deadline:
        pump(.1)
    got = calls()[before:]
    assert got == [expected], f'{keys!r}: decide args {got} != {[expected]}'
    pump(.4)
    assert len(calls()) == before + 1, f'{keys!r}: decided more than once: {calls()[before:]}'
    return got[0]


def refused(keys, caption=None, expect_alive=True):
    """Type keys + Enter; nothing may reach the decision hook (a caption, when given, must be the viewer's visible refusal)."""
    before, mark = len(calls()), len(buf)
    os.write(master, keys.encode() + b'\r')
    pump(.8)
    assert len(calls()) == before, f'{keys!r} reached the decision hook: {calls()[before:]}'
    if caption is not None:
        assert caption.encode() in buf[mark:], f'{keys!r}: refusal caption {caption!r} not drawn:\n' + buf[mark:].decode(errors='replace')[-1500:]
    if expect_alive:
        assert child.poll() is None, f'viewer died on {keys!r}'


def no_edit_scratch():
    return not list(Path('/tmp').glob('pi-doorman-edit-*'))


try:
    until('Fixture Doorman-I')

    # --- chat refusal (unchanged): nothing typed here is ever a message to the Doorman model, with or without a held item ---
    os.write(master, b'Research: synthetic chat attempt')
    until('Research: synthetic chat attempt')
    os.write(master, b'\r')
    until('Fixture Doorman-I')
    assert not trace.exists(), 'empty-window chat reached the decision hook'
    show('fixture-chat--abcdef', 'synthetic held request', ['1', '1+', '2'])
    os.write(master, b'Please ask the Doorman model a question')
    until('Please ask the Doorman model a question')
    os.write(master, b'\r')
    until('Fixture Doorman-I')
    assert not trace.exists(), 'chat reached the decision hook'
    assert not list(state.rglob('input.fifo')), 'viewer created a model input FIFO'

    # --- 2-second look-first: a number typed before the item has been on screen 2 s is refused; the same number afterwards decides ---
    n0 = time.monotonic()
    shown = show('fixture-neg--aaaaaa', 'synthetic negative keys', ['1', '1+', '2', 'e', 'r', '3', 'a'])  # a legacy host offering the dead keys too
    assert time.monotonic() - n0 < 6
    mark = len(buf)
    os.write(master, b'1\r')
    pump(.6)
    assert time.monotonic() - shown < 1.9, 'timing fixture too slow to prove the look-first guard; rerun'
    assert not calls(), 'a key typed before the item had been on screen 2 s reached the decision hook'
    assert b'less than 2 s ago' in buf[mark:], 'look-first refusal caption missing'
    settle(shown)

    # --- negative: the dead keys never decide, never open an editor, and are not offered even when a legacy host lists them ---
    for keys in ['e', 'e edited text', 'r', 'r send it back', '3', '3 allow', 'a', 'a an answer', 'R note', 'E']:
        refused(keys, 'only a decision can be typed here')
    assert b'only a decision can be typed here: 1 / 1+ / 2' in buf, 'the offered choices must be exactly 1 / 1+ / 2 (dead keys filtered even when a host lists them)'
    assert no_edit_scratch(), 'e opened an edit scratch area'
    refused('1+ 3m', 'at least 5 minutes')
    refused('1 ' + 'x' * 501, 'at most 500')
    assert not calls()
    removed_refused = ['e', 'e edited text', 'r', 'r send it back', '3', '3 allow', 'a', 'a an answer', 'R note', 'E']
    decide('1', ['fixture-neg--aaaaaa', '1', '', {}])  # a bare 1 approves

    # --- positive: 1 <text> ---
    shown = show('fixture-note--bbbbbb', 'synthetic approve with a note', ['1', '1+', '2']); settle(shown)
    decide('1 thanks, go ahead', ['fixture-note--bbbbbb', '1', 'thanks, go ahead', {}])
    # --- positive: 1+ (default 1 hour), 1+ <duration> <text>, and the 8 hour cap ---
    shown = show('fixture-allow--cccccc', 'synthetic allow similar', ['1', '1+', '2']); settle(shown)
    decide('1+', ['fixture-allow--cccccc', '1+', '', {'minutes': 60}])
    shown = show('fixture-allow2--dddddd', 'synthetic allow similar for two hours', ['1', '1+', '2']); settle(shown)
    decide('1+ 2h keep it short', ['fixture-allow2--dddddd', '1+', 'keep it short', {'minutes': 120}])
    shown = show('fixture-allow3--eeeeee', 'synthetic allow similar over cap', ['1', '1+', '2']); settle(shown)
    decide('1+ 12h', ['fixture-allow3--eeeeee', '1+', '', {'minutes': 480}])
    # --- positive: 2 and 2 <text> (the viewer sends the key and the owner's text; the host adds why it was held) ---
    shown = show('fixture-deny--ffffff', 'synthetic deny with a reason', ['1', '1+', '2']); settle(shown)
    decide('2 not on task', ['fixture-deny--ffffff', '2', 'not on task', {}])
    shown = show('fixture-deny2--a1a1a1', 'synthetic bare deny', ['1', '1+', '2']); settle(shown)
    decide('2', ['fixture-deny2--a1a1a1', '2', '', {}])
    # --- an item that cannot take a rule (not a plain message): 1+ is refused with why, 1 still approves ---
    shown = show('fixture-draft--b2b2b2', 'synthetic item without allow similar', ['1', '2']); settle(shown)
    refused('1+', '1+ (allow similar) fits only a plain message')
    refused('1+ 2h x', '1+ (allow similar) fits only a plain message')
    decide('1', ['fixture-draft--b2b2b2', '1', '', {}])
    # --- a host agent's question: 1 <text> is the answer, a bare 1 is refused, a and the old answer key are gone, 2 declines ---
    shown = show('fixture-question--c3c3c3', 'synthetic host-agent question', ['1', '2'], answer=True); settle(shown)
    refused('1', 'say what to answer')
    refused('a a synthetic fixture answer', 'only a decision can be typed here')
    decide('1 a synthetic fixture answer', ['fixture-question--c3c3c3', '1', 'a synthetic fixture answer', {}])
    shown = show('fixture-question2--d4d4d4', 'synthetic second host-agent question', ['1', '2'], answer=True); settle(shown)
    decide('2', ['fixture-question2--d4d4d4', '2', '', {}])

    assert not list(state.rglob('input.fifo')), 'a decision created a model input FIFO'
    assert no_edit_scratch(), 'an edit scratch area exists'
    final_calls = calls()
    os.write(master, b'\x03')
    child.wait(timeout=5)
    assert child.returncode == 0, 'viewer quit failed'
    print(json.dumps({'ok': True, 'empty_chat_refused': True, 'held_chat_refused': True, 'chat_decision_calls': 0,
                      'decision_calls': len(final_calls), 'decisions': final_calls, 'answer_ui': True, 'model_fifo': False,
                      'look_first_refused': True, 'removed_keys_refused': removed_refused, 'allow_cap_minutes': 480,
                      'allow_short_refused': True, 'allow_not_offered_refused': True, 'bare_answer_refused': True,
                      'editor_opened': False, 'real_viewer': str(view_repo), 'tail': buf.decode(errors='replace')[-1500:]}))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
    os.close(master)
