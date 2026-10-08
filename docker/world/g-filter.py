#!/usr/bin/env python3
# g-filter: runs on the HOST between a sandboxed world's program (`sbx exec -it …`) and the kitty window
# that shows it (J262, review finding #1). The sandbox's output is untrusted terminal bytes; kitty would
# act on some escape sequences in ways that reach the host:
#   APC _G…   kitty graphics protocol (t=f / t=t / t=s can make kitty read a HOST file or shared memory)
#   OSC 52    clipboard write / read
#   OSC 8     hyperlinks (Ctrl+click opens them on the host)
#   OSC 5113  kitty file transfer
#   OSC 99 / 777 / 9   desktop notifications
#   OSC 1337 / 7 / 133 / 633 / 6 / 7772   misc integrations (file names, cwd reports, …)
#   DCS …     device control strings (tmux passthrough, sixel, XTGETTCAP …), PM and SOS strings
# This filter passes everything else unchanged (normal text, colours, cursor movement, mouse and title
# OSC 0/1/2, colour OSC 4/10/11/12/104/110-112) and drops those sequences whole. Input (keys, mouse, paste)
# goes to the program unchanged. Usage: g-filter.py COMMAND [ARGS…]
import os, pty, sys, select, signal, termios, tty, fcntl, struct

ESC = 0x1b
KEEP_OSC = {b"0", b"1", b"2", b"4", b"10", b"11", b"12", b"104", b"110", b"111", b"112", b"22", b"30001", b"30101"}

C1_STR = (0x90, 0x98, 0x9d, 0x9e, 0x9f)   # DCS, SOS, OSC, PM, APC as C1 code points (UTF-8: C2 90 … C2 9F)

class Filter:
    """Streaming filter over UTF-8 output: holds an unfinished escape sequence until it completes (max 1 MiB,
    then drops it). C1 controls are only recognised as UTF-8-encoded code points (C2 9D …), never as a
    raw byte: 0x9D is an ordinary continuation byte inside characters like ❯ (E2 9D AF)."""
    def __init__(self):
        self.buf = b""
    def feed(self, data: bytes) -> bytes:
        self.buf += data
        out = bytearray()
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
                    if k == 0x5d and self._keep_osc(b[i + 2:end]):
                        out += b[i:end + tl]
                    i = end + tl
                    continue
                out += b[i:i + 2]; i += 2  # other ESC x (CSI etc.): the rest follows as plain bytes
                continue
            if c == 0xC2:
                if i + 1 >= n: break  # need the second byte
                if b[i + 1] in C1_STR:
                    end, tl = self._string_end(b, i + 2, bel=(b[i + 1] == 0x9d))
                    if end < 0:
                        if n - i > (1 << 20): i = n
                        break
                    i = end + tl  # C1-introduced strings are always dropped
                    continue
            # plain bytes up to the next ESC or C2
            j = i + 1
            while j < n and b[j] != ESC and b[j] != 0xC2:
                j += 1
            out += b[i:j]; i = j
        self.buf = b[i:]
        return bytes(out)
    @staticmethod
    def _string_end(b, start, bel=True):
        # BEL ends only an OSC (xterm); DCS / APC / PM / SOS end only at ST (ESC \ or C1 ST = C2 9C)
        j = start
        while j < len(b):
            if b[j] == ESC:
                if j + 1 >= len(b): return -1, 0
                if b[j + 1] == ESC: j += 2; continue          # tmux passthrough doubles ESC
                if b[j + 1] == 0x5c: return j, 2              # ESC \
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
    f = Filter()
    try:
        while True:
            try: r, _, _ = select.select([0, fd], [], [])
            except InterruptedError: continue
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
