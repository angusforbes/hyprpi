-- hyprwrlds-vimarchy: keybindings and double-tap support for the
-- hyprwrlds-vimarchy overview (Omarchy overlay plugin agf.hyprwrlds-vimarchy).
-- https://github.com/angusforbes/hyprwrlds-vimarchy
--
-- Load AFTER hyprwrlds.lua (needs the global `hyprwrlds` table):
--   require("hypr.hyprwrlds")
--   require("hypr.hyprwrlds-vimarchy")

local M = hyprwrlds
if type(M) ~= "table" then
  hyprwrlds = {}
  M = hyprwrlds
end

-- hyprwrlds-vimarchy overview (Omarchy overlay plugin agf.hyprwrlds-vimarchy,
-- source ~/Work/hyprpi/hyprwrlds-vimarchy). Type a window's hint to jump to it;
-- a-z first, then Shift+A-Z; Escape closes.
o.bind("ALT + CTRL + SPACE", "World overview (hyprwrlds-vimarchy)",
  [[omarchy-shell shell summon agf.hyprwrlds-vimarchy '{"mode":"world"}']])
o.bind("ALT + SHIFT + SPACE", "All-worlds overview (hyprwrlds-vimarchy)",
  [[omarchy-shell shell summon agf.hyprwrlds-vimarchy '{"mode":"all"}']])

-- ALT+SPACE: hyprwrlds-vimarchy's single-workspace view replaces the original
-- Vimarchy window hints. Vimarchy's own ALT+SPACE binding (from its install
-- block) is unbound here; delete these lines to get it back.
hl.unbind("ALT + SPACE")
o.bind("ALT + SPACE", "Workspace window hints (hyprwrlds-vimarchy)",
  [[omarchy-shell shell summon agf.hyprwrlds-vimarchy '{"mode":"workspace"}']])

-- J209 (Angus: "these ones should work there as well"): while the switcher is open, SUPER+ALT(+CTRL/
-- +SHIFT)+arrows act IN it (move its selection by the same stops, step into an empty tile, swap the
-- selected workspace's windows, move the selected world in the order) instead of switching the
-- workspace hidden behind it. Hyprland's binds still fire under the switcher's exclusive keyboard, so
-- hyprwrlds' binds ask this hook first; the switcher then calls hyprwrlds' own Lua (hyprctl repl).
local function switcher_open()
  local ok, ls = pcall(hl.get_layers)
  if not ok or type(ls) ~= "table" then return false end
  for _, l in ipairs(ls) do
    local o, ns = pcall(function() return l.namespace end)
    if o and ns == "hyprwrlds-vimarchy" then return true end
  end
  return false
end
M.intercept = function(kind, dx, dy)
  if not switcher_open() then return false end
  local ctrl, shift = kind == "raw", kind == "swap" or kind == "order"
  hl.dispatch(hl.dsp.exec_cmd(string.format(
    [[omarchy-shell shell summon agf.hyprwrlds-vimarchy '{"grid":[%d,%d,%s,%s]}']], dx, dy, tostring(ctrl), tostring(shift))))
  return true
end

-- Original Vimarchy kept on ALT+SHIFT+CTRL+SPACE for reference (Alt+hold
-- workspace radial, swap, pair...).
o.bind("ALT + SHIFT + CTRL + SPACE", "Original Vimarchy window hints",
  os.getenv("HOME") .. "/.config/omarchy/plugins/vimarchy/bin/open")

-- Double-tap (hyprwrlds-vimarchy): after a hint jump the overlay calls
-- hyprwrlds.arm_double_tap(key, mode, ms). For `ms` milliseconds only a repeat
-- of that key (Shift+key for uppercase hints) is caught, and it toggles
-- fullscreen on the window just focused ("maximized" = full working area, like
-- Vimarchy's double-tap and SUPER+F; "fullscreen" = true fullscreen). Every
-- other key goes to the app as usual (a submap only catches its own binds).
M.dt_gen = M.dt_gen or 0
M.dt_mode = M.dt_mode or "maximized"

local function dt_leave()
  local ok, sub = pcall(hl.get_current_submap)
  if ok and type(sub) == "string" and sub:match("^hwv%-dt%-") then
    hl.dispatch(hl.dsp.submap("reset"))
  end
end

local function dt_fire()
  M.dt_gen = M.dt_gen + 1           -- cancel the pending timeout
  hl.dispatch(hl.dsp.submap("reset"))
  hl.dispatch(hl.dsp.window.fullscreen({ mode = M.dt_mode }))
end

function M.arm_double_tap(key, mode, ms)
  key = tostring(key or "")
  if not key:match("^%a$") then return end
  M.dt_mode = (mode == "fullscreen") and "fullscreen" or "maximized"
  ms = math.max(120, math.min(800, tonumber(ms) or 300))
  local shifted = key:match("%u") ~= nil
  local name = "hwv-dt-" .. (shifted and "S-" or "") .. key:lower()
  M.dt_gen = M.dt_gen + 1
  local gen = M.dt_gen
  hl.dispatch(hl.dsp.submap(name))
  hl.timer(function() if gen == M.dt_gen then dt_leave() end end, { timeout = ms, type = "oneshot" })
end

for letter in ("abcdefghijklmnopqrstuvwxyz"):gmatch(".") do
  hl.define_submap("hwv-dt-" .. letter, function()
    hl.bind(letter, dt_fire)
    hl.bind("SUPER + ESCAPE", hl.dsp.submap("reset"))
  end)
  hl.define_submap("hwv-dt-S-" .. letter, function()
    hl.bind("SHIFT + " .. letter, dt_fire)
    hl.bind("SUPER + ESCAPE", hl.dsp.submap("reset"))
  end)
end
