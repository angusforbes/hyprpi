#!/usr/bin/env python3
"""g_open_url: the host-side gate for links that come from a sandboxed world (J320, J335).

Two callers, both ON THE HOST:
  - Angus's Ctrl+click in a sandboxed world's window: kitty (sandbox-kitty.conf: open_url_with) runs
      g_open_url.py URL [WORLD]
    and (J406, Angus "19 a") an allowed link opens in that world's OWN Brave, the same separate profile as below, never
    his own Brave: a link the sandbox wrote shouldn't land next to his logins. Since he clicked, the world's Brave is
    then focused (on its home workspace, inside the world he is in) so he sees the page.
  - An agent in the sandbox opening a link itself (xdg-open, $BROWSER, or sbx's /_sbx/browser-open): sbx's daemon
    runs the host's xdg-open → hyprpi-open-url, which sees the `sbx daemon` caller and runs
      g_open_url.py --agent URL [WORLD]
    An allowed link opens in that world's OWN Brave (a separate profile with none of Angus's logins, class
    hyprpi.g-brave; hypr/hyprpi.lua maps it on G's workspace without focus and ignores its activation requests),
    never in the world Angus is in, at most RATE links a minute; it isn't focused (an agent's open never moves him).
  Either way a parked or stray window of that Brave is first brought back to its home workspace (J402).

The text came from the sandbox, so only these are opened:
  - http and https URLs;
  - file:// URLs whose path is inside a folder shared with that sandbox at the same path, not hidden from it, with
    NO symlink anywhere in the path (each component opened with O_NOFOLLOW), and what Brave gets is a private
    snapshot copy (a sandbox can't swap the file for a symlink after the check; Lenswatch J320 3a). An HTML page
    is copied with its folder (no symlinks, no node_modules/.git, size-capped) so its scripts and images load.
Refused: other schemes, control/format characters (Unicode Cc/Cf, Zl/Zp), URLs over 8 kB, paths outside the
shares, hidden files. A refusal shows a short notification. Never raises.
"""
import fcntl, json, os, secrets, shutil, stat, subprocess, sys, time, unicodedata, urllib.parse

HOME = os.path.expanduser("~")
STATE_ROOT = os.environ.get("XDG_STATE_HOME") or os.path.join(HOME, ".local", "state")
STATE = os.path.join(STATE_ROOT, "hyprpi", "sandboxes")
OPENER = os.environ.get("HYPRPI_G_OPENER") or os.path.join(HOME, ".local", "bin", "hyprpi-open-url")  # (J406: no longer used: every sandbox link opens in the world's own Brave; kept so tests can assert it is never called)
# Testing: HYPRPI_G_AGENT_OPENER=/path/stub replaces the world's Brave in --agent mode.
# (or an executable file STATE/agent-open-stub, for tests through sbx's daemon, whose env can't be set).
AGENT_OPENER = os.environ.get("HYPRPI_G_AGENT_OPENER") or next((f for f in [os.path.join(STATE, "agent-open-stub")] if os.access(f, os.X_OK)), None)
SNAP_ROOT = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}", "hyprpi-g-open")
MAX_URL = 8192
RATE = int(os.environ.get("HYPRPI_G_RATE") or 3)          # agent-opened links per minute, per world
SNAP_FILES, SNAP_BYTES = 300, 30 << 20
SKIP_DIRS = {"node_modules", ".git", ".venv", "__pycache__"}


def under(p, base):
    return p == base or p.startswith(base.rstrip("/") + "/")


def bad_chars(u):
    return any(unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") for c in u)


def open_nofollow(path):
    """Open every component of an absolute, normalised path with O_NOFOLLOW (a symlink anywhere fails).
    Returns (fd, is_dir) of the last component. The caller closes the fd."""
    parts = [x for x in path.split("/") if x]
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for i, name in enumerate(parts):
            last = i == len(parts) - 1
            # O_NONBLOCK: a FIFO (e.g. "fifo.html") must not hang the gate (Lenswatch J335 1)
            nfd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (0 if last else os.O_DIRECTORY), dir_fd=fd)
            os.close(fd)
            fd = nfd
        st = os.fstat(fd)
        if stat.S_ISLNK(st.st_mode) or not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
            raise OSError("not a regular file or folder")
        return fd, stat.S_ISDIR(st.st_mode)
    except Exception:
        os.close(fd)
        raise


