#!/usr/bin/env python3
"""J402: g_open_url.py brings a parked or stray world Brave home (silently) before an agent-opened link; a stub hyprctl, temp config.
Run: python3 docker/world/test-brave-home.py"""
import importlib.util, json, os, sys, tempfile
T = tempfile.mkdtemp(prefix="brave-home-")
os.makedirs(f"{T}/cfg/hyprpi/worlds"); json.dump({"sandbox": "world-g", "workspaces": [61, 69]}, open(f"{T}/cfg/hyprpi/worlds/world-g.json", "w"))
clients = [{"address": "0xaaa", "class": "hyprpi.g-brave", "workspace": {"id": -98, "name": "special:reprieve"}},
           {"address": "0xbbb", "class": "hyprpi.g-brave", "workspace": {"id": 67, "name": "67"}},
           {"address": "0xccc", "class": "hyprpi.g-brave", "workspace": {"id": 3, "name": "3"}},
           {"address": "0xddd", "class": "brave-origin", "workspace": {"id": -98, "name": "special:reprieve"}},
           {"address": "0xeee;evil", "class": "hyprpi.g-brave", "workspace": {"id": -98, "name": "special:reprieve"}}]
json.dump(clients, open(f"{T}/clients.json", "w"))
stub = f"{T}/hyprctl"
open(stub, "w").write(f"#!/bin/sh\nif [ \"$1\" = clients ]; then cat {T}/clients.json; else printf '%s\\n' \"$*\" >> {T}/dispatched; fi\n"); os.chmod(stub, 0o755)
os.environ.update(XDG_CONFIG_HOME=f"{T}/cfg", XDG_STATE_HOME=f"{T}/state", HYPRPI_HYPRCTL=stub)
spec = importlib.util.spec_from_file_location("g", os.path.join(os.path.dirname(os.path.abspath(__file__)), "g_open_url.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
assert g.brave_home("g") == 67, g.brave_home("g")
g.bring_brave_home("world-g")
d = open(f"{T}/dispatched").read().strip().split("\n")
assert len(d) == 2, d
assert 'address:0xaaa' in d[0] and 'workspace = "67"' in d[0] and "follow = false" in d[0], d
assert 'address:0xccc' in d[1], d
log = [json.loads(l) for l in open(f"{T}/state/hyprpi/worlds/world-g/helper.jsonl")]
assert [x["address"] for x in log] == ["0xaaa", "0xccc"] and log[0]["why"] == "parked" and log[1]["why"].startswith("outside"), log
print("ok: the parked and the stray G Brave windows move home silently and are logged; one already home, another class and a bad address are left alone")
