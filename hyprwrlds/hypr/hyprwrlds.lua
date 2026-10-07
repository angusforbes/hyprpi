-- hyprwrlds: "worlds" of workspaces on top of Hyprland/Omarchy.
--
-- A world is a block of ten numbered workspaces:
--   world A (1) = workspaces  1-10
--   world B (2) = workspaces 11-20
--   world C (3) = workspaces 21-30   ... up to world I (9) = 81-90
-- The current world is derived from the focused workspace id, so there is no
-- state to drift. The only memory kept is the last workspace used in each world
-- (lost on Hyprland config reload; then we fall back to the lowest occupied
-- workspace in that world, or its first workspace).
--
-- Keys (loaded after hypr/bindings.lua, replaces Omarchy's 1-10 bindings):
--   SUPER + 1..0                     workspace 1..10 of the current world
--   SUPER + SHIFT + 1..0             move window there (follow)
--   SUPER + SHIFT + ALT + 1..0       move window there silently
--   SUPER + CTRL + 1..9              switch to world A..I
--   SUPER + CTRL + SHIFT + 1..9      move window to world A..I (follow)
--   SUPER + ALT + TAB                next world  (+SHIFT: previous world)
--   SUPER + TAB / SHIFT+TAB / scroll cycle occupied workspaces within the world
--   SUPER + CTRL + ALT + 1..9        Omarchy's "Bar panel N" (moved here from
--                                    SUPER + CTRL + 1..9, swapped 2026-09-25)
-- (SUPER + ALT + 1..5 stays
-- "Switch to group window N".)
--
-- The bar widget (~/.config/omarchy/plugins/agf.hyprwrlds) calls into this
-- module with `hyprctl eval 'hyprwrlds.world(2)'` etc.

local SIZE = 10
local MAX_WORLDS = 9
-- Worlds always included when cycling (keep in step with the bar widget's
-- `worlds` setting in ~/.config/omarchy/shell.json, currently 5 = A-E).
local MIN_WORLDS = 5
-- Colour the focused-window border with the current world's hue (the same
-- theme colours as the bar widget). false = leave Omarchy's border alone.
local WORLD_BORDERS = true
local LETTERS = "ABCDEFGHI"

hyprwrlds = hyprwrlds or {}
local M = hyprwrlds
M.size = SIZE
M.max_worlds = MAX_WORLDS
M.last = M.last or {}     -- world (1-based) -> last focused workspace id
M.current = M.current or 1 -- last known world (used when on a special workspace)

local function world_of(id)
  if type(id) ~= "number" or id < 1 then return nil end
  return math.floor((id - 1) / SIZE) + 1
end
M.world_of = world_of

local function active_id()
  local ok, ws = pcall(hl.get_active_workspace)
  if ok and ws then
    local ok2, id = pcall(function() return ws.id end)
    if ok2 and type(id) == "number" then return id end
  end
  return nil
end

function M.current_world()
  local w = world_of(active_id())
  if w then M.current = w end
  return M.current
end

