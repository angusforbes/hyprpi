# kitty geninclude (from pi.conf): Ctrl+right-click on a link opens the link menu (linkmenu.py, @hyprpi N133 /
# J522), with this checkout's absolute path and root, like agentclick-map.py. The press is swallowed so Pi
# (mouse reporting) doesn't also get a right-click. Comment out its geninclude line in pi.conf to turn it off.
import os
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(os.path.dirname(here))
print("mouse_map ctrl+right press grabbed,ungrabbed discard_event")
print(f"mouse_map ctrl+right release grabbed,ungrabbed kitten {os.path.join(here, 'linkmenu.py')} {root}")
