#!/usr/bin/env python3
"""One-shot isolated owner fixture. No guard stubs: real CLI, real PTY stdin.

Docker starts this helper as PID 1 in a fresh PID namespace. Its parent is not
an agent; it cannot see the host's processes, daemon socket or desktop bus.
"""
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

LIMIT = 256 * 1024
TIMEOUT = 25
NAME = re.compile(r"j376-[a-z0-9-]{1,64}\Z")
ID = re.compile(r"(j376-[a-z0-9-]{1,64})--[0-9a-f]{6}\Z")


def confined(filename, base, regular=False):
    p, b = Path(filename), Path(base)
    if not p.is_absolute() or p == b or b not in p.parents:
        raise ValueError('path outside scratch mount')
    for q in [p, *p.parents]:
        if q == b.parent:
            break
        if q.is_symlink():
            raise ValueError('symlink refused')
    if p.resolve() != p or (regular and (not p.is_file() or p.stat().st_nlink != 1)):
        raise ValueError('not a plain scratch file')
    return str(p)


def main():
    payload = json.loads(sys.argv[1])
    if set(payload) != {'root', 'repo', 'args', 'agent', 'pipe'}:
        raise ValueError('unexpected owner payload')
    root, repo = payload['root'], payload['repo']
    if not isinstance(root, str) or not Path(root).is_absolute() or not re.fullmatch(r'gateway-e2e-[A-Za-z0-9_-]+', Path(root).name):
        raise ValueError('unsafe scratch root')
    if not isinstance(repo, str) or not repo.startswith('/home/agf/Harness/') or Path(repo).resolve() != Path(repo):
        raise ValueError('unauthorized source checkout')
    # The state/config mounts are deliberate, but neither the daemon nor any
    # live owner paths may be visible in this fresh container.
    for hidden in (root + '/dstate', root + '/d.sock', '/var/run/docker.sock',
                   '/home/agf/.local/state/hyprpi', '/home/agf/.config/hyprpi'):
        if os.path.lexists(hidden):
            raise ValueError('host-only path visible: ' + hidden)
    args = payload['args']
    if not isinstance(args, list) or not all(isinstance(a, str) and '\0' not in a for a in args):
        raise ValueError('invalid arguments')
    if type(payload['agent']) is not bool or type(payload['pipe']) is not bool:
        raise ValueError('invalid mode')
    if args and args[0] == 'config-set':
        if len(args) < 4 or args[1] != '--sandbox' or not NAME.fullmatch(args[2]):
            raise ValueError('config-set needs an explicit fixture sandbox')
        for a in args[3:]:
            if '=' not in a or a.startswith('--'):
                raise ValueError('only key=value settings permitted')
            if a.startswith('search.key_file='):
                confined(a.split('=', 1)[1], root + '/config', regular=True)
        script = repo + '/docker/research/research.mjs'
    else:
        if len(args) < 2 or args[0] not in ('approve', 'deny', 'return', 'allow', 'answer'):
            raise ValueError('owner operation not allowed')
        m = ID.fullmatch(args[1])
        if not m:
            raise ValueError('not a fixture pending ID')
        filename = confined(root + '/state/hyprpi/sbx-relay/pending/' + args[1] + '.json', root + '/state', regular=True)
        record = json.loads(Path(filename).read_text())
        if record.get('id') != args[1] or record.get('sandbox') != m[1]:
            raise ValueError('pending record does not match ID')
        rest = args[2:]
        if args[0] == 'allow':
            if len(rest) > 3 or any(not re.fullmatch(r'[A-Za-z0-9 ]{1,40}', a) for a in rest):
                raise ValueError('invalid fixture duration')
        else:
            permitted = {'approve': {'--edit-file'}, 'deny': {'--reason'}, 'return': {'--note'}, 'answer': {'--note'}}[args[0]]
            if args[0] == 'answer' and (not record.get('hostJob') or len(rest) != 2 or not rest[1].strip() or len(rest[1]) > 500 or re.search(r'[\x00-\x1f\x7f]', rest[1])):
                raise ValueError('answer requires a fixture question and plain nonempty note')
            if len(rest) % 2 or len(rest) > 2:
                raise ValueError('invalid decision options')
            for flag, val in zip(rest[::2], rest[1::2]):
                if flag not in permitted:
                    raise ValueError('decision option not allowed')
                if flag == '--edit-file':
                    confined(val, root + '/edits', regular=True)
        script = repo + '/docker/sbx-relay.mjs'
    # A new environment, not a scrubbed copy: no agent, bus, display, socket or auth flags.
    env = {'HOME': root + '/home', 'XDG_CONFIG_HOME': root + '/config',
           'XDG_STATE_HOME': root + '/state', 'XDG_RUNTIME_DIR': '/tmp/owner-run',
           'HYPRPI_RESEARCH_STATE': root + '/rstate', 'HYPRPI_NO_ENSURE': '1',
           'HYPRPI_NO_ADOPT': '1', 'HYPRPI_TEST': '1', 'HYPRPI_RESEARCH_DIRECT': '1',
           'PATH': root + '/bin:/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    if payload['agent']:
        env['HYPRPI_AGENT_ID'] = 'j376-fixture-agent'
    master = slave = None
    if not payload['pipe']:
        master, slave = os.openpty()
    process = subprocess.Popen(['/usr/local/bin/node', script, *args], env=env,
                               stdin=subprocess.PIPE if payload['pipe'] else slave,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True, cwd='/tmp')
    if slave is not None:
        os.close(slave)
    if payload['pipe']:
        process.stdin.close()
    selector = selectors.DefaultSelector()
    for stream in (process.stdout, process.stderr):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    output = {process.stdout: bytearray(), process.stderr: bytearray()}
    deadline, problem = time.monotonic() + TIMEOUT, ''
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                problem = 'owner CLI timed out'
                break
            for key, _ in selector.select(0.1):
                data = os.read(key.fd, 8192)
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    output[key.fileobj].extend(data)
                    if sum(map(len, output.values())) > LIMIT:
                        problem = 'owner CLI output limit exceeded'
                        break
            if problem:
                break
        if not problem:
            try:
                process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                problem = 'owner CLI timed out'
        if problem:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)
    finally:
        selector.close()
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)
        if master is not None:
            os.close(master)
        process.stdout.close()
        process.stderr.close()
    status = 124 if problem else (process.returncode if process.returncode >= 0 else 128 - process.returncode)
    stdout = bytes(output[process.stdout][:LIMIT]).decode('utf-8', errors='replace')
    stderr = bytes(output[process.stderr][:LIMIT]).decode('utf-8', errors='replace')
    if problem:
        stderr += '\n' + problem
    print(json.dumps({'status': status, 'stdout': stdout, 'stderr': stderr}))


try:
    main()
except Exception as exc:
    print(json.dumps({'status': 125, 'stdout': '', 'stderr': 'owner fixture: ' + str(exc)}))
    sys.exit(125)
