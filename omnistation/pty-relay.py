#!/usr/bin/env python3
"""omnistation/pty-relay.py LETTER -- CMD ARGS... (J543): the laptop end of a REMOTE world's panel window.

omnistation/panel-loop.sh runs the panel's ssh (CMD, which runs the panel on the remote machine) through this relay instead of
straight in the kitty window: CMD gets its own pty, and the relay copies bytes both ways (raw keys and mouse in, the panel's screen
out; window size changes passed on; CMD's exit code passed back). On the way out it takes away the panel's private requests to the
laptop (lib/tui/laptop.mjs):

    ESC ] 5379 ; hyprpi ; base64(JSON {act, ..., n}) BEL      (or ESC \\ instead of BEL)

and does them HERE, on the laptop, with omnistation/laptop-act.mjs: jump to an agent's laptop window (or open it), open an http(s)
link, copy a remote file over and open it, bring up one of the world's panels, start an agent, paste the laptop's clipboard (an
image is uploaded and its remote path typed into the panel as a bracketed paste; text is pasted as text).

The remote machine, or text a remote agent prints, must not be able to drive the laptop, so a request is honoured only when ALL hold:
  - it carries this run's nonce (HYPRPI_RELAY_NONCE here; the remote panel gets it as HYPRPI_LAPTOP_RELAY in its command line);
  - it follows, within GATE_S seconds, a matching local input this relay itself passed through, used once: a mouse press or Enter
    for focus / open / file / panel, Ctrl+N or Enter for new, Ctrl+V or Shift+Insert for paste (the clipboard is never read
    otherwise); a jump to an agent the laptop just started (new) is allowed once, for ALLOW_S seconds;
  - it is well formed (known act, an agent name [a-z][a-z0-9-]{0,30} with this world's "x-" id prefix, an http(s) URL, an absolute
    path, a known panel kind) and within the rate limit (RATE_N per RATE_S seconds).
Everything else is dropped silently (and never reaches the screen).
"""
import base64, collections, errno, fcntl, hmac, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time, tty

PREFIX = b"\x1b]5379;hyprpi;"
B64 = re.compile(rb"[A-Za-z0-9+/=]*")
MAX_BODY = 8192
GATE_S = 2.5
ALLOW_S = 90.0
RATE_N, RATE_S = 8, 10.0
HERE = os.path.dirname(os.path.realpath(__file__))
ACT = os.environ.get("HYPRPI_RELAY_ACT") if os.environ.get("HYPRPI_TEST") == "1" else None  # tests: a stand-in for laptop-act
ACT = ACT.split() if ACT else ["node", os.path.join(HERE, "laptop-act.mjs")]
LOG = os.environ.get("HYPRPI_RELAY_LOG") if os.environ.get("HYPRPI_TEST") == "1" else None  # tests: what was decided, one JSON per line

NAME_RE = re.compile(r"[a-z][a-z0-9-]{0,30}")
URL_RE = re.compile(r"https?://[^\s\x00-\x1f\x7f]{1,2000}", re.I)
KINDS = {"agents", "room", "search", "board"}
# stdin tokens: bracketed paste marks, SGR mouse, other CSI / SS3 / Alt+key sequences, single bytes
TOK = re.compile(rb"\x1b\[20[01]~|\x1b\[<(\d+);\d+;\d+([Mm])|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1bO.|\x1b.|[\x00-\xff]", re.S)
# an escape sequence still unfinished at the end of a read: ESC, ESC [ params (incl. a mouse report's "<b;x;y"), ESC O
INCOMPLETE = re.compile(rb"\x1b(?:\[[0-9;?<>=]*[ -/]*|O)?\Z")
TAIL_S = 0.5
GATES = {"focus": ("press", "enter"), "open": ("press", "enter"), "file": ("press", "enter"), "panel": ("press", "enter"),
         "new": ("new", "enter"), "paste": ("paste",)}


def log(**kw):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps(kw) + "\n")


