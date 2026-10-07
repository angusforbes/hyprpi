-- hyprpi: the Hyprland side of hyprpi. Loaded from ~/.config/hypr/hyprland.lua with
-- require("hypr.hyprpi"), after require("hypr.bindings").
-- Install: `hyprpi integration install hypr` (links this file as ~/.config/hypr/hyprpi.lua and adds
-- the require). The checkout is found from this file's real path (the link points into it), so hyprpi
-- can be cloned anywhere; HYPRPI_HOME in Hyprland's environment overrides it.
local function hyprpi_root()
  local env = os.getenv("HYPRPI_HOME")
  if env and env ~= "" then return env end
  local src = debug.getinfo(1, "S").source:gsub("^@", "")
  local p = io.popen("readlink -f '" .. src:gsub("'", "'\\''") .. "' 2>/dev/null")
  local real = p and p:read("*l") or ""
  if p then p:close() end
  local root = real:match("^(.*)/hypr/hyprpi%.lua$")
  return root or ((os.getenv("HOME") or "") .. "/Work/hyprpi")
end
local HYPRPI_ROOT = hyprpi_root()
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
--   SUPER + ALT + R    the Stream panel (kitty) for the current world
--   SUPER + ALT + P    projects panel (the project board) for the current world
--   SUPER + SHIFT + SPACE  find an agent or project (the finder add-on; the bar toggle then moves to SUPER + ALT + B)
--   SUPER + CTRL + ALT + P  all four panels here (opened if needed), tiled as a 2x2 grid
--   SUPER + ALT + /    search TUI (kitty) for the current world's room
o.bind("SUPER + A", "Pi agent (hyprpi)", HYPRPI_BIN .. " new")
o.bind("SUPER + ALT + A", "hyprpi agent panel (current world)", HYPRPI_ROOT .. "/mockups/panels --only 1")
o.bind("SUPER + ALT + R", "hyprpi Stream panel (current world)", HYPRPI_ROOT .. "/mockups/panels --only 2")
o.bind("SUPER + CTRL + ALT + P", "hyprpi panels here as a 2x2 grid", HYPRPI_ROOT .. "/mockups/panels")
-- Omarchy binds SUPER + ALT + / to "Monitor scaling down"; both fired on one press. Take the key
-- for search and move scaling down to SUPER + SHIFT + / (scaling up stays on SUPER + /).
hl.unbind("SUPER + ALT + SLASH")
o.bind("SUPER + SHIFT + SLASH", "Monitor scaling down", "omarchy-hyprland-monitor-scaling down")
-- The board panel is the projects panel on SUPER + ALT + P (Angus, 2026-09-29); SUPER + ALT + B is free.
o.bind("SUPER + ALT + P", "hyprpi projects panel (current world)", HYPRPI_ROOT .. "/mockups/panels --only 4")
o.bind("SUPER + ALT + slash", "hyprpi search TUI (current world)", HYPRPI_ROOT .. "/mockups/panels --only 3")
-- Jump to a panel instead of bringing it here (J195, Angus): its workspace, focused; not open → brought
-- here as above. SUPER+SHIFT+ALT+A (the agents panel) is Omarchy's Grok web app, so it has no jump key yet.
o.bind("SUPER + SHIFT + ALT + R", "hyprpi: jump to the Stream panel", HYPRPI_ROOT .. "/mockups/panel-jump 2")
o.bind("SUPER + SHIFT + ALT + P", "hyprpi: jump to the projects panel", HYPRPI_ROOT .. "/mockups/panel-jump 4")
o.bind("SUPER + SHIFT + ALT + slash", "hyprpi: jump to the search / Thoughts panel", HYPRPI_ROOT .. "/mockups/panel-jump 3")
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

-- Summon & dismiss (Angus, 2026-09-30, v1; mockups/summon.mjs, mockups/guest, daemon guest.*):
--   SUPER+S          summon pop-up: this world's agents / projects to the workspace you're on
--   SUPER+D          dismiss the focused agent (a hyprpi panel: closed)
--   SUPER+ALT+D      dismiss all: everything hyprpi on this workspace except pinned windows and the focused one
--   SUPER+ALT+S      pin / unpin the focused agent or panel (light blue border while pinned)
-- SUPER+S: Omarchy's scratchpad key (Reprieve's show/hide parked once); hyprpi's summon takes it.
hl.unbind("SUPER + S")
o.bind("SUPER + S", "hyprpi: summon agents here", HYPRPI_ROOT .. "/mockups/summon")
o.bind("SUPER + D", "hyprpi: dismiss the focused agent", HYPRPI_ROOT .. "/mockups/guest dismiss")
o.bind("SUPER + ALT + D", "hyprpi: dismiss all but pinned and focused", HYPRPI_ROOT .. "/mockups/guest dismiss --all")
o.bind("SUPER + ALT + S", "hyprpi: pin / unpin the focused agent or panel", HYPRPI_ROOT .. "/mockups/guest pin")
o.window("hyprpi.summon", { float = true, center = true, size = "560 460" })
-- Colour only (Angus, J3 / N69): a different border size would resize the window's content, so
-- terminals re-wrap and the layout shifts. Pinned = the same 1 px border, light blue (J27: the bright
-- green 22c55e was too much; J25: orange clashed with world D). 93c5fd is none of the world colours A–E
-- (56949f b4637a d7827e ea9d34 907aa9) nor the grey unfocused border.
o.window({ tag = "guestpin" }, { border_color = "rgb(93c5fd) rgb(93c5fd)" })

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
