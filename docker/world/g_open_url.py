#!/usr/bin/env python3
"""g_open_url: open a link Angus Ctrl+clicked in a sandboxed world's window (J320).

kitty (sandbox-kitty.conf: open_url_with) runs this ON THE HOST with the clicked URL. The text came from the
sandbox, so only these are opened, through hyprpi's per-world handler (~/.local/bin/hyprpi-open-url → the
current world's Brave window):
  - http and https URLs;
  - file:// URLs whose real path (symlinks resolved on the host) is inside a folder shared with that sandbox at
    the same path, and not hidden from it (shares.mjs managed.json).
Everything else (other schemes, paths outside the shares, hidden files, ~/.sandbox) is refused with a short
notification. Never raises.

  g_open_url.py URL [WORLD]        WORLD defaults to world-g
"""
import json, os, subprocess, sys, urllib.parse

HOME = os.path.expanduser("~")
STATE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.join(HOME, ".local", "state"), "hyprpi", "sandboxes")
OPENER = os.environ.get("HYPRPI_G_OPENER") or os.path.join(HOME, ".local", "bin", "hyprpi-open-url")


def under(p, base):
    return p == base or p.startswith(base.rstrip("/") + "/")


def check(url, world):
    """Return (ok, url_to_open_or_reason)."""
    u = (url or "").strip()
    if any(c in u for c in "\x00\r\n\t"):
        return False, "control characters in the link"
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
    if not path.startswith("/"):
        return False, "not an absolute path"
    real = os.path.realpath(path)
    try:
        managed = json.load(open(os.path.join(STATE, world, "managed.json")))
    except (OSError, ValueError):
        return False, "the sandbox's shares are unknown"
    shared = [m for m in managed if m.get("why") not in ("hidden", "host card") and m.get("host") == m.get("at")]
    hidden = [m["at"] for m in managed if m.get("why") == "hidden"]
    if not any(under(real, m["host"]) for m in shared):
        return False, f"{real} isn't in a folder shared with {world}"
    if any(under(real, h) for h in hidden) or any(under(path, h) for h in hidden):
        return False, f"{real} is hidden from {world}"
    if not os.path.exists(real):
        return False, f"{real} doesn't exist on the laptop"
    return True, "file://" + urllib.parse.quote(real)


def tell(msg):
    try:
        subprocess.run(["notify-send", "-a", "hyprpi", "-u", "low", "Link not opened", msg], timeout=5)
    except Exception:
        pass


def main(argv):
    url = argv[1] if len(argv) > 1 else ""
    world = argv[2] if len(argv) > 2 else os.environ.get("HYPRPI_G_WORLD", "world-g")
    try:
        ok, out = check(url, world)
    except Exception as e:
        ok, out = False, f"couldn't check the link ({e.__class__.__name__})"
    if not ok:
        tell(out)
        print(f"g_open_url: refused: {out}", file=sys.stderr)
        return 1
    try:
        subprocess.Popen([OPENER, out], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception as e:
        tell(f"couldn't start the browser ({e.__class__.__name__})")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
