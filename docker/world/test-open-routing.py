#!/usr/bin/env python3
"""J406: Angus's Ctrl+click and an agent's open both go to the world's own Brave, never hyprpi-open-url (his Brave); his click
focuses that Brave, an agent's doesn't; the gate's refusals are unchanged. Stubs only (no browser, no Hyprland changes).
Run: python3 docker/world/test-open-routing.py"""
import importlib.util, json, os, tempfile, time
T = tempfile.mkdtemp(prefix="open-routing-")
os.makedirs(f"{T}/cfg/hyprpi/worlds"); json.dump({"sandbox": "world-g", "workspaces": [61, 69]}, open(f"{T}/cfg/hyprpi/worlds/world-g.json", "w"))
json.dump([{"address": "0xabc", "class": "hyprpi.g-brave", "workspace": {"id": 67, "name": "67"}, "focusHistoryID": 3}], open(f"{T}/clients.json", "w"))
def stub(name, body):
    p = f"{T}/{name}"; open(p, "w").write("#!/bin/sh\n" + body + "\n"); os.chmod(p, 0o755); return p
hyprctl = stub("hyprctl", f'if [ "$1" = clients ]; then cat {T}/clients.json; else printf "%s\\n" "$*" >> {T}/dispatched; fi')
brave = stub("brave-stub", f'printf "%s\\n" "$*" >> {T}/brave.log')
mine = stub("hyprpi-open-url", f'printf "%s\\n" "$*" >> {T}/his-brave.log')
stub("notify-send", "exit 0")  # no toasts from the refusal cases
os.environ["PATH"] = T + ":" + os.environ["PATH"]
os.environ.update(XDG_CONFIG_HOME=f"{T}/cfg", XDG_STATE_HOME=f"{T}/state", XDG_RUNTIME_DIR=T, HYPRPI_HYPRCTL=hyprctl, HYPRPI_G_AGENT_OPENER=brave, HYPRPI_G_OPENER=mine)
spec = importlib.util.spec_from_file_location("g", os.path.join(os.path.dirname(os.path.abspath(__file__)), "g_open_url.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
read = lambda f: open(f"{T}/{f}").read().strip().split("\n") if os.path.exists(f"{T}/{f}") else []
assert g.main(["g_open_url.py", "https://example.org/a", "world-g"]) == 0          # Angus's click
time.sleep(0.3)
assert read("brave.log") == ["-- https://example.org/a"], read("brave.log")
assert any("hl.dsp.focus" in d and "0xabc" in d for d in read("dispatched")), read("dispatched")
n_focus = sum("hl.dsp.focus" in d for d in read("dispatched"))
assert g.main(["g_open_url.py", "--agent", "https://example.org/b", "world-g"]) == 0  # an agent's open
time.sleep(0.3)
assert read("brave.log")[-1] == "-- https://example.org/b", read("brave.log")
assert sum("hl.dsp.focus" in d for d in read("dispatched")) == n_focus, "an agent's open must not focus"
assert read("his-brave.log") == [], "hyprpi-open-url (Angus's own Brave) must never be called"
for bad in ["javascript:alert(1)", "ftp://x.org/a", "https://x.org/\u202eevil", "file:///etc/passwd"]:          # the gate's checks, both callers
    assert g.main(["g_open_url.py", bad, "world-g"]) == 1, bad
    assert g.main(["g_open_url.py", "--agent", bad, "world-g"]) == 1, bad
assert len(read("brave.log")) == 2, read("brave.log")
# review J406: a world Brave outside the world's workspaces is never focused
json.dump([{"address": "0xdef", "class": "hyprpi.g-brave", "workspace": {"id": 3, "name": "3"}, "focusHistoryID": 0}], open(f"{T}/clients.json", "w"))
before = sum("hl.dsp.focus" in d for d in read("dispatched")); g.focus_brave("world-g", wait_s=0.8)
assert sum("hl.dsp.focus" in d for d in read("dispatched")) == before, "focused a window outside the world"
print("ok: both a click and an agent open go to the world's Brave (never hyprpi-open-url); only the click focuses it; refusals unchanged")
