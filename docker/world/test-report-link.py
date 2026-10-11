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
# J465 v5: Angus's click on a research report opens the HOST's vault copy in Obsidian (obsidian://open?path=…); everything else as before
gio = stub("gio-stub", f'printf "%s\\n" "$*" >> {T}/gio.log'); os.environ["HYPRPI_G_GIO"] = gio
rd = lambda f: [l for l in (open(f"{T}/{f}").read().split("\n") if os.path.exists(f"{T}/{f}") else []) if l]
F = os.path.join(T, "fixture-share"); V = os.path.join(F, "Sandbox - Research Reports"); os.makedirs(os.path.join(V, "world-g"))
mj = f"{T}/state/hyprpi/sandboxes/world-g/managed.json"; ms = json.load(open(mj)); ms.append({"host": F, "at": F, "ro": True, "why": "test"}); json.dump(ms, open(mj, "w"))
vc = os.path.join(V, "world-g", "2026-10-11 Which encapsulants (" + os.path.basename(R)[9:-3] + ").md"); open(vc, "w").write("---\nsandbox: world-g\n---\n# r\n")
ixf = f"{T}/vault-index.json"; json.dump({"world-g/" + os.path.basename(R): vc}, open(ixf, "w"))
g.VAULT_DIR, g.VAULT_INDEX = V, ixf
nb = len(log()); assert g.main(["g_open_url.py", url, "world-g"]) == 0; time.sleep(0.3)
gl = rd("gio.log"); assert gl == ["open obsidian://open?path=" + urllib.parse.quote(os.path.realpath(vc), safe="/")] and len(log()) == nb, gl
print("ok Ctrl+click on the inbox report opens its vault copy in Obsidian (obsidian://open?path=…), not Brave")
assert g.main(["g_open_url.py", "file://" + urllib.parse.quote(vc), "world-g"]) == 0; time.sleep(0.3); assert len(rd("gio.log")) == 2 and len(log()) == nb
print("ok Ctrl+click on the vault copy itself opens it in Obsidian too")
nb = len(log()); assert g.main(["g_open_url.py", "--agent", url, "world-g"]) == 0; time.sleep(0.3); assert len(log()) == nb + 1 and len(rd("gio.log")) == 2
print("ok an agent's own open of the report goes to the world's Brave, never to Obsidian")
json.dump({}, open(ixf, "w")); nb = len(log()); assert g.main(["g_open_url.py", url, "world-g"]) == 0; time.sleep(0.3); assert len(log()) == nb + 1 and len(rd("gio.log")) == 2
print("ok a report with no vault copy opens (its vetted copy) in the world's Brave")
json.dump({"world-g/" + os.path.basename(R): "/etc/passwd"}, open(ixf, "w")); nb = len(log()); assert g.main(["g_open_url.py", url, "world-g"]) == 0; time.sleep(0.3); assert len(rd("gio.log")) == 2 and len(log()) == nb + 1
print("ok an index entry pointing outside the vault folder is ignored (Brave)")
for name, body in {"other.md": "# x\n", "fake.md": "<html><script>1</script></html>", "page.HTML": "<html></html>"}.items():
    open(os.path.join(F, name), "w").write(body); nb = len(log())
    assert g.main(["g_open_url.py", "file://" + os.path.join(F, name), "world-g"]) == 0; time.sleep(0.3); assert len(log()) == nb + 1 and len(rd("gio.log")) == 2, name
print("ok any other file (a plain .md, HTML disguised as .md, .HTML) still opens in the world's Brave")
assert g.main(["g_open_url.py", "https://example.org/x", "world-g"]) == 0; time.sleep(0.2); assert log()[-1] == "-- https://example.org/x"
print("ok http(s) still opens in the world's Brave")
nb = len(log()); ng = len(rd("gio.log"))
for bad in [R, "file://" + os.path.expanduser("~/.ssh/config"), "file:///etc/passwd"]: assert g.main(["g_open_url.py", bad, "world-g"]) == 1
assert len(log()) == nb and len(rd("gio.log")) == ng, "refused links reach nothing"
print("ok the share check comes first: refused links reach nothing")
shutil.rmtree(F, ignore_errors=True)
print("test-report-link: all pass")