class Relay:
    def __init__(self, letter, nonce):
        self.L, self.l, self.nonce = letter, letter.lower(), nonce
        self.seen = {}           # input kind -> time of the last one not yet used
        self.in_paste = False    # inside a bracketed paste the user is typing (its Enters are text)
        self.in_tail, self.in_tail_t = b"", 0.0  # an escape sequence cut off at the end of the last read (finished by the next)
        self.allow = {}          # agent name -> until (a jump to an agent the laptop just started)
        self.acts = collections.deque()
        self.out_buf = b""
        self.helpers = []        # (Popen, act)

    # ---- input: what the user did (only what this relay forwarded counts) ----
    def note_input(self, data, now=None):
        """what the user did, from the bytes this relay forwarded. Reads can cut a sequence anywhere (b"\\x1b[20" + b"0~…"), so an
        unfinished ESC / CSI / SS3 / mouse report at the end of a read is kept and finished by the next one (ParityCheck): a pasted
        Enter never counts as a typed one, and a split Shift+Insert or click still counts. A kept ESC older than TAIL_S was a
        lone Esc key: it is taken on its own, so a later Enter isn't read as Alt+Enter."""
        now = time.monotonic() if now is None else now
        if self.in_tail and now - self.in_tail_t > TAIL_S: self.classify(self.in_tail, now); self.in_tail = b""
        data = self.in_tail + data
        m = INCOMPLETE.search(data)
        if m and len(data) - m.start() <= 64: data, self.in_tail, self.in_tail_t = data[:m.start()], data[m.start():], now
        else: self.in_tail = b""
        self.classify(data, now)

    def classify(self, data, now):
        for m in TOK.finditer(data):
            t = m.group(0)
            if t == b"\x1b[200~": self.in_paste = True; continue
            if t == b"\x1b[201~": self.in_paste = False; continue
            if self.in_paste: continue
            if m.group(1) is not None:
                b = int(m.group(1))
                if m.group(2) == b"M" and not b & 64 and not b & 32 and (b & 3) != 3: self.seen["press"] = now  # a press (not wheel / motion / release)
            elif t == b"\r" or re.fullmatch(rb"\x1b\[13(;\d+)?u", t): self.seen["enter"] = now
            elif t == b"\x16" or t == b"\x1b[2;2~": self.seen["paste"] = now
            elif t == b"\x0e": self.seen["new"] = now

    # ---- output: take the requests out, pass everything else on ----
    def filter_output(self, data):
        """-> (bytes for the screen, [request bodies]). A request's body is base64 up to BEL or ESC \\; a PREFIX followed by
        anything else (or by more than MAX_BODY bytes) is not a request: the PREFIX is dropped and the rest shown."""
        buf, show, reqs = self.out_buf + data, [], []
        while True:
            i = buf.find(PREFIX)
            if i < 0:
                keep = 0  # a partial PREFIX at the end waits for the next chunk
                for k in range(min(len(PREFIX) - 1, len(buf)), 0, -1):
                    if PREFIX.startswith(buf[-k:]): keep = k; break
                show.append(buf[:len(buf) - keep]); buf = buf[len(buf) - keep:]
                break
            show.append(buf[:i])
            rest = buf[i + len(PREFIX):]
            m = B64.match(rest)
            j = m.end()
            if j > MAX_BODY: buf = rest[j:]; continue                  # too long: not a request
            if j == len(rest) or rest[j:] == b"\x1b": buf = buf[i:]; break  # not finished yet: wait for more
            if rest[j:j + 1] == b"\x07": reqs.append(rest[:j]); buf = rest[j + 1:]; continue
            if rest[j:j + 2] == b"\x1b\\": reqs.append(rest[:j]); buf = rest[j + 2:]; continue
            buf = rest  # something else after the PREFIX: not a request; the PREFIX goes, the rest is shown
        self.out_buf = buf
        return b"".join(show), reqs

    def held_partial(self):
        """a few bytes held back that may start a PREFIX (e.g. a lone ESC at the end of a chunk)"""
        return bool(self.out_buf) and not self.out_buf.startswith(PREFIX)

    def flush_output(self):
        """what is held back, for the screen: a partial PREFIX is shown after all; an unfinished request never is"""
        b, self.out_buf = self.out_buf, b""
        return b"" if b.startswith(PREFIX) else b

    # ---- a request: checked, then done by laptop-act ----
    def decide(self, body, now=None):
        """-> argv for laptop-act, or None (with the reason logged)"""
        now = time.monotonic() if now is None else now
        try:
            req = json.loads(base64.b64decode(body, validate=True))
            assert isinstance(req, dict)
        except Exception:
            return log(drop="malformed")
        act = req.get("act")
        if not self.nonce or not isinstance(req.get("n"), str) or not hmac.compare_digest(req["n"].encode(), self.nonce.encode()):
            return log(drop="nonce", act=act)
        if act not in GATES: return log(drop="act", act=act)
        if act == "focus":
            aid = req.get("agent")
            name = aid[len(self.l) + 1:] if isinstance(aid, str) and aid.startswith(self.l + "-") else ""
            if not NAME_RE.fullmatch(name): return log(drop="agent", act=act, agent=str(aid)[:40])
            argv = ["focus", name]
        elif act == "open":
            url = req.get("url")
            if not isinstance(url, str) or not URL_RE.fullmatch(url): return log(drop="url", act=act)
            argv = ["open", url]
        elif act == "file":
            p = req.get("path")
            if not isinstance(p, str) or not p.startswith("/") or len(p) > 1024 or re.search(r"[\x00-\x1f\x7f]", p): return log(drop="path", act=act)
            argv = ["file", p]
        elif act == "panel":
            if req.get("kind") not in KINDS: return log(drop="kind", act=act)
            argv = ["panel", req["kind"]]
        else:
            argv = [act]
        # the gate: a matching local input just before (used once), or a jump to an agent the laptop just started
        gate = next((g for g in GATES[act] if now - self.seen.get(g, -1e9) <= GATE_S), None)
        if gate is None and act == "focus" and self.allow.get(argv[1], 0) >= now: gate = "allow"; del self.allow[argv[1]]
        if gate is None: return log(drop="gate", act=act)
        while self.acts and now - self.acts[0] > RATE_S: self.acts.popleft()
        if len(self.acts) >= RATE_N: return log(drop="rate", act=act)
        if gate != "allow": del self.seen[gate]
        self.acts.append(now)
        log(run=argv, gate=gate)
        return argv

    def start(self, argv):
        try:
            p = subprocess.Popen(ACT + [self.L] + argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
            self.helpers.append([p, argv[0], b""])
        except OSError:
            pass

    # what a helper printed: text to paste into the panel, or an agent it may jump to
    def helper_output(self, line, act, now=None):
        now = time.monotonic() if now is None else now
        try: o = json.loads(line)
        except Exception: return b""
        if not isinstance(o, dict): return b""
        if act == "new" and isinstance(o.get("allow"), str) and NAME_RE.fullmatch(o["allow"]): self.allow[o["allow"]] = now + ALLOW_S
        if act == "paste" and isinstance(o.get("inject"), str) and o["inject"]:
            return bracketed(o["inject"])
        return b""


def bracketed(text):
    """text as one bracketed paste, with nothing in it that could end the paste early or reach the panel as a key"""
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]", "", t)
    return b"\x1b[200~" + t.encode("utf-8", "replace")[:1 << 20] + b"\x1b[201~"


