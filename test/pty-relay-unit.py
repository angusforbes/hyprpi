#!/usr/bin/env python3
"""J543: omnistation/pty-relay.py's checks, without a terminal: the output filter (requests out, everything else through, split
chunks, both terminators, junk after the prefix, an overlong body), the gates (a matching local input just before, used once; wheel,
motion and pasted Enters don't count), the nonce, validation, the rate limit, what a helper may hand back (inject only from paste,
allow only from new), and the bracketed paste it types (no escape or C1 gets through). J553 (10): the nonce handshake (remote.sh asks,
the relay types the nonce once, never after the panel draws), unit and through a real pty with remote.sh's own lines. Plus one real run through a pty with a fake
"ssh" that prints a request: shown screen bytes pass, the request is acted on only after a click.
   python3 test/pty-relay-unit.py   (exit 0 = pass)"""
import base64, importlib.util, json, os, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location("relay", os.path.join(ROOT, "omnistation/pty-relay.py"))
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)
fails = 0
def ok(name, cond, extra=""):
    global fails
    if not cond: fails += 1
    print(("ok   " if cond else "FAIL ") + name + (f": {extra}" if extra and not cond else ""))

N = "a" * 24
def osc(o, end=b"\x07"): return R.PREFIX + base64.b64encode(json.dumps(o).encode()) + end
def relay(): return R.Relay("H", N)

# ---- output filter
r = relay()
show, reqs = r.filter_output(b"abc" + osc({"act": "open"}) + b"def")
ok("a request is taken out, the rest shown", show == b"abcdef" and len(reqs) == 1)
show, reqs = r.filter_output(b"x" + osc({"act": "open"}, b"\x1b\\") + b"y")
ok("ESC \\ ends one too", show == b"xy" and len(reqs) == 1)
whole = b"12" + osc({"act": "panel", "kind": "board", "n": N}) + b"34"
got_show, got = b"", []
r = relay()
for i in range(0, len(whole), 3):
    s, q = r.filter_output(whole[i:i + 3]); got_show += s; got += q
ok("a request split over many chunks still comes out whole", got_show == b"1234" and len(got) == 1 and json.loads(base64.b64decode(got[0]))["kind"] == "board", repr(got_show))
r = relay(); s, q = r.filter_output(b"hi\x1b")
ok("a lone ESC at the end waits (it may start a request)…", s == b"hi" and r.held_partial())
ok("… and is shown after all when nothing follows", r.flush_output() == b"\x1b" and not r.held_partial())
r = relay(); s, q = r.filter_output(R.PREFIX + b"QUJD" + b"\x1b[31mred")
ok("a prefix followed by something else is no request: the prefix goes, the rest shows", q == [] and s == b"QUJD\x1b[31mred", repr(s))
r = relay(); s, q = r.filter_output(R.PREFIX + b"A" * (R.MAX_BODY + 10) + b"\x07tail")
ok("an overlong body is no request", q == [] and s.endswith(b"tail"))
r = relay(); s, q = r.filter_output(R.PREFIX + b"QUJD")
ok("an unfinished request is never shown", s == b"" and r.flush_output() == b"")

