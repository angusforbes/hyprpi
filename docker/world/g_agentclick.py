# J467 (Angus: "make all of it the same" as in the host worlds): Ctrl+click in a window of a SANDBOXED world (G), run by the HOST
# kitty of that window (docker/world/sandbox-kitty.conf: mouse_map ctrl+left release ... kitten <this file> NODE HELPER).
#   1. a link under the pointer: kitty opens it exactly as before (click_mouse_url -> open_url_with, the world's own opener)
#   2. else the word under the pointer, if it names one of THIS world's agents ("@Alpha", "Alpha", an icon in front): that agent's
#      window is focused, through world-helper.mjs focus-word, which only ever targets the world's own agent windows
# The host twin is terminal-helpers/kitty/agentclick.py (+ mockups/agent-at, the host daemon); a sandboxed world's agents aren't
# the host daemon's, so G asks its own host helper instead.
import os
import re
import subprocess

from kittens.tui.handler import result_handler


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
    world = os.environ.get('G_WORLD', '')
    if len(args) < 3 or not re.fullmatch(r'[a-z0-9-]{1,32}', world):
        return
    pos = w.current_mouse_position()
    if not pos:
        return
    try:
        line = str(w.screen.visual_line(pos['cell_y']) or '')
    except Exception:
        return
    subprocess.Popen([args[1], args[2], 'focus-word', world, '--line', line[:2000], '--x', str(pos['cell_x'] + 1)],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
