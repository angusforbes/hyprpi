-- hyprpi (~/Work/hyprpi): Hyprland side of hyprpi. Loaded from ~/.config/hypr/hyprland.lua
-- with require("hypr.hyprpi"), after require("hypr.bindings").
-- Install: ln -s ~/Work/hyprpi/hypr/hyprpi.lua ~/.config/hypr/hyprpi.lua (see README).
-- The hyprpi checkout defaults to ~/Work/hyprpi; set HYPRPI_HOME in Hyprland's environment
-- to use another path.
local HYPRPI_ROOT = os.getenv("HYPRPI_HOME") or ((os.getenv("HOME") or "") .. "/Work/hyprpi")
local HYPRPI_BIN = HYPRPI_ROOT .. "/bin/hyprpi"
-- hyprpi add-on switches from ~/.config/hyprpi/config.json (a JSON "key": true/false; a missing
-- file or key = the default). Only these flags are read here, by pattern, so no JSON parser needed.
local function hyprpi_flag(key, default)
  local dir = os.getenv("XDG_CONFIG_HOME") or ((os.getenv("HOME") or "") .. "/.config")
  local f = io.open(dir .. "/hyprpi/config.json", "r")
  if not f then return default end
  local s = f:read("*a"); f:close()
  local v = s:match('"' .. key .. '"%s*:%s*(%a+)')
  if v == "true" then return true elseif v == "false" then return false end
  return default
end


-- Keys.
--   SUPER + A          new Pi agent in its own window on the current workspace (joins that world's room)
--   SUPER + ALT + A / R / /: one panel for the current world, brought HERE (moved from
--                      another workspace if open there, opened here if not), then focused
--   SUPER + ALT + A    agent panel (kitty) for the current world
--   SUPER + ALT + R    room / stream panel (kitty) for the current world
--   SUPER + ALT + P    projects panel (the project board) for the current world
--   SUPER + SHIFT + SPACE  find an agent or project (the finder add-on; the bar toggle then moves to SUPER + ALT + B)
--   SUPER + CTRL + ALT + P  all four panels here (opened if needed), tiled as a 2x2 grid
--   SUPER + ALT + /    search TUI (kitty) for the current world's room
o.bind("SUPER + A", "Pi agent (hyprpi)", HYPRPI_BIN .. " new")
o.bind("SUPER + ALT + A", "hyprpi agent panel (current world)", "/home/agf/Work/hyprpi/mockups/panels --only 1")
o.bind("SUPER + ALT + R", "hyprpi room / stream panel (current world)", "/home/agf/Work/hyprpi/mockups/panels --only 2")
o.bind("SUPER + CTRL + ALT + P", "hyprpi panels here as a 2x2 grid", "/home/agf/Work/hyprpi/mockups/panels")
-- Omarchy binds SUPER + ALT + / to "Monitor scaling down"; both fired on one press. Take the key
-- for search and move scaling down to SUPER + SHIFT + / (scaling up stays on SUPER + /).
hl.unbind("SUPER + ALT + SLASH")
o.bind("SUPER + SHIFT + SLASH", "Monitor scaling down", "omarchy-hyprland-monitor-scaling down")
-- The board panel is the projects panel on SUPER + ALT + P (Angus, 2026-09-29); SUPER + ALT + B is free.
o.bind("SUPER + ALT + P", "hyprpi projects panel (current world)", "/home/agf/Work/hyprpi/mockups/panels --only 4")
o.bind("SUPER + ALT + slash", "hyprpi search TUI (current world)", "/home/agf/Work/hyprpi/mockups/panels --only 3")
-- Add-on: the finder (on by default; "finder": false in ~/.config/hyprpi/config.json turns it off
-- and leaves Omarchy's keys as they were). SUPER+SHIFT+SPACE opens the Omarchy menu, like the apps
-- menu on SUPER+ALT+SPACE, listing every world's agents and projects; Enter jumps to the agent or
-- opens the project card (`hyprpi finder`, mockups/finder). It takes Omarchy's "Toggle top bar"
-- key, so the bar toggle moves to SUPER+ALT+B (B for bar). Angus, 2026-09-29.
if hyprpi_flag("finder", true) then
  hl.unbind("SUPER + SHIFT + SPACE")
  o.bind("SUPER + SHIFT + SPACE", "hyprpi: find an agent or project", HYPRPI_ROOT .. "/mockups/finder")
  o.bind_toggle("SUPER + ALT + B", "Toggle top bar", "bar")
end

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
