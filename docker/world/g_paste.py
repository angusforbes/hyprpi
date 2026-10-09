"""Image-paste key for sandboxed (world G) kitty windows. Runs in the HOST kitty process
(a kitten mapped to ctrl+v / shift+insert in sandbox-kitty.conf; `kitten`-style no_ui handler).

Inside the sandbox wl-paste is a stand-in, so a clipboard image can't reach the agent. Here, on the host:
if the Wayland clipboard offers an image, save it to ~/Screenshots (shared into the sandbox at the same
path) as pi-clipboard-<uuid>.<ext>, mode 600, and type its ABSOLUTE path ("/home/<user>/Screenshots/… ")
into the window. Not "~/…": inside the sandbox HOME is /home/agent, so a tilde path would point at a
folder that doesn't exist there (J318).
Anything else (or any error) is a plain text paste, like paste_from_clipboard. Never raises.
"""
import os
import re
import subprocess
import uuid

from kittens.tui.handler import result_handler

IMG_RE = re.compile(r'^image/(png|jpeg|webp|gif)$')


def main(args):
    pass


def save_clipboard_image(run=subprocess.run):
    """Return the path text to type ("/home/<user>/Screenshots/pi-clipboard-….png "), or None if no image."""
    r = run(['wl-paste', '--list-types'], capture_output=True, text=True, timeout=5)
    if r.returncode:
        return None
    img = next((t.strip() for t in r.stdout.splitlines() if IMG_RE.match(t.strip())), None)
    if not img:
        return None
    ext = 'jpg' if img == 'image/jpeg' else img.split('/')[1]
    d = os.path.expanduser('~/Screenshots')
    if not os.path.isdir(d):
        d = '/tmp'  # ~/Screenshots missing: not shared into the sandbox, so say so (the path shows it)
    f = os.path.join(d, f'pi-clipboard-{uuid.uuid4()}.{ext}')
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as out:
            r = run(['wl-paste', '--type', img], stdout=out, stderr=subprocess.DEVNULL, timeout=15)
        if r.returncode or os.path.getsize(f) == 0:
            raise RuntimeError('wl-paste gave no image')
    except BaseException:
        try:
            os.unlink(f)
        except OSError:
            pass
        raise
    return f + ' '


def text_paste(boss, w):
    """What kitty's paste_from_clipboard (boss.py) does. get_clipboard_string lives in kitty.clipboard; the
    J307 version imported it from kitty.fast_data_types, which raised ImportError (swallowed), so Ctrl+V and
    Shift+Insert pasted nothing (J318)."""
    if w.send_paste_event():
        return
    try:
        from kitty.clipboard import get_clipboard_string
    except ImportError:  # a kitty that moved it again: let kitty's own action paste into the active window
        boss.paste_from_clipboard()
        return
    text = get_clipboard_string()
    if text:
        w.paste_with_actions(text)


def paste(boss, w, run=subprocess.run):
    try:
        path = save_clipboard_image(run)
        if path:
            w.paste_text(path)  # bracketed-paste aware
            return
    except BaseException:
        pass
    try:
        text_paste(boss, w)
    except BaseException:
        try:
            boss.paste_from_clipboard()  # last resort: kitty's own text paste
        except BaseException:
            pass


@result_handler(no_ui=True)
def handle_result(args, answer, target_window_id, boss):
    try:
        w = boss.window_id_map.get(target_window_id) or boss.active_window
        if w is not None:
            paste(boss, w)
    except BaseException:
        pass
