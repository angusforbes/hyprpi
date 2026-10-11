#!/usr/bin/env python3
"""J465 (Angus: "i would like to be able to ctrl+click on the report returned via doorman"): a research report in the world's inbox,
given as a file:// link, passes the link gate and opens (a vetted copy) in the world's Brave; a bare path, the inbox folder itself and
anything outside the world's shares are refused. Uses the LIVE world-g config and a real report in its inbox (read-only); the browser,
Hyprland and toasts are stubs. Run: python3 docker/world/test-report-link.py"""
import glob, importlib.util, json, os, shutil, tempfile, time, urllib.parse
reports = sorted(glob.glob(os.path.expanduser("~/Work/sbx-inbox/world-g/research-*.md")))
if not reports: print("test-report-link: SKIP (no research report in world-g's inbox)"); raise SystemExit(0)
R = reports[0]; T = tempfile.mkdtemp(prefix="report-link-")
def stub(name, body):
    p = f"{T}/{name}"; open(p, "w").write("#!/bin/sh\n" + body + "\n"); os.chmod(p, 0o755); return p
brave = stub("brave-stub", f'printf "%s\\n" "$*" >> {T}/brave.log')
hyprctl = stub("hyprctl", 'if [ "$1" = clients ]; then echo "[]"; fi')
stub("notify-send", "exit 0")
os.environ["PATH"] = T + ":" + os.environ["PATH"]
# (J465Check) writes (rate stamps, toast markers, snapshots) go to temp: the live world-g share list is copied, read-only use
LIVE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "hyprpi", "sandboxes", "world-g", "managed.json")
os.makedirs(f"{T}/state/hyprpi/sandboxes/world-g"); open(f"{T}/state/hyprpi/sandboxes/world-g/managed.json", "w").write(open(LIVE).read())
os.environ.update(XDG_RUNTIME_DIR=T, XDG_STATE_HOME=f"{T}/state", HYPRPI_HYPRCTL=hyprctl, HYPRPI_G_AGENT_OPENER=brave, HYPRPI_G_OPENER=brave)
spec = importlib.util.spec_from_file_location("g", os.path.join(os.path.dirname(os.path.abspath(__file__)), "g_open_url.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
log = lambda: [l for l in (open(f"{T}/brave.log").read().split("\n") if os.path.exists(f"{T}/brave.log") else []) if l]
url = "file://" + urllib.parse.quote(R)
assert g.main(["g_open_url.py", "--agent", url, "world-g"]) == 0, "the report's file:// link opens"
time.sleep(0.3); opened = [l for l in log() if l][-1]
assert opened.startswith("-- file://" + T) and opened.endswith("/" + os.path.basename(R)), opened
copy = opened[len("-- file://"):]; assert open(copy).read() == open(R).read(), "what opens is a copy of exactly the report"
print("ok a report's file:// link opens a vetted copy in the world's Brave:", os.path.basename(R))
n = len(log())
for bad, why in [(R, "a bare path"), ("file://" + os.path.dirname(R) + "/", "the inbox folder itself"), ("file://" + os.path.expanduser("~/.ssh/config"), "~/.ssh"),
                 ("file:///etc/passwd", "outside the home folder"), ("file://" + os.path.dirname(R) + "/../../../.ssh/config", "a ../ escape"), ("file://otherhost" + R, "another host")]:
    assert g.main(["g_open_url.py", "--agent", bad, "world-g"]) == 1, why
    print("ok refused:", why)
assert len(log()) == n, "nothing else opened"
# J465 v3: Angus's click on the report opens it with the HOST desktop's default app for .md (xdg-open; no config override),
# not in Brave; http(s) and an HTML page still go to the world's Brave; an agent's own open always goes to the Brave
xdg = stub("xdg-open-stub", f'printf "%s\\n" "$*" >> {T}/xdg.log')
os.environ["HYPRPI_G_XDG_OPEN"] = xdg
rd = lambda f: [l for l in (open(f"{T}/{f}").read().split("\n") if os.path.exists(f"{T}/{f}") else []) if l]
nb = len(log()); assert g.main(["g_open_url.py", url, "world-g"]) == 0; time.sleep(0.3)
x = rd("xdg.log"); assert len(x) == 1 and x[0].startswith(T) and x[0].endswith("/" + os.path.basename(R)), x
assert open(x[0]).read() == open(R).read() and len(log()) == nb, "the vetted copy goes to the host's default app (xdg-open), not Brave"
print("ok no config: Ctrl+click on the report opens a vetted copy with the desktop's default app for .md (xdg-open)")
n0 = 0
assert g.main(["g_open_url.py", "https://example.org/x", "world-g"]) == 0; time.sleep(0.2); assert log()[-1] == "-- https://example.org/x", log()[-1:]
html = os.path.expanduser("~/Work/cube-art/index.html")
if os.path.exists(html):
    nb = len(log()); assert g.main(["g_open_url.py", "file://" + html, "world-g"]) == 0; time.sleep(0.3); assert len(log()) == nb + 1 and log()[-1].endswith("/index.html"), "an HTML page opens in the world's Brave"
nb = len(log()); assert g.main(["g_open_url.py", "--agent", url, "world-g"]) == 0; time.sleep(0.3); assert len(log()) == nb + 1 and len(rd("xdg.log")) == 1, "an agent's open goes to the Brave, never an app"
print("ok http(s) and an HTML page still open in the world's Brave; an agent's own open of the report goes to the Brave, never to an app")
nb = len(log()); nx = len(rd("xdg.log"))
for bad in [R, "file://" + os.path.expanduser("~/.ssh/config"), "file:///etc/passwd"]: assert g.main(["g_open_url.py", bad, "world-g"]) == 1
assert len(log()) == nb and len(rd("xdg.log")) == nx, "refused links reach no app at all"
print("ok the share check comes first: refused links reach no app")
# (J465Check HIGH) only real Markdown opens in a host app: HTML disguised as .md, .svg, .xhtml, .HTML, .txt go to the world's Brave
# (J465Check) the fixtures live in the test's own temp dir, added as a share to the COPIED share list: never written into a live share
F = os.path.join(T, "fixture-share"); os.makedirs(F)
mj = f"{T}/state/hyprpi/sandboxes/world-g/managed.json"; ms = json.load(open(mj)); ms.append({"host": F, "at": F, "ro": True, "why": "test"}); json.dump(ms, open(mj, "w"))
try:
    cases = {"plain.md": ("# A report\n\nplain text\n", "app"), "fake.md": ("<!DOCTYPE html><html><body><script>1</script></body></html>", "brave"),
             "pic.svg": ("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", "brave"), "page.xhtml": ("<html xmlns='http://www.w3.org/1999/xhtml'></html>", "brave"),
             "PAGE.HTML": ("<html></html>", "brave"), "notes.txt": ("plain\n", "brave")}
    for name, (body, where) in cases.items():
        open(os.path.join(F, name), "w").write(body); na, nb = len(rd("xdg.log")), len(log())
        assert g.main(["g_open_url.py", "file://" + urllib.parse.quote(os.path.join(F, name)), "world-g"]) == 0, name; time.sleep(0.3)
        got = "app" if len(rd("xdg.log")) == na + 1 and len(log()) == nb else "brave" if len(log()) == nb + 1 and len(rd("xdg.log")) == na else "?"
        assert got == where, (name, got)
        print(f"ok {name}: {'the host app' if where == 'app' else 'the world Brave'}")
    # (J465Check LOW) the production branch: the desktop's default for text/markdown, launched with gio (stubbed xdg-mime, gio and data dir)
    del os.environ["HYPRPI_G_XDG_OPEN"]; os.makedirs(f"{T}/data/applications"); open(f"{T}/data/applications/md-viewer.desktop", "w").write("[Desktop Entry]\nExec=true %f\n")
    os.environ["XDG_DATA_HOME"] = f"{T}/data"; os.environ["XDG_DATA_DIRS"] = f"{T}/none"
    stub("xdg-mime", f'if [ "$2" = filetype ]; then echo text/plain; elif [ "$3" = text/markdown ]; then cat {T}/default 2>/dev/null; fi')
    gio = stub("gio", f'printf "%s\\n" "$*" >> {T}/gio.log')
    open(f"{T}/default", "w").write("md-viewer.desktop\n"); nb = len(log())
    assert g.main(["g_open_url.py", "file://" + os.path.join(F, "plain.md"), "world-g"]) == 0; time.sleep(0.3)
    gl = rd("gio.log"); assert len(gl) == 1 and gl[0].startswith(f"launch {T}/data/applications/md-viewer.desktop {T}") and gl[0].endswith("/plain.md") and len(log()) == nb, gl
    print("ok production branch: gio launch <the desktop's text/markdown default> <the vetted copy>")
    open(f"{T}/default", "w").write("../evil.desktop\n"); nb = len(log())
    assert g.main(["g_open_url.py", "file://" + os.path.join(F, "plain.md"), "world-g"]) == 0; time.sleep(0.3)
    assert len(rd("gio.log")) == 1 and len(log()) == nb + 1, "a bad or missing default → the world's Brave"
    open(f"{T}/default", "w").write(""); nb = len(log())
    assert g.main(["g_open_url.py", "file://" + os.path.join(F, "plain.md"), "world-g"]) == 0; time.sleep(0.3)
    assert len(rd("gio.log")) == 1 and len(log()) == nb + 1
    print("ok no default app (or a bad id) for text/markdown: the world's Brave")
finally:
    shutil.rmtree(F, ignore_errors=True)
print("test-report-link: all pass")