def copy_fd(src_fd, dst, budget):
    st = os.fstat(src_fd)
    if not stat.S_ISREG(st.st_mode):
        return False
    if st.st_size > budget[1]:
        return False
    left = st.st_size   # copy at most the size we checked (Lenswatch J335 3), even if the file grows meanwhile
    with open(dst, "wb") as o:
        os.lseek(src_fd, 0, 0)
        while left > 0:
            b = os.read(src_fd, min(left, 1 << 20))
            if not b:
                break
            o.write(b)
            left -= len(b)
    budget[0] -= 1
    budget[1] -= st.st_size
    return True


def copy_dir_fd(dfd, dst, budget, depth=0):
    """Copy a directory (opened by fd) without following any symlink; stops at the budget."""
    os.makedirs(dst, exist_ok=True)
    for name in sorted(os.listdir(dfd)):
        if budget[0] <= 0 or budget[1] <= 0:
            return
        if name in SKIP_DIRS:
            continue
        try:
            st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
            if stat.S_ISREG(st.st_mode):
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)   # copy_fd re-checks S_ISREG by fstat
                try:
                    copy_fd(fd, os.path.join(dst, name), budget)
                finally:
                    os.close(fd)
            elif stat.S_ISDIR(st.st_mode) and depth < 6:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_DIRECTORY, dir_fd=dfd)
                try:
                    copy_dir_fd(fd, os.path.join(dst, name), budget, depth + 1)
                finally:
                    os.close(fd)
        except OSError:
            continue   # symlinks, sockets, races: skipped


def snapshot(path, world):
    """A private copy of the shared file (and, for a web page, its folder) for Brave to open."""
    os.makedirs(SNAP_ROOT, mode=0o700, exist_ok=True)
    now = time.time()
    for old in os.listdir(SNAP_ROOT):   # keep a day of snapshots
        p = os.path.join(SNAP_ROOT, old)
        try:
            if now - os.lstat(p).st_mtime > 86400:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass
    dest = os.path.join(SNAP_ROOT, f"{world}-{int(now)}-{secrets.token_hex(4)}")
    os.makedirs(dest, mode=0o700)
    fd, is_dir = open_nofollow(path)
    try:
        if is_dir:
            raise OSError("a folder")
        name = os.path.basename(path)
        budget = [SNAP_FILES, SNAP_BYTES]
        if name.lower().endswith((".html", ".htm", ".svg")):
            pfd, _ = open_nofollow(os.path.dirname(path) or "/")
            try:
                copy_dir_fd(pfd, dest, budget)
            finally:
                os.close(pfd)
        # the page itself always comes from the fd we checked (overwrites the folder copy's version)
        budget = [1, SNAP_BYTES]
        if not copy_fd(fd, os.path.join(dest, name), budget):
            raise OSError("not a regular file, or too big")
    finally:
        os.close(fd)
    return os.path.join(dest, name)