# ---- gates, nonce, validation
def req(o): return base64.b64encode(json.dumps({**o, "n": o.get("n", N)}).encode())
t0 = 1000.0
r = relay()
ok("no input before it: dropped", r.decide(req({"act": "open", "url": "https://x.y/"}), t0) is None)
r.note_input(b"\x1b[<16;5;5M", t0)
ok("a Ctrl+press just before: done", r.decide(req({"act": "open", "url": "https://x.y/"}), t0 + 1) == ["open", "https://x.y/"])
ok("… once only (the press is used)", r.decide(req({"act": "open", "url": "https://x.y/"}), t0 + 1.1) is None)
r.note_input(b"\x1b[<0;5;5M", t0)
ok("too long after the press: dropped", r.decide(req({"act": "open", "url": "https://x.y/"}), t0 + R.GATE_S + 0.5) is None)
r = relay(); r.note_input(b"\x1b[<64;5;5M\x1b[<35;5;5M\x1b[<0;5;5m", t0)
ok("wheel, motion and release don't count", r.decide(req({"act": "focus", "agent": "h-omni-a"}), t0) is None)
r = relay(); r.note_input(b"\x1b[200~line\rline\x1b[201~", t0)
ok("an Enter inside a pasted text doesn't count", r.decide(req({"act": "focus", "agent": "h-omni-a"}), t0) is None)
r.note_input(b"\r", t0)
ok("a typed Enter does (focus)", r.decide(req({"act": "focus", "agent": "h-omni-a"}), t0) == ["focus", "omni-a"])
r = relay(); r.note_input(b"\x1b[<0;1;1M", t0)
ok("a press doesn't allow a paste", r.decide(req({"act": "paste"}), t0) is None)
r.note_input(b"\x16", t0)
ok("Ctrl+V does", r.decide(req({"act": "paste"}), t0) == ["paste"])
r.note_input(b"\x1b[2;2~", t0)
ok("Shift+Insert (SUPER+V) does", r.decide(req({"act": "paste"}), t0) == ["paste"])
r.note_input(b"\x0e", t0)
ok("Ctrl+N allows new", r.decide(req({"act": "new"}), t0) == ["new"])
r = relay(); r.note_input(b"\x1b[<16;5;5M", t0)
ok("a wrong nonce: dropped", r.decide(req({"act": "open", "url": "https://x.y/", "n": "b" * 24}), t0) is None)
ok("no nonce: dropped", r.decide(base64.b64encode(json.dumps({"act": "open", "url": "https://x.y/"}).encode()), t0) is None)
ok("a relay without a nonce does nothing", R.Relay("H", "").decide(req({"act": "open", "url": "https://x.y/", "n": ""}), t0) is None)
for bad in [{"act": "open", "url": "javascript:alert(1)"}, {"act": "open", "url": "file:///etc/passwd"}, {"act": "open", "url": "https://x y"},
            {"act": "focus", "agent": "omni-a"}, {"act": "focus", "agent": "i-omni-a"}, {"act": "focus", "agent": "h-Omni;rm"}, {"act": "focus", "agent": "h-" + "a" * 40},
            {"act": "panel", "kind": "shell"}, {"act": "file", "path": "relative"}, {"act": "file", "path": "/x\ny"}, {"act": "exec", "cmd": "ls"}]:
    r = relay(); r.note_input(b"\x1b[<16;5;5M\r\x16\x0e", t0)
    ok(f"refused: {json.dumps(bad)}", r.decide(req(bad), t0) is None)
r = relay(); r.note_input(b"\x1b[<16;5;5M", t0)
ok("garbage: dropped", r.decide(b"!!!", t0) is None and r.decide(base64.b64encode(b"[1]"), t0) is None)
r = relay(); done = 0
for k in range(20):
    r.note_input(b"\x1b[<16;5;5M", t0 + k * 0.1)
    done += r.decide(req({"act": "open", "url": "https://x.y/"}), t0 + k * 0.1) is not None
ok(f"rate limit: at most {R.RATE_N} in {R.RATE_S} s", done == R.RATE_N, str(done))

# ---- input cut anywhere across reads (ParityCheck): the same gates byte by byte and at every split point
def feed(r, parts, t=t0):
    for x in parts: r.note_input(x, t)
def splits(seq): return [[seq[:k], seq[k:]] for k in range(1, len(seq))] + [[bytes([c]) for c in seq]]
for seq, act, extra in [(b"\x1b[2;2~", "paste", {}), (b"\x16", "paste", {}), (b"\x1b[13;5u", "focus", {"agent": "h-omni-a"}), (b"\r", "focus", {"agent": "h-omni-a"}),
                        (b"\x1b[<16;4;5M", "open", {"url": "https://x.y/"}), (b"\x1b[<0;120;33M", "panel", {"kind": "board"}), (b"\x0e", "new", {})]:
    good = True
    for parts in splits(b"ab" + seq + b"cd"):
        r = relay(); feed(r, parts)
        if r.decide(req({"act": act, **extra}), t0 + 0.1) is None or r.decide(req({"act": act, **extra}), t0 + 0.2) is not None: good = False
    ok(f"split anywhere / byte by byte: {seq!r} still allows one {act}", good)
pasted = b"\x1b[200~pasted\r\x16\x0e\x1b[<16;4;5M\x1b[13;5utext\x1b[201~"
good = True
for parts in splits(pasted):
    r = relay(); feed(r, parts)
    if any(r.decide(req(o), t0 + 0.1) is not None for o in ({"act": "open", "url": "https://x.y/"}, {"act": "paste"}, {"act": "new"}, {"act": "focus", "agent": "h-omni-a"})): good = False
ok("a bracketed paste cut anywhere / byte by byte: nothing inside it counts", good)
r = relay(); feed(r, splits(pasted)[-1]); r.note_input(b"\r", t0)
ok("… and a real Enter after it does", r.decide(req({"act": "focus", "agent": "h-omni-a"}), t0 + 0.1) == ["focus", "omni-a"])
# (ParityCheck) the same splits with a SLOW second read (scheduler, backpressure): a cut-off CSI / paste mark still waits for its end
good = True
for parts in splits(pasted):
    if len(parts) != 2: continue  # (k = 1, a cut right after the ESC, too: ParityCheck)
    r = relay(); r.note_input(parts[0], t0); r.note_input(parts[1], t0 + R.TAIL_S + 5)
    if any(r.decide(req(o), t0 + R.TAIL_S + 5.1) is not None for o in ({"act": "open", "url": "https://x.y/"}, {"act": "paste"}, {"act": "new"}, {"act": "focus", "agent": "h-omni-a"})): good = False
