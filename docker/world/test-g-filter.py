#!/usr/bin/env python3
"""node-free tests for g-filter's OSC 8 handling (J359). Run: python3 docker/world/test-g-filter.py
Uses a throwaway state dir (XDG_STATE_HOME) so no real world state is read."""
import json, os, sys, tempfile
T = tempfile.mkdtemp()
os.environ["XDG_STATE_HOME"] = T
share = os.path.join(T, "share"); os.makedirs(os.path.join(share, "sub")); os.makedirs(os.path.join(T, "outside"))
hid = os.path.join(share, "hidden"); os.makedirs(hid)
for f in (os.path.join(share, "a.md"), os.path.join(share, "sub", "b.md"), os.path.join(hid, "secret.md"), os.path.join(T, "outside", "o.md")): open(f, "w").write("x")
os.symlink(os.path.join(T, "outside", "o.md"), os.path.join(share, "link.md"))
sd = os.path.join(T, "hyprpi", "sandboxes", "world-t"); os.makedirs(sd)
json.dump([{"host": share, "at": share, "ro": True, "why": "protected"}, {"host": "/x/empty", "at": hid, "ro": True, "why": "hidden"}], open(os.path.join(sd, "managed.json"), "w"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec = importlib.util.spec_from_file_location("gf", os.path.join(os.path.dirname(os.path.abspath(__file__)), "g-filter.py")); gf = importlib.util.module_from_spec(spec); spec.loader.exec_module(gf)

ST = b"\x1b\\"
def link(uri, text, st=ST): return b"\x1b]8;;" + uri.encode() + st + text + b"\x1b]8;;" + st
def run(data, world="world-t", chunks=1):
    f = gf.Filter(world); out = b""
    step = max(1, len(data) // chunks)
    for i in range(0, len(data), step): out += f.feed(data[i:i + step])
    return out + f.flush_pending()
fails = []
def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond: fails.append(name)

a = os.path.join(share, "a.md")
good = run(b"read " + link("file://" + a, a.encode()) + b":1-200\n")
check("a link to a shared file with exactly that text passes (canonical)", b"\x1b]8;;file://" + a.encode() + ST in good and good.count(b"\x1b]8;;") == 2 and a.encode() in good)
check("same, split across tiny chunks", run(b"read " + link("file://" + a, a.encode()), chunks=40).count(b"\x1b]8;;") == 2)
check("same, BEL-terminated open/close (canonicalised to ST)", b"\x07" not in run(link("file://" + a, a.encode(), b"\x07")) and run(link("file://" + a, a.encode(), b"\x07")).count(b"\x1b]8;;") == 2)
check("colour codes around the path inside the link are fine", run(link("file://" + a, b"\x1b[34m" + a.encode() + b"\x1b[0m")).count(b"\x1b]8;;") == 2)
check("a ':12-30' suffix inside the text is accepted too", run(link("file://" + a, a.encode() + b":12-30")).count(b"\x1b]8;;") == 2)
forged = run(link("file://" + a, b"https://evil.example/pay"))
check("forged: visible text differs from the target -> no link, text kept", b"\x1b]8" not in forged and b"https://evil.example/pay" in forged)
check("different shared file as text -> stripped", b"\x1b]8" not in run(link("file://" + a, os.path.join(share, "sub", "b.md").encode())))
check("http link stripped", b"\x1b]8" not in run(link("https://example.com/x", b"https://example.com/x")))
check("https link with other text stripped", b"\x1b]8" not in run(link("https://example.com/x", b"click me")))
check("javascript:/data:/ftp: stripped", all(b"\x1b]8" not in run(link(u, b"t")) for u in ("javascript:alert(1)", "data:text/html,x", "ftp://h/x")))
h = os.path.join(hid, "secret.md")
check("hidden-path file link stripped", b"\x1b]8" not in run(link("file://" + h, h.encode())))
o = os.path.join(T, "outside", "o.md")
check("outside-share file link stripped", b"\x1b]8" not in run(link("file://" + o, o.encode())))
l = os.path.join(share, "link.md")
check("a symlink inside the share stripped", b"\x1b]8" not in run(link("file://" + l, l.encode())))
check("file link to another host stripped", b"\x1b]8" not in run(link("file://evil.host" + a, a.encode())))
check("unknown world (no shares known) stripped", b"\x1b]8" not in run(link("file://" + a, a.encode()), world="world-nope"))
check("no world set stripped", b"\x1b]8" not in run(link("file://" + a, a.encode()), world=""))
check("a path with ../ that escapes the share stripped", b"\x1b]8" not in run(link("file://" + share + "/../outside/o.md", (share + "/../outside/o.md").encode())))
inner = b"\x1b]8;;file://" + a.encode() + ST + b"\x1b]0;t" + ST + a.encode() + b"\x1b]8;;" + ST
check("a kept OSC (title) inside the link text voids the link", b"\x1b]8" not in run(inner))
inner52 = b"\x1b]8;;file://" + a.encode() + ST + b"\x1b]52;c;QUJD" + ST + a.encode() + b"\x1b]8;;" + ST
check("a clipboard OSC inside a link is still dropped", b"]52" not in run(inner52))
check("a newline inside the link text voids the link", b"\x1b]8" not in run(link("file://" + a, a.encode() + b"\nmore")))
check("no close -> the held text is shown as plain text, no link", (lambda o: b"\x1b]8" not in o and a.encode() in o)(run(b"\x1b]8;;file://" + a.encode() + ST + a.encode())))
check("params (id=...) are dropped from the re-emitted open", b"id=" not in run(b"\x1b]8;id=zz;file://" + a.encode() + ST + a.encode() + b"\x1b]8;;" + ST))
check("a very long link text voids the link, text kept", (lambda o: b"\x1b]8" not in o and len(o) >= 3000)(run(link("file://" + a, b"x" * 3000))))
check("nested open: first link voided by the second", run(b"\x1b]8;;file://" + a.encode() + ST + b"A" + link("file://" + a, a.encode())).count(b"\x1b]8;;") == 2)
check("normal text, colours and title OSC pass unchanged", run(b"\x1b[31mhi\x1b[0m \x1b]0;t" + ST) == b"\x1b[31mhi\x1b[0m \x1b]0;t" + ST)
check("clipboard / graphics / notification still dropped", run(b"\x1b]52;c;x" + ST + b"\x1b_Ga=T" + ST + b"\x1b]99;;x" + ST) == b"")
check("a stray OSC 8 close is dropped", run(b"a\x1b]8;;" + ST + b"b") == b"ab")
print("\n%d failed" % len(fails) if fails else "\nall pass"); sys.exit(1 if fails else 0)
