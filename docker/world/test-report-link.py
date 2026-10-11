#!/usr/bin/env python3
"""J465 (Angus: "i would like to be able to ctrl+click on the report returned via doorman"): a research report in the world's inbox,
given as a file:// link, passes the link gate and opens (a vetted copy) in the world's Brave; a bare path, the inbox folder itself and
anything outside the world's shares are refused. Uses the LIVE world-g config and a real report in its inbox (read-only); the browser,
Hyprland and toasts are stubs. Run: python3 docker/world/test-report-link.py"""
import glob, importlib.util, os, tempfile, time, urllib.parse
reports = sorted(glob.glob(os.path.expanduser("~/Work/sbx-inbox/world-g/research-*.md")))
if not reports: print("test-report-link: SKIP (no research report in world-g's inbox)"); raise SystemExit(0)
R = reports[0]; T = tempfile.mkdtemp(prefix="report-link-")
def stub(name, body):
    p = f"{T}/{name}"; open(p, "w").write("#!/bin/sh\n" + body + "\n"); os.chmod(p, 0o755); return p
brave = stub("brave-stub", f'printf "%s\\n" "$*" >> {T}/brave.log')
hyprctl = stub("hyprctl", 'if [ "$1" = clients ]; then echo "[]"; fi')
stub("notify-send", "exit 0")
os.environ["PATH"] = T + ":" + os.environ["PATH"]
os.environ.update(XDG_RUNTIME_DIR=T, HYPRPI_HYPRCTL=hyprctl, HYPRPI_G_AGENT_OPENER=brave, HYPRPI_G_OPENER=brave)
spec = importlib.util.spec_from_file_location("g", os.path.join(os.path.dirname(os.path.abspath(__file__)), "g_open_url.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
log = lambda: open(f"{T}/brave.log").read().split("\n") if os.path.exists(f"{T}/brave.log") else []
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
print("test-report-link: all pass")
