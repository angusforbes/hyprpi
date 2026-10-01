# hyprpi: Ctrl+click in a pi agent window (kitty), @hyprpi N56.
#   1. a link under the pointer (OSC 8, or detected URL / file://): opened, exactly as before
#   2. else the word under the pointer, if it names a hyprpi agent ("pi·wpzt", "@Blink",
#      "Sankey[e]", any world): jump to that agent's window (mockups/agent-at does the matching
#      and the jump, the same rules as the panels' Ctrl+click)
# Wired in pi.conf: mouse_map ctrl+left release grabbed,ungrabbed kitten <this file>
import os
import subprocess

from kittens.tui.handler import result_handler

# (kitty runs kittens with exec, without __file__: hyprpi's checkout, HYPRPI_ROOT if set)
AGENT_AT = os.path.join(os.environ.get('HYPRPI_ROOT') or os.path.expanduser('~/Work/hyprpi'), 'mockups', 'agent-at')


def main(args):
    pass


@result_handler(no_ui=True)
def handle_result(args, answer, target_window_id, boss):
    w = boss.window_id_map.get(target_window_id)
    if w is None:
        return
    try:
        from kitty.fast_data_types import click_mouse_url
        if click_mouse_url(w.os_window_id, w.tab_id, w.id):
            return  # a link: kitty opened it (open_url_with, as before)
    except Exception:
        pass
    pos = w.current_mouse_position()
    if not pos:
        return
    try:
        line = str(w.screen.visual_line(pos['cell_y']) or '')
    except Exception:
        return
    env = dict(os.environ)
    for k in ('HYPRPI_AGENT_ID', 'HYPRPI_WORKSPACE', 'PI_SESSION'):
        env.pop(k, None)
    subprocess.Popen([AGENT_AT, '--line', line, '--x', str(pos['cell_x'] + 1)], env=env,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