def write_all(fd, data):
    while data:
        try: n = os.write(fd, data)
        except InterruptedError: continue
        except BlockingIOError: select.select([], [fd], [], 1); continue
        data = data[n:]


def copy_winsize(src, dst):
    try: fcntl.ioctl(dst, termios.TIOCSWINSZ, fcntl.ioctl(src, termios.TIOCGWINSZ, b"\0" * 8))
    except OSError: pass


def main(argv):
    if len(argv) < 4 or argv[2] != "--" or not re.fullmatch(r"[A-I]", argv[1]):
        sys.stderr.write("usage: pty-relay.py LETTER -- CMD ARGS...\n"); return 2
    letter, cmd = argv[1], argv[3:]
    nonce = os.environ.pop("HYPRPI_RELAY_NONCE", "")
    if not re.fullmatch(r"[A-Za-z0-9]{16,64}", nonce): nonce = ""  # no nonce: requests are still taken off the screen, never done
    relay = Relay(letter, nonce)
    pid, master = pty.fork()
    if pid == 0:
        try: os.execvp(cmd[0], cmd)
        except OSError as e: sys.stderr.write(f"pty-relay: {cmd[0]}: {e.strerror}\n"); os._exit(127)
    stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
    is_tty = os.isatty(stdin)
    saved = termios.tcgetattr(stdin) if is_tty else None
    if is_tty:
        copy_winsize(stdin, master)
        tty.setraw(stdin)
    signal.signal(signal.SIGWINCH, lambda *_: is_tty and copy_winsize(stdin, master))
    for s in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(s, lambda sig, _f: (os.kill(pid, signal.SIGHUP) if sig == signal.SIGHUP else os.kill(pid, sig)))
    status = None
    stdin_open = True
    try:
        while True:
            fds = [master] + ([stdin] if stdin_open else []) + [h[0].stdout for h in relay.helpers]
            try: r, _, _ = select.select(fds, [], [], 0.03 if relay.held_partial() else 1.0)
            except InterruptedError: continue
            if not r and relay.held_partial(): write_all(stdout, relay.flush_output())  # a lone partial sequence: show it after all
            if stdin_open and stdin in r:
                try: data = os.read(stdin, 65536)
                except OSError: data = b""
                if not data: stdin_open = False
                else:
                    relay.note_input(data)
                    write_all(master, data)
            for h in list(relay.helpers):
                if h[0].stdout in r:
                    try: chunk = os.read(h[0].stdout.fileno(), 65536)
                    except OSError: chunk = b""
                    h[2] += chunk
                    while b"\n" in h[2]:
                        line, h[2] = h[2].split(b"\n", 1)
                        inj = relay.helper_output(line, h[1])
                        if inj: write_all(master, inj)
                    if not chunk:
                        relay.helpers.remove(h); h[0].stdout.close(); h[0].poll()
            if master in r:
                try: data = os.read(master, 65536)
                except OSError as e:
                    if e.errno != errno.EIO: raise
                    data = b""
                if not data: break
                show, reqs = relay.filter_output(data)
                if show: write_all(stdout, show)
                for body in reqs:
                    a = relay.decide(body)
                    if a: relay.start(a)
            for h in relay.helpers: h[0].poll()
        write_all(stdout, relay.flush_output())
    finally:
        if saved is not None: termios.tcsetattr(stdin, termios.TCSADRAIN, saved)
    _, status = os.waitpid(pid, 0)
    for h in relay.helpers:
        try: h[0].stdout.close()
        except OSError: pass
    if os.WIFEXITED(status): return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status): return 128 + os.WTERMSIG(status)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
