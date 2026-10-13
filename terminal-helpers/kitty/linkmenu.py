# hyprpi: Ctrl+right-click on a link in a pi agent window (kitty), @hyprpi N133 / J522.
# A small menu for the link under the pointer: for a local file Show in folder / Copy path / Copy file
# (/ Open), for a web link Copy link / Open. The menu and the actions are in `link-actions` next to this file.
# Ctrl+click (agentclick.py) still opens a link straight away; this is a second gesture beside it.
#
# How the link is found: kitty knows the link under the pointer only when it "clicks" it. For that one click
# this kitten swaps in an open_url_handler that keeps the URL instead of opening it (the hook kitty itself
# gives kittens: Window.open_url calls it first), then puts the old handler back. OSC 8 links (Pi's Markdown
# links, <file:///…>) and detected URLs both go through Window.open_url.
# Wired in pi.conf: geninclude linkmenu-map.py → mouse_map ctrl+right release … kitten <this file> <root>
import os
import subprocess

from kittens.tui.handler import result_handler


def link_actions(args):
    # kitty runs kittens with exec and no __file__ (see agentclick.py): linkmenu-map.py passes the checkout's
    # root as the first argument. Fallbacks: $HYPRPI_ROOT, then ~/Work/hyprpi.
    root = (args[1] if len(args) > 1 and args[1] else '') or os.environ.get('HYPRPI_ROOT') or os.path.expanduser('~/Work/hyprpi')
    return os.path.join(root, 'terminal-helpers', 'kitty', 'link-actions')


def main(args):
    pass


@result_handler(no_ui=True)
def handle_result(args, answer, target_window_id, boss):
    w = boss.window_id_map.get(target_window_id)
    if w is None:
        return
    got = []

    def keep(boss_, window, url, hyperlink_id, cwd):
        got.append((url, cwd))
        return True  # handled: kitty doesn't open it

    old = w.open_url_handler
    w.open_url_handler = keep
    try:
        from kitty.fast_data_types import click_mouse_url
        click_mouse_url(w.os_window_id, w.tab_id, w.id)
    except Exception:
        pass
    finally:
        w.open_url_handler = old
    if not got:
        return  # no link under the pointer: nothing to offer
    url, cwd = got[0]
    env = dict(os.environ)
    for k in ('HYPRPI_AGENT_ID', 'HYPRPI_WORKSPACE', 'PI_SESSION'):
        env.pop(k, None)
    subprocess.Popen([link_actions(args), url] + ([cwd] if cwd else []), env=env,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
