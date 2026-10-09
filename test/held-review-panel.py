#!/usr/bin/env python3
"""J356 end-to-end: the real Thoughts panel (mockups/search-tui.mjs A) in a pty, fully isolated (own XDG_STATE_HOME /
runtime dir, bogus Hyprland, no daemon), with a held research item copied from a template.

  python3 test/held-review-panel.py TEMPLATE.json [REPO]     (REPO: the checkout to run, default: this one)

Scenario stale (b): "1" is in the box when the review opens by itself; Enter → must NOT go to Thoughts, must show
  "already in the box … type 1 again" and log stage "stale"; then "1" + Enter → approve (stage cli, verdict approve).
Scenario click (a): same start, then a Review click (reviews/A.json) → re-armed (stage "rearmed"); "1" + Enter → approve.
Prints one line per check and exits 1 if any fails."""
import json, os, pty, select, shutil, subprocess, sys, tempfile, time

TPL = sys.argv[1]
REPO = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), ".."))
fails = []


def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok:
        fails.append(name)


def scenario(kind):
    tmp = tempfile.mkdtemp(prefix=f"j356-{kind}-")
    st = os.path.join(tmp, "state"); run = os.path.join(tmp, "run")
    relay = os.path.join(st, "hyprpi", "sbx-relay")
    for d in ("pending", "reviews"):
        os.makedirs(os.path.join(relay, d), exist_ok=True)
    os.makedirs(run, mode=0o700, exist_ok=True)
    env = {**os.environ, "XDG_STATE_HOME": st, "XDG_RUNTIME_DIR": run, "HYPRPI_STATE": os.path.join(tmp, "hp"),
           "HYPRPI_SOCKET": os.path.join(run, "none.sock"), "HYPRLAND_INSTANCE_SIGNATURE": "bogus-j356", "HYPRPI_TEST": "1",
           "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40",
           "HOME": os.path.join(tmp, "home"), "XDG_CONFIG_HOME": os.path.join(tmp, "config")}   # (HeldReview #4: nothing of the live setup)
    os.makedirs(env["HOME"], exist_ok=True)
    for k in ("HYPRPI_AGENT_ID", "HYPRPI_SANDBOX_WORLD", "HYPRPI_G_WORLD", "HYPRPI_SEARCH_TUI_STATEFILE"):
        env.pop(k, None)
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("node", ["node", os.path.join(REPO, "mockups", "search-tui.mjs"), "A"], env)
    out = bytearray()

    def pump(sec):
        end = time.time() + sec
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    out.extend(os.read(fd, 65536))
                except OSError:
                    return

    def log():
        try:
            return [json.loads(l) for l in open(os.path.join(relay, "panel.jsonl"))]
        except OSError:
            return []

    pump(3)
    os.write(fd, b"1")                        # Angus starts typing "1" ...
    pump(0.5)
    m = json.load(open(TPL)); hid = "world-g--a0" + kind[:4].encode().hex()[:4]
    m["id"] = hid
    json.dump(m, open(os.path.join(relay, "pending", hid + ".json"), "w"))   # ... the item is held, the review opens by itself
    pump(4)
    auto = [e for e in log() if e.get("id") == hid]
    if kind == "early":   # (HeldReview #1) a 1 typed right after the click re-armed it: held back with a notice, not chat
        json.dump({"id": hid}, open(os.path.join(relay, "reviews", "A.json"), "w"))
        end = time.time() + 4
        while time.time() < end and not any(e.get("stage") == "rearmed" for e in log()):
            pump(0.05)
        m0 = len(out); os.write(fd, b"1\r"); pump(1.0)
        scr = out[m0:].decode("utf8", "replace")
        check(f"{kind}: a 1 within 1.5 s of the click shows 'review just opened … again'", "review just opened" in scr)
        check(f"{kind}: logged early-return reason early", any(e.get("reason") == "early" and e.get("id") == hid for e in log()))
        pump(1.0)
        os.write(fd, b"1"); pump(0.3)
    if kind == "click":
        json.dump({"id": hid}, open(os.path.join(relay, "reviews", "A.json"), "w"))   # Review clicked on the toast
        pump(3.5)
        check(f"{kind}: re-armed on the click (stage rearmed)", any(e.get("stage") == "rearmed" and e.get("id") == hid for e in log()))
        os.write(fd, b"1"); pump(0.3)
    mark = len(out)
    os.write(fd, b"\r"); pump(2)
    if kind == "stale":
        L = log()
        check(f"{kind}: logged stage stale", any(e.get("stage") == "stale" and e.get("id") == hid and e.get("raw") == "1" for e in L))
        scr = out[mark:].decode("utf8", "replace")
        check(f"{kind}: notice 'already in the box … type 1 again' shown", "already in the box" in scr and "type 1 again" in scr)
        # (not sent to Thoughts: with no daemon, sendThought leaves no trace on screen; the stale branch returning true
        #  before enter() reaches it is pinned by test/held-review-gate.mjs)
        os.write(fd, b"1"); pump(0.3); os.write(fd, b"\r"); pump(3)
    L = log()
    cli = [e for e in L if e.get("id") == hid and e.get("stage") == "cli"]
    # (HeldReview #3) this proves the panel ROUTES the 1 to an approve; the relay CLI itself refuses to approve when an
    # agent runs it, so no real decision is made (that refusal is expected and recorded here)
    check(f"{kind}: a plain 1 then goes to approve (stage cli, verdict approve)", bool(cli) and (cli[-1].get("choice") or {}).get("verdict") == "approve")
    if cli:
        print(f"   ({kind}: relay CLI ok={cli[-1].get('ok')}: {str(cli[-1].get('cli'))[:90]})")
    os.kill(pid, 9)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    print(f"   ({kind}: {len(L)} log lines; stages {[e.get('stage') for e in L]})")
    shutil.rmtree(tmp, ignore_errors=True)