ok("a bracketed paste cut anywhere with a slow second read: nothing inside it counts", good)
good = True
for seq, act, extra in [(b"\x1b[2;2~", "paste", {}), (b"\x1b[<16;4;5M", "open", {"url": "https://x.y/"})]:
    for k in range(1, len(seq)):
        r = relay(); r.note_input(seq[:k], t0); r.note_input(seq[k:], t0 + R.TAIL_S + 5)
        if r.decide(req({"act": act, **extra}), t0 + R.TAIL_S + 5.1) is None: good = False
ok("a key or click cut with a slow second read still counts once", good)
r = relay(); r.note_input(b"\x1b", t0); r.note_input(b"\r", t0 + R.TAIL_S + 0.1)
ok("a lone Esc key, then Enter a moment later: the Enter counts (not read as Alt+Enter)", r.decide(req({"act": "focus", "agent": "h-omni-a"}), t0 + R.TAIL_S + 0.2) == ["focus", "omni-a"])
r = relay(); r.note_input(b"\x1b[" + b"1;" * 60, t0); r.note_input(b"\r", t0)
ok("an endless unfinished sequence isn't kept forever", len(r.in_tail) <= 64)

# ---- what helpers hand back
r = relay()
ok("inject only from a paste helper", r.helper_output(b'{"inject": "x"}', "open", t0) == b"" and r.helper_output(b'{"inject": "x"}', "paste", t0) == b"\x1b[200~x\x1b[201~")
r.helper_output(b'{"allow": "omni-new"}', "focus", t0)
ok("allow only from a new helper", r.decide(req({"act": "focus", "agent": "h-omni-new"}), t0 + 1) is None)
r.helper_output(b'{"allow": "omni-new"}', "new", t0)
ok("a jump to the agent the laptop just started: allowed without a click…", r.decide(req({"act": "focus", "agent": "h-omni-new"}), t0 + 5) == ["focus", "omni-new"])
ok("… once", r.decide(req({"act": "focus", "agent": "h-omni-new"}), t0 + 6) is None)
r.helper_output(b'{"allow": "omni-late"}', "new", t0)
ok("… and not after ALLOW_S", r.decide(req({"act": "focus", "agent": "h-omni-late"}), t0 + R.ALLOW_S + 1) is None)
b = R.bracketed("a\x1b[201~\x1b]52;c;x\x07b\r\nc\x9bd\x00")
ok("a pasted text can't end the paste early or carry escapes", b == b"\x1b[200~a[201~]52;c;xb\ncd\x1b[201~", repr(b))

# ---- J553 (10): the nonce is typed in when remote.sh asks, never on a command line
r = relay(); s_, q = r.filter_output(b"ssh noise" + R.ASK + b"more")
ok("ask: taken off the screen", s_ == b"ssh noisemore" and q == [], repr(s_))
ok("ask: answered with the nonce, as one line to type", r.take_answer() == b"hyprpi-nonce:" + N.encode() + b"\n" and r.take_answer() == b"")
r.filter_output(R.ASK)
ok("ask: only once a run", r.take_answer() == b"")
r = relay(); r.filter_output(b"\x1b[?1049h\x1b[H frame"); r.filter_output(R.ASK)
ok("ask: refused once the panel draws (alternate screen): an agent's text can't get it", r.take_answer() == b"" and r.started)
r = relay(); r.filter_output(b"x\x1b[?10"); r.filter_output(b"06h y"); r.filter_output(b"z" + R.ASK)
ok("ask: refused after a mouse mode, even one split across reads", r.take_answer() == b"" and r.started)
r = relay(); r.filter_output(b"a" * (R.STARTED_BYTES + 1)); r.filter_output(R.ASK)
ok("ask: refused after a lot of output", r.take_answer() == b"")
r = R.Relay("H", ""); s_, _ = r.filter_output(R.ASK)
ok("ask: a relay without a nonce answers nothing (and still hides the ask)", r.take_answer() == b"" and s_ == b"")
r = relay(); got = b""
for i in range(len(R.ASK)): got += r.filter_output(R.ASK[i:i + 1])[0]
ok("ask: split byte by byte, still taken off and answered", got == b"" and r.take_answer().startswith(b"hyprpi-nonce:"), repr(got))
r = relay(); r.filter_output(R.ASK[:15])
ok("ask: a half-arrived ask isn't flushed to the screen by the 30 ms timer", not r.held_partial())
r = relay(); s_, q = r.filter_output(R.ASK + osc({"act": "open", "url": "https://x.y/", "n": N}))
ok("ask then a request in one chunk: both handled", s_ == b"" and len(q) == 1 and r.take_answer())

