#!/usr/bin/env python3
# g-filter: runs on the HOST between a sandboxed world's program (`sbx exec -it …`) and the kitty window
# that shows it (J262, review finding #1). The sandbox's output is untrusted terminal bytes; kitty would
# act on some escape sequences in ways that reach the host:
#   APC _G…   kitty graphics protocol (t=f / t=t / t=s can make kitty read a HOST file or shared memory)
#   OSC 52    clipboard write / read
#   OSC 8     hyperlinks (Ctrl+click opens them on the host), EXCEPT (J359) a file:// link to a folder shared with the
#             sandbox (not hidden, no symlink; g_open_url.check) whose visible text is exactly that path: it is
#             re-emitted in canonical form so Pi's clickable tool-line paths work; everything else is stripped
#   OSC 5113  kitty file transfer
#   OSC 99 / 777 / 9   desktop notifications
#   OSC 1337 / 7 / 133 / 633 / 6 / 7772   misc integrations (file names, cwd reports, …)
#   DCS …     device control strings (tmux passthrough, sixel, XTGETTCAP …), PM and SOS strings
# This filter passes everything else unchanged (normal text, colours, cursor movement, mouse and title
# OSC 0/1/2, colour OSC 4/10/11/12/104/110-112) and drops those sequences whole. Input (keys, mouse, paste)
# goes to the program unchanged. Usage: g-filter.py COMMAND [ARGS…]
import os, pty, re, sys, select, signal, termios, tty, fcntl, struct, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
WORLD = os.environ.get("G_WORLD", "")
LINK_MAX = 2048   # bytes of visible text a vetted link may span
CSI = re.compile(rb"\x1b\[[0-9;:]*m")   # only colour/style (SGR) sequences may sit inside a link's text, and not conceal (8 / 28; see sgr_ok).
# Honest limit: cursor/erase sequences OUTSIDE a link can still edit what is shown next to it; the target is always a shared,
# visible file, so the worst case is a misleading label on another allowed file.
def sgr_ok(seq: bytes) -> bool:
    """False for an SGR containing conceal (8) or its reset (28); extended colours (38/48/58 ; 5;n | 2;r;g;b) are skipped over."""
    ps = [x for x in re.split(rb"[;:]", seq[2:-1])]
    k = 0
    while k < len(ps):
        v = ps[k] or b"0"
        if v in (b"38", b"48", b"58"): k += 3 if k + 1 < len(ps) and ps[k + 1] == b"5" else 5; continue
        if v in (b"8", b"28"): return False
        k += 1
    return True
SAFE_BODY = re.compile(rb"[\x20-\x7e\x80-\xff]*")   # a kept OSC body: printable only (no control characters, no ESC)


def vet_link(uri: bytes, world: str):
    """The canonical file:// URI for a link the filter may let through, else None. Only g_open_url's own check decides."""
    try:
        u = uri.decode("utf-8")
        if not u.startswith("file://") or not world: return None
        import g_open_url
        ok, out = g_open_url.check(u, world, snap=False)
        return out if ok else None
    except Exception:
        return None

ESC = 0x1b
KEEP_OSC = {b"0", b"1", b"2", b"4", b"10", b"11", b"12", b"104", b"110", b"111", b"112", b"22", b"30001", b"30101"}

C1_STR = (0x90, 0x98, 0x9d, 0x9e, 0x9f)   # DCS, SOS, OSC, PM, APC as C1 code points (UTF-8: C2 90 … C2 9F)

