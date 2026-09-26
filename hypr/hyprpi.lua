-- hyprpi (~/Work/hyprpi): Hyprland side of hyprpi. Loaded from ~/.config/hypr/hyprland.lua
-- with require("hypr.hyprpi"), after require("hypr.bindings").
-- Install: ln -s ~/Work/hyprpi/hypr/hyprpi.lua ~/.config/hypr/hyprpi.lua (see README).
-- The hyprpi checkout defaults to ~/Work/hyprpi; set HYPRPI_HOME in Hyprland's environment
-- to use another path.
local HYPRPI_BIN = (os.getenv("HYPRPI_HOME") or ((os.getenv("HOME") or "") .. "/Work/hyprpi")) .. "/bin/hyprpi"

-- Keys.
--   SUPER + A          new Pi agent in its own window on the current workspace (joins that world's room)
--   SUPER + ALT + A    room TUI (kitty) for the current world
--   SUPER + ALT + /    search TUI (kitty) for the current world's room
o.bind("SUPER + A", "Pi agent (hyprpi)", HYPRPI_BIN .. " new")
o.bind("SUPER + ALT + A", "hyprpi room TUI (current world)", "/home/agf/Work/hyprpi/mockups/room-tui")
-- Omarchy binds SUPER + ALT + / to "Monitor scaling down"; both fired on one press. Take the key
-- for search and move scaling down to SUPER + SHIFT + / (scaling up stays on SUPER + /).
hl.unbind("SUPER + ALT + SLASH")
o.bind("SUPER + SHIFT + SLASH", "Monitor scaling down", "omarchy-hyprland-monitor-scaling down")
o.bind("SUPER + ALT + slash", "hyprpi search TUI (current world)", "/home/agf/Work/hyprpi/mockups/search-tui")

-- Agent windows (class hyprpi.agent) are tagged as terminals, so Omarchy's SUPER+C/V send
-- Ctrl+Insert/Shift+Insert instead of Ctrl+C (which Pi treats as clear/interrupt).
o.window("hyprpi\\..*", { tag = "+terminal" })

-- A click inside an agent window marks its "done" (✓ in the room window) as seen. Focus alone
-- doesn't, because follow-the-mouse focuses windows you merely pass over.
--
-- Non-consuming: the click still reaches the window. Cheap: it only spawns
-- `hyprpi seen` when the hyprpi daemon has flagged this window as unseen, which
-- it does with an empty file $XDG_RUNTIME_DIR/hyprpi/unseen/<address without 0x>.
local hyprpi_unseen = (os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/hyprpi/unseen/"

local function hyprpi_click()
  if type(hl.get_active_window) ~= "function" then return end -- `omarchy menu keybindings` stub
  local ok, w = pcall(hl.get_active_window)
  if not ok or not w then return end
  local ok2, class = pcall(function() return w.class end)
  if not ok2 or class ~= "hyprpi.agent" then return end
  local ok3, addr = pcall(function() return w.address end)
  if not ok3 or addr == nil then return end
  if type(addr) == "number" then addr = string.format("%x", addr) end
  addr = tostring(addr):lower():gsub("^0x", "")
  local f = io.open(hyprpi_unseen .. addr, "r")
  if not f then return end
  f:close()
  hl.dispatch(hl.dsp.exec_cmd(HYPRPI_BIN .. " seen " .. addr))
end

hl.bind("mouse:272", hyprpi_click, { non_consuming = true })