# ---- one real run: a pty, a fake ssh that prints a request, a stand-in for laptop-act
with tempfile.TemporaryDirectory() as T:
    act_log = os.path.join(T, "acts")
    stub = os.path.join(T, "act"); open(stub, "w").write(f"#!/bin/sh\necho \"$*\" >> {act_log}\n"); os.chmod(stub, 0o755)
    o = osc({"act": "open", "url": "https://ok.example/", "n": N}).decode()
    fake = os.path.join(T, "fake")
    # prints a request at once (no click yet: dropped), then waits for a line (the "click" makes the line), prints it again, exits 7
    open(fake, "w").write(f"#!/usr/bin/env python3\nimport sys,os,time,tty\ntty.setraw(0)\nsys.stdout.write('screen-a{o}screen-b'); sys.stdout.flush()\nos.read(0, 100)\ntime.sleep(0.3)\nsys.stdout.write('{o}screen-c'); sys.stdout.flush(); time.sleep(0.5); sys.exit(7)\n")
    os.chmod(fake, 0o755)
    env = {**os.environ, "HYPRPI_TEST": "1", "HYPRPI_RELAY_ACT": stub, "HYPRPI_RELAY_NONCE": N}
    p = subprocess.Popen(["python3", os.path.join(ROOT, "omnistation/pty-relay.py"), "H", "--", fake], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    time.sleep(1.0)
    p.stdin.write(b"\x1b[<16;3;3M"); p.stdin.flush()
    try: out, _ = p.communicate(timeout=15)
    except subprocess.TimeoutExpired: p.kill(); out, _ = p.communicate()
    time.sleep(0.5)
    acts = open(act_log).read().split("\n") if os.path.exists(act_log) else []
    ok("real run: the screen bytes pass, the requests don't", b"screen-a" in out and b"screen-b" in out and b"screen-c" in out and b"5379" not in out, repr(out))
    ok("real run: only the request after the click is done", [a for a in acts if a] == ["H open https://ok.example/"], repr(acts))
    ok("real run: the command's exit code comes back", p.returncode == 7, str(p.returncode))

# ---- J553 (10): a real handshake through a pty, with remote.sh's own lines (cut out of it): the nonce reaches the "panel"'s
# environment, never its command line or the screen
src = open(os.path.join(ROOT, "omnistation/remote.sh")).read()
a = src.index('    if [[ "${HYPRPI_LAPTOP_RELAY:-}" == ask ]]; then'); b = src.index("    exec node \"$DIR/mockups/$kind-tui.mjs\"")
snippet = src[a:b]
with tempfile.TemporaryDirectory() as T:
    out_f = os.path.join(T, "env")
    fake = os.path.join(T, "fake.sh")
    open(fake, "w").write("#!/bin/bash\nset -euo pipefail\n" + snippet + f"echo \"got=${{HYPRPI_LAPTOP_RELAY:-none}}\" > {out_f}\nprintf '\\033[?1049hpanel-drawn'\nstty -a | grep -qw -- '-echo' && echo ' echo-off' || echo ' echo-on'\nsleep 0.3\n")
    os.chmod(fake, 0o755)
    env = {**os.environ, "HYPRPI_TEST": "1", "HYPRPI_RELAY_NONCE": N, "HYPRPI_LAPTOP_RELAY": "ask"}
    t1 = time.monotonic()
    p = subprocess.Popen(["python3", os.path.join(ROOT, "omnistation/pty-relay.py"), "H", "--", fake], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    try: out, _ = p.communicate(timeout=30)
    except subprocess.TimeoutExpired: p.kill(); out, _ = p.communicate()
    got = open(out_f).read().strip() if os.path.exists(out_f) else ""
    ok("handshake: remote.sh's lines get the nonce from the relay (quickly)", got == "got=" + N and time.monotonic() - t1 < 10, got + " " + repr(out))
    ok("handshake: neither the ask nor the nonce reaches the screen; the panel's output does", N.encode() not in out and b"5379" not in out and b"panel-drawn" in out, repr(out))
    ok("handshake: the terminal's echo is back on for the panel", b"echo-on" in out, repr(out))
    env["HYPRPI_RELAY_NONCE"] = ""
    t1 = time.monotonic()
    p = subprocess.Popen(["python3", os.path.join(ROOT, "omnistation/pty-relay.py"), "H", "--", fake], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    try: out, _ = p.communicate(timeout=40)
    except subprocess.TimeoutExpired: p.kill(); out, _ = p.communicate()
    got = open(out_f).read().strip() if os.path.exists(out_f) else ""
    ok("handshake: no nonce at the relay: the panel starts without one (after remote.sh's wait)", got == "got=none" and b"panel-drawn" in out, got + " " + repr(out))

print("pty-relay-unit: " + (f"{fails} FAILED" if fails else "all pass"))
sys.exit(1 if fails else 0)