class Filter:
    """Streaming filter over UTF-8 output: holds an unfinished escape sequence until it completes (max 1 MiB,
    then drops it). C1 controls are only recognised as UTF-8-encoded code points (C2 9D …), never as a
    raw byte: 0x9D is an ordinary continuation byte inside characters like ❯ (E2 9D AF)."""
    def __init__(self, world: str = ""):
        self.buf = b""
        self.world = world
        self.link = None   # a vetted OSC 8 open being checked: {"uri": canonical, "path": str, "text": bytearray, "bad": bool}
    def _finish_link(self, out, ok_close=True):
        """The visible text between open and close decides: exactly the path (SGR colours around it are fine), else no link."""
        L, self.link = self.link, None
        text = bytes(L["text"])
        plain = CSI.sub(b"", text)
        good = ok_close and not L["bad"] and all(sgr_ok(m.group()) for m in CSI.finditer(text))
        good = good and b"\x1b" not in plain and b"\n" not in plain and re.fullmatch(re.escape(L["path"]) + r"(:\d+(-\d+)?)?", plain.decode("utf-8", "replace")) is not None
        if good: out += b"\x1b]8;;" + L["uri"].encode() + b"\x1b\\" + text + b"\x1b]8;;\x1b\\"
        else: out += text
    def feed(self, data: bytes) -> bytes:
        self.buf += data
        out = bytearray()
        def put(x):  # plain output goes to the output, or into the link being checked
            if self.link is None: out.extend(x); return
            self.link["text"] += x
            if len(self.link["text"]) > LINK_MAX: self._finish_link(out, ok_close=False)
        b = self.buf
        i, n = 0, len(b)
        while i < n:
            c = b[i]
            if c == ESC:
                if i + 1 >= n: break  # need more
                k = b[i + 1]
                if k in (0x5d, 0x50, 0x5f, 0x5e, 0x58):  # ] OSC, P DCS, _ APC, ^ PM, X SOS
                    end, tl = self._string_end(b, i + 2, bel=(k == 0x5d))
                    if end < 0:
                        if n - i > (1 << 20): i = n  # absurd: drop it
                        break
                    body = b[i + 2:end]
                    if tl == 0:   # aborted by a stray ESC: dropped whole (malformed), and a link in progress is void
                        if self.link is not None: self.link["bad"] = True
                        i = end; continue
                    if k == 0x5d and body.startswith(b"8;"):
                        self._osc8(body, out)
                    elif k == 0x5d and self._keep_osc(body):
                        if self.link is not None: self.link["bad"] = True  # anything but text inside a link: no link
                        if SAFE_BODY.fullmatch(body): put(b"\x1b]" + body + b"\x1b\\")   # re-emitted canonically (ST), only if plain text
                    i = end + tl
                    continue
                put(b[i:i + 2]); i += 2  # other ESC x (CSI etc.): the rest follows as plain bytes
                continue
            if c == 0xC2:
                if i + 1 >= n: break  # need the second byte
                if b[i + 1] in C1_STR:
                    end, tl = self._string_end(b, i + 2, bel=(b[i + 1] == 0x9d))
                    if end < 0:
                        if n - i > (1 << 20): i = n
                        break
                    i = end + tl if tl else end  # C1-introduced strings are always dropped
                    continue
            # plain bytes up to the next ESC or C2
            j = i + 1
            while j < n and b[j] != ESC and b[j] != 0xC2:
                j += 1
            put(b[i:j]); i = j
        self.buf = b[i:]
        return bytes(out)
    def flush_pending(self) -> bytes:
        """No close arrived and the stream went quiet: show the held text as plain text (never as a link)."""
        out = bytearray()
        if self.link is not None: self._finish_link(out, ok_close=False)
        return bytes(out)
    def _osc8(self, body: bytes, out):
        """OSC 8 ; params ; URI. A close (empty URI) ends a vetted link; any other open is vetted: a file link to a shared,
        visible path may start a link (re-emitted canonically at its close if the text matches); everything else is dropped."""
        parts = body.split(b";", 2)
        uri = parts[2] if len(parts) == 3 else b""
        if self.link is not None:
            self._finish_link(out, ok_close=(uri == b""))  # a new open inside a link, or the close
            if uri == b"": return
        if uri == b"": return
        canon = vet_link(uri, self.world)
        if canon:
            path = urllib.parse.unquote(urllib.parse.urlsplit(canon).path)
            self.link = {"uri": canon, "path": path, "text": bytearray(), "bad": False}
    @staticmethod
    def _string_end(b, start, bel=True):
        # BEL ends only an OSC (xterm); DCS / APC / PM / SOS end only at ST (ESC \ or C1 ST = C2 9C)
        j = start
        while j < len(b):
            if b[j] == ESC:
                if j + 1 >= len(b): return -1, 0
                if b[j + 1] == 0x5c: return j, 2              # ESC \
                return j, 0   # J359 (review): an ESC that doesn't start ST aborts the string at once, as a terminal does (never skipped:
                              # that parser mismatch let a nested OSC 8 through inside a kept title); the sequence is dropped, parsing resumes at the ESC
            elif bel and b[j] == 0x07: return j, 1            # BEL
            elif b[j] == 0xC2 and j + 1 < len(b) and b[j + 1] == 0x9c: return j, 2   # C1 ST
            j += 1
        return -1, 0
    @staticmethod
    def _keep_osc(body: bytes) -> bool:
        return body.split(b";", 1)[0] in KEEP_OSC

def main():
    if len(sys.argv) < 2:
        print("usage: g-filter.py COMMAND [ARGS...]", file=sys.stderr); sys.exit(2)
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(sys.argv[1], sys.argv[1:])
    def winch(*_):
        try:
            sz = fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, sz)
            os.kill(pid, signal.SIGWINCH)
        except Exception: pass
    signal.signal(signal.SIGWINCH, winch); winch()
    old = None
    if os.isatty(0):
        old = termios.tcgetattr(0); tty.setraw(0)
    f = Filter(WORLD)
    try:
        while True:
            try: r, _, _ = select.select([0, fd], [], [], 0.3 if f.link is not None else None)
            except InterruptedError: continue
            if not r:
                o = f.flush_pending()
                if o: os.write(1, o)
                continue
            if fd in r:
                try: d = os.read(fd, 65536)
                except OSError: break
                if not d: break
                o = f.feed(d)
                if o: os.write(1, o)
            if 0 in r:
                d = os.read(0, 65536)
                if not d: break
                os.write(fd, d)
    finally:
        if old: termios.tcsetattr(0, termios.TCSADRAIN, old)
    _, st = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(st) if hasattr(os, "waitstatus_to_exitcode") else 0)

if __name__ == "__main__":
    main()
