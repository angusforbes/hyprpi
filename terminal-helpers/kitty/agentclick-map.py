# kitty geninclude (from pi.conf): prints the Ctrl+click mapping with this checkout's absolute path, and
# passes the checkout's root to the kitten (kitty runs kittens without __file__), so pi.conf needs no
# machine-specific path (@hyprpi N56, turned on again 2026-10-08).
import os
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(os.path.dirname(here))
print(f"mouse_map ctrl+left release grabbed,ungrabbed kitten {os.path.join(here, 'agentclick.py')} {root}")
