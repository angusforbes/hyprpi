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
--   SUPER + ALT + LEFT / RIGHT       previous / next workspace in this world (wraps; empty ones too)
--   SUPER + ALT + UP / DOWN          same workspace in the previous / next world (wraps)
--                                    (replace Omarchy's "move window to group" binds; J205)
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

local function existing_ids()
  local ids = {}
  local ok, all = pcall(hl.get_workspaces)
  if ok and type(all) == "table" then
    for _, ws in ipairs(all) do
      local ok2, id = pcall(function() return ws.id end)
      if ok2 and type(id) == "number" and id >= 1 then ids[#ids + 1] = id end
    end
  end
  return ids
end
function M.cycle_world(delta) -- SUPER+ALT+TAB: the world stops, in the world order (J207)
  local stops = M.world_stops(existing_ids(), active_id())
  local cur = M.current_world()
  local i = 1
  for k, w in ipairs(stops) do if w == cur then i = k end end
  M.world(stops[((i - 1 + delta) % #stops) + 1])
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

-- The grid (J205, v2 J207). Rows = worlds, columns = workspaces 1-10 of a world.
-- SUPER+ALT+arrows (J208): Left/Right visit only the active workspaces of the world (ragged, like
-- the switcher); Up/Down visit worlds A-E always and F-I when in use (in the world order), keeping
-- the column when the target world has it active, else its highest stop below. Workspace 1 of every
-- world is always a stop (J208 v3). Everything wraps.
-- Pure (testable): ids = existing workspace ids, cur = the active id.
local BASE = 5
-- World ORDER (J207, Angus: "keep the letter the same but just change how they're positioned"):
-- ~/.config/hyprwrlds/order lists the letters top to bottom, e.g. "A C B D E F G H I" (missing letters
-- follow in alphabetical order; lines starting with # are comments). Only positions change: windows,
-- letters, workspace ids (B is always 11-20) and hyprpi's rooms stay as they are. The bar widget and
-- the hyprwrlds-vimarchy switcher read the same file. SUPER+ALT+SHIFT+UP/DOWN swaps worlds in it.
local ORDER_FILE = (os.getenv("XDG_CONFIG_HOME") or ((os.getenv("HOME") or "") .. "/.config")) .. "/hyprwrlds/order"
M.order_file = ORDER_FILE
function M.parse_order(text)
  local order, seen = {}, {}
  for line in tostring(text or ""):gmatch("[^\n]+") do
    if not line:match("^%s*#") then
      for ch in line:upper():gmatch("%a") do
        local w = LETTERS:find(ch, 1, true)
        if w and w <= MAX_WORLDS and not seen[w] then order[#order + 1] = w; seen[w] = true end
      end
    end
  end
  for w = 1, MAX_WORLDS do if not seen[w] then order[#order + 1] = w end end
  return order
end
function M.order()
  if M.order_override then return M.order_override end -- tests
  local f = io.open(ORDER_FILE, "r")
  local text = f and f:read("a") or ""
  if f then f:close() end
  return M.parse_order(text)
end
local function pos_map(order) local pos = {} for i, w in ipairs(order) do pos[w] = i end return pos end
function M.save_order(order)
  os.execute("mkdir -p '" .. ORDER_FILE:gsub("/[^/]*$", "") .. "'")
  local parts = {}
  for _, w in ipairs(order) do parts[#parts + 1] = M.letter(w) end
  local f = io.open(ORDER_FILE .. ".tmp", "w")
  if not f then return false end
  f:write("# hyprwrlds world order, top to bottom (SUPER+ALT+SHIFT+UP/DOWN swaps; edit freely)\n" .. table.concat(parts, " ") .. "\n")
  f:close()
  return os.rename(ORDER_FILE .. ".tmp", ORDER_FILE)
end
local function sorted_keys(set) local t = {} for k in pairs(set) do t[#t + 1] = k end table.sort(t) return t end
-- J208 (Angus: "I like the raggedness"): a workspace is a Left/Right stop only when it's active,
-- i.e. it exists (Hyprland keeps a workspace while it has windows or is the one you're on), in 1-5
-- too: B2 -> B4 when B3 is empty. SUPER+ALT+CTRL+Left/Right still steps into (creates) the gaps.
function M.col_stops(world, ids, cur)
  local set = { [1] = true } -- J208 v3 (Angus: "for sanity"): workspace 1 of every world is always a stop
  local function take(id) if world_of(id) == world then set[id - (world - 1) * SIZE] = true end end
  for _, id in ipairs(ids or {}) do take(id) end
  if cur then take(cur) end
  return sorted_keys(set)
end
-- Worlds that are stops, top to bottom in the world order: the first MIN_WORLDS positions always,
-- then any other world in use (or current).
function M.world_stops(ids, cur)
  local order = M.order()
  local set = {}
  for i = 1, MIN_WORLDS do set[order[i]] = true end
  local function take(id) local w = world_of(id); if w and w <= MAX_WORLDS then set[w] = true end end
  for _, id in ipairs(ids or {}) do take(id) end
  if cur then take(cur) end
  local out = {}
  for _, w in ipairs(order) do if set[w] then out[#out + 1] = w end end
  return out
end
local function index_of(list, v) for i, x in ipairs(list) do if x == v then return i end end return nil end
function M.step_from(cur, dx, dy, ids)
  local w = world_of(cur) or 1
  local col = cur - (w - 1) * SIZE
  if dx ~= 0 then
    local stops = M.col_stops(w, ids, cur)
    local i = index_of(stops, col) or 1
    col = stops[((i - 1 + dx) % #stops) + 1]
  end
  if dy ~= 0 then
    local ws = M.world_stops(ids, cur)
    local i = index_of(ws, w) or 1
    w = ws[((i - 1 + dy) % #ws) + 1]
    -- the same column when the target world has it; else its highest stop below the column
    -- (workspace 1 at least, which is always a stop).
    local cs = M.col_stops(w, ids, nil)
    if not index_of(cs, col) then local best = cs[1]; for _, c in ipairs(cs) do if c <= col then best = c end end; col = best end
  end
  return (w - 1) * SIZE + col
end
-- SUPER+ALT+CTRL+arrows: one step to the adjacent workspace number (Left/Right, 1-10) or world
-- (Up/Down, A-I, keeping the column), empty or not; Hyprland creates it when you go there. Wraps.
function M.raw_from(cur, dx, dy)
  local w = world_of(cur) or 1
  local col = cur - (w - 1) * SIZE
  col = ((col - 1 + dx) % SIZE) + 1
  if dy ~= 0 then local order = M.order(); local p = pos_map(order)[w] or 1; w = order[((p - 1 + dy) % #order) + 1] end
  return (w - 1) * SIZE + col
end
local function cur_or_entry()
  local cur = active_id()
  if not cur or cur < 1 then cur = (M.current_world() - 1) * SIZE + 1 end
  return cur
end
-- The same steps from a GIVEN workspace (J209): the hyprwrlds-vimarchy switcher calls these through
-- `hyprctl repl` for SUPER+ALT(+CTRL/+SHIFT)+arrows while it holds the keyboard, so the keys and the
-- switcher share one implementation. M.target: the SUPER+ALT+arrow stop from cur.
function M.target(cur, dx, dy) return M.step_from(cur, dx, dy, existing_ids()) end
-- M.intercept(kind, dx, dy) (J209): set by an add-on that holds the keyboard (hyprwrlds-vimarchy's
-- switcher), whose own key handler never sees these keys because Hyprland's binds still fire under an
-- exclusive layer. Return true when it took the key; kind = "step" | "raw" | "swap" | "order".
local function taken(kind, dx, dy)
  if type(M.intercept) ~= "function" then return false end
  local ok, r = pcall(M.intercept, kind, dx, dy)
  return ok and r == true
end
-- SUPER + ALT + arrows: move around the grid (stops as above).
function M.step(dx, dy) if taken("step", dx, dy) then return end focus_id(M.target(cur_or_entry(), dx, dy)) end
-- SUPER + ALT + CTRL + arrows: the adjacent workspace / world, created if needed.
function M.step_raw(dx, dy) if taken("raw", dx, dy) then return end focus_id(M.raw_from(cur_or_entry(), dx, dy)) end

-- SUPER + ALT + SHIFT + LEFT / RIGHT: swap this workspace's windows with the neighbouring
-- workspace's (the same world, the adjacent number; wraps 10 <-> 1) and follow. Windows move
-- silently with Hyprland's own move; hyprpi picks up its agents' new workspaces from the windows.
local function windows_on(id)
  local out = {}
  local ok, list = pcall(hl.get_workspace_windows, id)
  if ok and type(list) == "table" then
    for _, w in ipairs(list) do local o, a = pcall(function() return w.address end); if o and a then out[#out + 1] = a end end
  end
  return out
end
function M.swap_with(a, b)
  local wa, wb = windows_on(a), windows_on(b)
  for _, addr in ipairs(wa) do hl.dispatch(hl.dsp.window.move({ window = "address:" .. addr, workspace = tostring(b), follow = false })) end
  for _, addr in ipairs(wb) do hl.dispatch(hl.dsp.window.move({ window = "address:" .. addr, workspace = tostring(a), follow = false })) end
  return #wa, #wb
end
-- SUPER + ALT + SHIFT + UP / DOWN: swap this world with the neighbouring world stop in the ORDER
-- (positions only; nothing moves). Wraps (J208): the first world + Up swaps with the last stop, the
-- last + Down with the first.
function M.swap_world_in(order, w, dy, stops)
  local i
  for k, x in ipairs(stops) do if x == w then i = k end end
  if not i or #stops < 2 then return nil end
  local other = stops[((i - 1 + dy) % #stops) + 1] -- J208: wraps (first + Up swaps with the last)
  local out, p = {}, pos_map(order)
  for k, x in ipairs(order) do out[k] = x end
  out[p[w]], out[p[other]] = other, w
  return out, other
end
-- World w (J209: the switcher passes its selected world and workspace, so an empty world it just
-- stepped into counts as a stop; the key passes the current one).
function M.swap_world_of(w, dy, cur)
  local order = M.order()
  local new, other = M.swap_world_in(order, w, dy, M.world_stops(existing_ids(), cur or active_id()))
  if new then M.save_order(new) end
  return other
end
function M.swap_world(dy) if taken("order", 0, dy) then return end return M.swap_world_of(M.current_world(), dy) end
-- Workspace cur's windows with its neighbour's (J209: the switcher passes its selection) -> the neighbour.
function M.swap_ws(cur, dx)
  local other = M.raw_from(cur, dx, 0)
  M.swap_with(cur, other)
  return other
end
function M.swap(dx) if taken("swap", dx, 0) then return end focus_id(M.swap_ws(cur_or_entry(), dx)) end

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
-- J205 (Angus: "I never use groups"): SUPER + ALT + arrows walk the worlds x workspaces grid,
-- replacing Omarchy's "move window to group" binds. Left/Right: previous/next workspace in this
-- world; Up/Down: the same column in the previous/next world. Everything wraps; empty
-- workspaces are stops too.
for _, a in ipairs({ { "LEFT", -1, 0, "Previous workspace in world" }, { "RIGHT", 1, 0, "Next workspace in world" },
                     { "UP", 0, -1, "Same workspace in previous world" }, { "DOWN", 0, 1, "Same workspace in next world" } }) do
  hl.unbind("SUPER + ALT + " .. a[1])
  o.bind("SUPER + ALT + " .. a[1], a[4] .. " (hyprwrlds grid, wraps)", function() M.step(a[2], a[3]) end)
  -- J207: + CTRL steps one by one, empty ones too, creating the next workspace / world.
  hl.unbind("SUPER + ALT + CTRL + " .. a[1])
  o.bind("SUPER + ALT + CTRL + " .. a[1], a[4] .. ", one by one, creating it (hyprwrlds)", function() M.step_raw(a[2], a[3]) end)
end
-- J207: + SHIFT + Left/Right swaps this workspace with its neighbour; + SHIFT + Up/Down swaps this
-- world's place in the world order (replaces Omarchy's "move workspace to monitor", a no-op with one monitor).
for _, a in ipairs({ { "LEFT", -1, "Swap workspace with the previous one" }, { "RIGHT", 1, "Swap workspace with the next one" } }) do
  hl.unbind("SUPER + SHIFT + ALT + " .. a[1])
  o.bind("SUPER + SHIFT + ALT + " .. a[1], a[3] .. " (hyprwrlds)", function() M.swap(a[2]) end)
end
for _, a in ipairs({ { "UP", -1, "Move this world up in the world order" }, { "DOWN", 1, "Move this world down in the world order" } }) do
  hl.unbind("SUPER + SHIFT + ALT + " .. a[1])
  o.bind("SUPER + SHIFT + ALT + " .. a[1], a[3] .. " (hyprwrlds)", function() M.swap_world(a[2]) end)
end

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