def check(url, world, snap=True):
    """Return (ok, url_to_open_or_reason)."""
    u = url or ""
    if len(u) > MAX_URL:
        return False, f"the link is longer than {MAX_URL // 1024} kB"
    if bad_chars(u):
        return False, "control or invisible formatting characters in the link"
    u = u.strip()
    p = urllib.parse.urlsplit(u)
    scheme = p.scheme.lower()
    if scheme in ("http", "https"):
        if not p.hostname:
            return False, "no host in the link"
        return True, u
    if scheme != "file":
        return False, f"{scheme or 'that'} links aren't opened from a sandbox window"
    if p.netloc not in ("", "localhost"):
        return False, "file links to other machines aren't opened"
    path = urllib.parse.unquote(p.path)
    if not path.startswith("/") or bad_chars(path) or "\x00" in path:
        return False, "not an absolute path"
    norm = os.path.normpath(path)
    if os.path.realpath(norm) != norm:
        return False, f"{norm} goes through a symlink"
    try:
        managed = json.load(open(os.path.join(STATE, world, "managed.json")))
    except (OSError, ValueError):
        return False, "the sandbox's shares are unknown"
    shared = [m for m in managed if m.get("why") not in ("hidden", "host card") and m.get("host") == m.get("at")]
    hidden = [m["at"] for m in managed if m.get("why") == "hidden"]
    if not any(under(norm, m["host"]) for m in shared):
        return False, f"{norm} isn't in a folder shared with {world}"
    if any(under(norm, h) for h in hidden):
        return False, f"{norm} is hidden from {world}"
    if not snap:
        return True, "file://" + urllib.parse.quote(norm)
    try:
        copy = snapshot(norm, world)
    except OSError as e:
        return False, f"{norm} can't be opened ({'a symlink in the path' if 'symlink' in str(e) or getattr(e, 'errno', 0) == 40 else e.strerror or e})"
    return True, "file://" + urllib.parse.quote(copy)


def rate_ok(world):
    """At most RATE agent-opened links a minute per world (a shared, locked stamp file)."""
    d = os.path.join(STATE, world)
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, "agent-opens.json")
    with open(os.path.join(d, ".agent-opens.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            stamps = [t for t in json.load(open(f)) if time.time() - t < 60]
        except (OSError, ValueError, TypeError):
            stamps = []
        if len(stamps) >= RATE:
            return False
        stamps.append(time.time())
        tmp = f + ".tmp"
        with open(tmp, "w") as o:
            json.dump(stamps, o)
        os.replace(tmp, f)
        return True


def toast_ok(world):
    f = os.path.join(STATE, world, ".agent-toast")
    try:
        if time.time() - os.stat(f).st_mtime < 60:
            return False
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(f), exist_ok=True)
        open(f, "w").close()
    except OSError:
        pass
    return True


def world_brave(world):
    """argv that opens a URL in the world's own Brave (own profile; class matched by hypr/hyprpi.lua)."""
    if AGENT_OPENER:
        return [AGENT_OPENER]
    letter = world.removeprefix("world-")
    prof = os.path.join(STATE_ROOT, "hyprpi", "worlds", world, "brave")
    os.makedirs(prof, mode=0o700, exist_ok=True)
    return ["env", "-u", "LIBVA_DRIVER_NAME", "brave-origin", f"--user-data-dir={prof}", f"--class=hyprpi.{letter}-brave",
            "--no-first-run", "--no-default-browser-check"]


HYPRCTL = os.environ.get("HYPRPI_HYPRCTL") or "hyprctl"   # tests: a stub
LUA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "hypr", "hyprpi.lua")


def brave_home(letter):
    """The world Brave's home workspace, from its window rule in hypr/hyprpi.lua (workspace = "NN silent"), or None."""
    try:
        txt = open(LUA, encoding="utf-8").read()
    except OSError:
        return None
    i = txt.find(f"hyprpi\\\\.{letter}-brave")
    if i < 0:
        return None
    end = txt.find("})", i)
    import re
    m = re.search(r'workspace\s*=\s*"(\d+)', txt[i:end if end > 0 else i + 600])
    return int(m.group(1)) if m else None