def decided():
    """(2a) the card's options line follows its state, and a bare 1 at a decided card says 'already approved at HH:MM'."""
    tmp = tempfile.mkdtemp(prefix="j356-decided-")
    st = os.path.join(tmp, "state"); run = os.path.join(tmp, "run"); relay = os.path.join(st, "hyprpi", "sbx-relay")
    for d in ("pending", "reviews"):
        os.makedirs(os.path.join(relay, d), exist_ok=True)
    os.makedirs(run, mode=0o700, exist_ok=True)
    env = {**os.environ, "XDG_STATE_HOME": st, "XDG_RUNTIME_DIR": run, "HYPRPI_STATE": os.path.join(tmp, "hp"),
           "HYPRPI_SOCKET": os.path.join(run, "none.sock"), "HYPRLAND_INSTANCE_SIGNATURE": "bogus-j356", "HYPRPI_TEST": "1",
           "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40",
           "HOME": os.path.join(tmp, "home"), "XDG_CONFIG_HOME": os.path.join(tmp, "config")}   # (HeldReview #4: nothing of the live setup)
    os.makedirs(env["HOME"], exist_ok=True)
    for k in ("HYPRPI_AGENT_ID", "HYPRPI_SANDBOX_WORLD", "HYPRPI_G_WORLD", "HYPRPI_SEARCH_TUI_STATEFILE"):
        env.pop(k, None)
    m = json.load(open(TPL)); hid = "world-g--dec1de"; m["id"] = hid
    json.dump(m, open(os.path.join(relay, "pending", hid + ".json"), "w"))
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("node", ["node", os.path.join(REPO, "mockups", "search-tui.mjs"), "A"], env)
    out = bytearray()

    def pump(sec):
        end = time.time() + sec
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    out.extend(os.read(fd, 65536))
                except OSError:
                    return
    pump(5)
    check("decided: while pending the card says 'type 1, 2 or 3 here'", "type 1, 2 or 3 here" in out.decode("utf8", "replace"))
    # the relay decides it elsewhere (toast / terminal): pending file gone, its decision in the relay log
    os.unlink(os.path.join(relay, "pending", hid + ".json"))
    with open(os.path.join(relay, "log.jsonl"), "a") as f:
        f.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "id": hid, "decision": "approved", "delivered": ["Thoughts-A"]}) + "\n")
    flip = len(out); end = time.time() + 10   # wait (under load too) until the card shows the decision
    while time.time() < end and "Approved at" not in out[flip:].decode("utf8", "replace"):
        pump(0.2)
    check("decided: the card now shows the decision", "Approved at" in out[flip:].decode("utf8", "replace"))
    mark = len(out)
    os.write(fd, b"1"); pump(0.3); os.write(fd, b"\r"); pump(2)
    scr = out[mark:].decode("utf8", "replace")
    try:
        L = [json.loads(l) for l in open(os.path.join(relay, "panel.jsonl"))]
    except OSError:
        L = []
    check("decided: a bare 1 says 'already approved at HH:MM' and sends nothing", "already approved at" in scr and "nothing was sent" in scr)
    check("decided: logged stage decided-card", any(e.get("stage") == "decided-card" and e.get("id") == hid for e in L))
    os.kill(pid, 9)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    shutil.rmtree(tmp, ignore_errors=True)


decided()
for k in ("stale", "click", "early"):
    scenario(k)
sys.exit(1 if fails else 0)