local function workspaces_in(world)
  local base = (world - 1) * SIZE
  local list = {}
  local ok, all = pcall(hl.get_workspaces)
  if not ok or type(all) ~= "table" then return list end
  for _, ws in ipairs(all) do
    local ok2, id, n = pcall(function() return ws.id, ws.windows end)
    if ok2 and type(id) == "number" and id > base and id <= base + SIZE then
      list[#list + 1] = { id = id, windows = n or 0 }
    end
  end
  table.sort(list, function(a, b) return a.id < b.id end)
  return list
end

local function focus_id(id)
  hl.dispatch(hl.dsp.focus({ workspace = tostring(id) }))
end

local function clamp_world(w)
  w = math.floor(tonumber(w) or 1)
  if w < 1 then w = 1 end
  if w > MAX_WORLDS then w = MAX_WORLDS end
  return w
end

local function clamp_slot(n)
  n = math.floor(tonumber(n) or 1)
  if n < 1 then n = 1 end
  if n > SIZE then n = SIZE end
  return n
end

-- Workspace id to land on when entering a world.
function M.entry_id(world)
  world = clamp_world(world)
  local last = M.last[world]
  if last and world_of(last) == world then return last end
  for _, ws in ipairs(workspaces_in(world)) do
    if ws.windows > 0 then return ws.id end
  end
  return (world - 1) * SIZE + 1
end

-- Focus slot n (1..10) of the current world.
function M.focus(n)
  local w = M.current_world()
  focus_id((w - 1) * SIZE + clamp_slot(n))
end

-- Move the active window to slot n of the current world.
function M.move(n, follow)
  local w = M.current_world()
  local target = (w - 1) * SIZE + clamp_slot(n)
  hl.dispatch(hl.dsp.window.move({ workspace = tostring(target), follow = follow ~= false }))
end

-- Switch to world w (1 = A).
function M.world(w)
  w = clamp_world(w)
  if w == M.current_world() and world_of(active_id()) == w then return end
  focus_id(M.entry_id(w))
end

-- Move the active window to world w (onto its entry workspace).
function M.move_to_world(w, follow)
  w = clamp_world(w)
  hl.dispatch(hl.dsp.window.move({ workspace = tostring(M.entry_id(w)), follow = follow ~= false }))
end

-- Highest world worth cycling through: at least MIN_WORLDS, or the highest
-- world that has a workspace or is current.
function M.world_count()
  local n = MIN_WORLDS
  local ok, all = pcall(hl.get_workspaces)
  if ok and type(all) == "table" then
    for _, ws in ipairs(all) do
      local ok2, id = pcall(function() return ws.id end)
      local w = ok2 and world_of(id)
      if w and w <= MAX_WORLDS and w > n then n = w end
    end
  end
  local cur = M.current_world()
  if cur > n then n = cur end
  return n
end

function M.cycle_world(delta)
  local n = M.world_count()
  local w = ((M.current_world() - 1 + delta) % n) + 1
  M.world(w)
end

-- Cycle through occupied workspaces (plus the current one) of this world.
function M.cycle(delta)
  local cur = active_id()
  local w = world_of(cur) or M.current_world()
  local ids = {}
  for _, ws in ipairs(workspaces_in(w)) do
    if ws.windows > 0 or ws.id == cur then ids[#ids + 1] = ws.id end
  end
  if #ids < 2 then return end
  local idx = 1
  for i, id in ipairs(ids) do if id == cur then idx = i end end
  focus_id(ids[((idx - 1 + delta) % #ids) + 1])
end

function M.letter(w)
  w = clamp_world(w)
  return LETTERS:sub(w, w)
end

-- Debug: `hyprctl repl 'return hyprwrlds.state()'`
function M.state()
  local parts = { "world=" .. M.letter(M.current_world()), "ws=" .. tostring(active_id()) }
  for w = 1, MAX_WORLDS do
    if M.last[w] then parts[#parts + 1] = M.letter(w) .. ":" .. M.last[w] end
  end
  return table.concat(parts, " ")
end

-- Remember the last workspace used in each world.
if not M.subscribed then
  M.subscribed = true
  pcall(hl.on, "workspace.active", function()
    local id = active_id()
    local w = world_of(id)
    if w then
      M.last[w] = id
      M.current = w
    end
  end)
end

-- ---------------------------------------------------------------------------
-- Key bindings. Omarchy binds workspace keys as code:10..code:19 (1..0).
for slot = 1, SIZE do
  local key = "code:" .. tostring(slot + 9)
  local label = slot == SIZE and "0" or tostring(slot)

  hl.unbind("SUPER + " .. key)
  hl.unbind("SUPER + SHIFT + " .. key)
  hl.unbind("SUPER + SHIFT + ALT + " .. key)

  o.bind("SUPER + " .. key, "Workspace " .. label .. " of current world (hyprwrlds)",
    function() M.focus(slot) end)
  o.bind("SUPER + SHIFT + " .. key, "Move window to workspace " .. label .. " of current world",
    function() M.move(slot, true) end)
  o.bind("SUPER + SHIFT + ALT + " .. key, "Move window silently to workspace " .. label .. " of current world",
    function() M.move(slot, false) end)
end

for w = 1, MAX_WORLDS do
  local key = "code:" .. tostring(w + 9)
  -- Worlds take SUPER + CTRL + N; Omarchy's bar panels move to SUPER + CTRL + ALT + N.
  hl.unbind("SUPER + CTRL + " .. key)
  o.bind("SUPER + CTRL + " .. key, "Switch to world " .. M.letter(w) .. " (hyprwrlds)",
    function() M.world(w) end)
  o.bind("SUPER + CTRL + ALT + " .. key, "Bar panel " .. w,
    "omarchy-shell -q shell togglePanelAt right " .. w)
  o.bind("SUPER + CTRL + SHIFT + " .. key, "Move window to world " .. M.letter(w),
    function() M.move_to_world(w, true) end)
end

-- Replaces Omarchy's "Next/Previous window in group" on these chords; group
-- windows remain reachable with SUPER + ALT + scroll and SUPER + ALT + 1..5.
hl.unbind("SUPER + ALT + TAB")
hl.unbind("SUPER + ALT + SHIFT + TAB")
o.bind("SUPER + ALT + TAB", "Next world (hyprwrlds)", function() M.cycle_world(1) end)
o.bind("SUPER + ALT + SHIFT + TAB", "Previous world (hyprwrlds)", function() M.cycle_world(-1) end)

hl.unbind("SUPER + TAB")
hl.unbind("SUPER + SHIFT + TAB")
hl.unbind("SUPER + mouse_down")
hl.unbind("SUPER + mouse_up")
o.bind("SUPER + TAB", "Next workspace in world", function() M.cycle(1) end)
o.bind("SUPER + SHIFT + TAB", "Previous workspace in world", function() M.cycle(-1) end)
o.bind("SUPER + mouse_down", "Scroll workspaces forward in world", function() M.cycle(1) end)
o.bind("SUPER + mouse_up", "Scroll workspaces backward in world", function() M.cycle(-1) end)

-- ---------------------------------------------------------------------------
-- World-coloured active border. Hues come from the current Omarchy theme's
-- colors.toml in the bar widget's order: A blue, B red, C cyan, D yellow,
-- E magenta, F green, G orange, H brown, I foreground.
local PALETTE_KEYS = {
  { "blue", "color4" }, { "red", "color1" }, { "cyan", "color6" },
  { "yellow", "color3" }, { "magenta", "color5" }, { "green", "color2" },
  { "orange", "color11" }, { "brown", "color9" }, { "foreground", "color7" },
}

function M.theme_colors()
  local path = (os.getenv("HOME") or "") .. "/.local/state/omarchy/current/theme/colors.toml"
  local ok, f = pcall(io.open, path, "r")
  if not ok or not f then return {} end
  local out = {}
  for line in f:lines() do
    local k, v = line:match('^%s*([%w_%-]+)%s*=%s*["\']?(#%x%x%x%x%x%x)')
    if k then out[k] = v end
  end
  f:close()
  return out
end

function M.world_color(w)
  local colors = M.theme_colors()
  local keys = PALETTE_KEYS[((w - 1) % #PALETTE_KEYS) + 1]
  for _, k in ipairs(keys) do
    if colors[k] then return colors[k] end
  end
  return colors.accent
end

function M.apply_border()
  if not WORLD_BORDERS then return end
  local c = M.world_color(M.current_world())
  if c and c ~= M.last_border then
    M.last_border = c
    hl.config({ general = { col = { active_border = c } } })
  end
end

M.last_border = nil           -- re-apply after every config/theme reload
if not M.border_subscribed then
  M.border_subscribed = true
  -- Look the function up at call time so config reloads can replace it.
  pcall(hl.on, "workspace.active", function()
    if hyprwrlds and hyprwrlds.apply_border then pcall(hyprwrlds.apply_border) end
  end)
end
if type(hl.get_active_workspace) == "function" then pcall(M.apply_border) end