def bring_brave_home(world):
    """J402 (Thoughts-B): before a link goes to the world's own Brave, a window of it that is parked (special:reprieve, or any
    special workspace) or outside the world's workspaces is moved back to its home workspace silently (no focus change), and
    that is logged. Moving it out of special:reprieve makes Reprieve drop its record. Never raises."""
    try:
        letter = world.removeprefix("world-")
        home = brave_home(letter)
        cfg_dir = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "hyprpi", "worlds")
        try:
            lo, hi = json.load(open(os.path.join(cfg_dir, f"{world}.json"))).get("workspaces", [None, None])[:2]
        except Exception:
            lo = hi = None
        if not home or not isinstance(lo, int) or not isinstance(hi, int) or not (lo <= home <= hi):
            return  # (Linkpath: an edited rule can't send the window into another world)
        out = subprocess.run([HYPRCTL, "clients", "-j"], capture_output=True, text=True, timeout=5).stdout
        for c in json.loads(out or "[]"):
            if c.get("class") != f"hyprpi.{letter}-brave":
                continue
            addr, ws = str(c.get("address", "")), c.get("workspace") or {}
            name, wid = str(ws.get("name", "")), ws.get("id")
            parked = name.startswith("special:")
            outside = not isinstance(wid, int) or not (lo <= wid <= hi)
            if not (parked or outside) or not __import__("re").fullmatch(r"0x[0-9a-f]+", addr):
                continue
            subprocess.run([HYPRCTL, "dispatch", f'hl.dsp.window.move({{ window = "address:{addr}", workspace = "{home}", follow = false }})'], capture_output=True, timeout=5)
            try:
                log_dir = os.path.join(STATE_ROOT, "hyprpi", "worlds", world)
                os.makedirs(log_dir, mode=0o700, exist_ok=True)
                with open(os.path.join(log_dir, "helper.jsonl"), "a") as f:
                    f.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "op": "brave-home", "address": addr, "from": name, "to": home, "why": "parked" if parked else "outside the world's workspaces"}) + "\n")
            except OSError:
                pass
    except Exception:
        pass


def focus_brave(world, wait_s=6.0):
    """J406: after Angus's own click, focus the world's Brave window (on its home workspace, in his world), waiting a few
    seconds for a newly started one to map. Only for his clicks; never for an agent's open. Never raises."""
    try:
        import re
        letter = world.removeprefix("world-")
        end = time.time() + wait_s
        while time.time() < end:
            out = subprocess.run([HYPRCTL, "clients", "-j"], capture_output=True, text=True, timeout=5).stdout
            wins = [c for c in json.loads(out or "[]") if c.get("class") == f"hyprpi.{letter}-brave" and not str((c.get("workspace") or {}).get("name", "")).startswith("special:")]
            if wins:
                addr = str(max(wins, key=lambda c: c.get("focusHistoryID", 0) * -1).get("address", ""))
                if re.fullmatch(r"0x[0-9a-f]+", addr):
                    subprocess.run([HYPRCTL, "dispatch", f'hl.dsp.focus({{ window = "address:{addr}" }})'], capture_output=True, timeout=5)
                return
            time.sleep(0.3)
    except Exception:
        pass


def tell(title, msg):
    try:
        subprocess.run(["notify-send", "-a", "hyprpi", "-u", "low", title, msg], timeout=5)
    except Exception:
        pass


def main(argv):
    args = argv[1:]
    agent = bool(args) and args[0] == "--agent"
    if agent:
        args = args[1:]
    url = args[0] if args else ""
    world = args[1] if len(args) > 1 else os.environ.get("HYPRPI_G_WORLD", "world-g")
    if not world.replace("-", "").isalnum():
        return 2
    who = f"an agent in {world}" if agent else "a sandbox window"
    try:
        ok, out = check(url, world)
    except Exception as e:
        ok, out = False, f"couldn't check the link ({e.__class__.__name__})"
    if ok and agent and not rate_ok(world):
        ok, out = False, f"more than {RATE} links a minute from {world}"
    if not ok:
        # an agent looping on refused links mustn't flood Angus: at most one notice a minute per world (J335 2)
        if not agent or toast_ok(world):
            tell(f"Link from {who} not opened", out + (" (further refusals this minute are not shown)" if agent else ""))
        print(f"g_open_url: refused: {out}", file=sys.stderr)
        return 1
    # J406 (Angus "19 a"): every link from a sandbox window, his click or an agent's, opens in the world's own Brave
    bring_brave_home(world)  # J402: a parked or stray world Brave comes home first, so the new tab is visible there
    cmd = world_brave(world) + ["--", out]
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception as e:
        tell(f"Link from {who} not opened", f"couldn't start the browser ({e.__class__.__name__})")
        return 1
    if not agent:
        focus_brave(world)  # he clicked: show him the page (the window rule suppresses Brave's own activation)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
