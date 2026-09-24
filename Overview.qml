import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import QtQuick

// hyprwrlds-vimarchy overview.
//
// Two modes:
//   "world" - the current world's occupied workspaces side by side
//   "all"   - one row per world that has windows (A, B, C ...)
// Each window is drawn as an outlined box at its real position/size inside a
// mini-screen for its workspace, with a Vimarchy-style letter hint. Typing a
// hint focuses that window (Hyprland switches to its workspace). Escape,
// Backspace-on-empty or a click on the backdrop closes.
//
// Worlds follow hyprwrlds (~/.config/hypr/hyprwrlds.lua): world w holds
// workspaces (w-1)*10+1 .. w*10. World hues come from the Omarchy theme's
// colors.toml, in the same order as the hyprwrlds bar widget.
//
// Self-contained on purpose: no qs.Commons dependency, so the same file runs
// in a standalone Quickshell instance (development) and as an Omarchy plugin.
Item {
  id: root

  signal dismissed()

  property bool opened: false
  property string mode: "world"          // "world" | "all"
  property var rows: []                  // [{ world, letter, color, workspaces: [{ id, slot, windows: [...] }] }]
  property var hints: ({})               // hint -> window
  property string typed: ""
  property var monitor: null             // focused monitor (logical geometry)
  property int activeWorkspace: 0
  property string activeAddress: ""
  property int loadGeneration: 0
  property int hintStart: 0              // testing only: pretend this many windows come first
  property bool dry: false               // testing only: build hints but never show/grab keys

  readonly property int size: 10
  readonly property int maxWorlds: 9
  readonly property string letters: "ABCDEFGHI"
  // Alphabetical so hints read contiguously: a, b, c ... through a workspace
  // and on into the next workspace of the same world (then the next world).
  property string hintKeys: "abcdefghijklmnopqrstuvwxyz"
  property string fontFamily: "JetBrainsMono Nerd Font"

  // ---- Vimarchy look -------------------------------------------------------
  // Same palette and tint levels as Vimarchy: each window gets a colour in
  // hint order; its box is tinted and outlined in it, and its hint is a
  // translucent circle with the letter in full colour.
  property var hintPalette: [
    "#818cf8", "#a78bfa", "#c084fc", "#e879f9", "#f472b6",
    "#fb7185", "#fb923c", "#facc15", "#a3e635", "#4ade80",
    "#2dd4bf", "#22d3ee", "#38bdf8", "#60a5fa"
  ]
  property real hintScale: 1.0           // Ctrl+= / Ctrl+- while open (0.75-1.5)
  // Circle size, exactly Vimarchy's rule: shorter side of the REAL window x
  // badgeFraction, clamped to [badgeMin, badgeMax] px, x hintScale; then
  // scaled down by the mini-map factor like everything else in the tile.
  property real badgeMin: 72
  property real badgeMax: 132
  property real badgeFraction: 0.34
  function vimarchyBadge(w, h) {
    return Math.max(badgeMin, Math.min(badgeMax, Math.min(w, h) * badgeFraction)) * hintScale
  }
  property real backdropOpacity: 0.94
  property string align: "left"          // "left" | "center"
  property real edgeMargin: 48
  property bool uppercaseHints: true     // Shift+A-Z after 26 windows (else two letters)
  property bool shortenAppNames: true
  property bool doubleTap: true          // quick repeat of a hint's last key toggles fullscreen
  property string doubleTapMode: "maximized"   // "maximized" (full working area) | "fullscreen"
  property int doubleTapMs: 300
  property bool badgeBacking: false      // cream disc under each circle (not in Vimarchy)
  property real maxTileWidth: 460        // largest workspace tile width in px (shrinks to fit)
  property real windowTintOpacity: 0.07
  property real badgeTintOpacity: 0.21
  property bool showPreviews: true       // captured app contents inside each box
  property bool shiftRing: false         // extra ring around Shift (A-Z) hints
  property bool settingsLoaded: false
  property var settingsData: ({})

  // Every user-tunable setting, with its default. The file
  // ~/.config/omarchy/hyprwrlds-vimarchy.json is (re)written with any missing
  // keys filled in, so it always lists everything that can be changed.
  readonly property var defaults: ({
    workspacesPerRow: 3,
    worldsVisible: 3,
    align: "left",
    margin: 48,
    maxTileWidth: 460,
    hintKeys: "abcdefghijklmnopqrstuvwxyz",
    uppercaseHints: true,
    shortenAppNames: true,
    showPreviews: true,
    shiftRing: false,
    doubleTap: true,
    doubleTapMode: "maximized",
    doubleTapMs: 300,
    badgeBacking: false,
    hintScale: 1.0,
    badgeMin: 72,
    badgeMax: 132,
    badgeFraction: 0.34,
    windowTintOpacity: 0.07,
    badgeTintOpacity: 0.21,
    backdropOpacity: 0.94,
    palette: ["#818cf8", "#a78bfa", "#c084fc", "#e879f9", "#f472b6",
              "#fb7185", "#fb923c", "#facc15", "#a3e635", "#4ade80",
              "#2dd4bf", "#22d3ee", "#38bdf8", "#60a5fa"]
  })

  function num(v, lo, hi, dflt) {
    var n = Number(v)
    return (v !== undefined && v !== null && v !== "" && isFinite(n)) ? Math.max(lo, Math.min(hi, n)) : dflt
  }

  function loadSettings(raw) {
    var data = {}
    try { data = JSON.parse(raw || "{}") } catch (e) { data = {} }
    if (typeof data !== "object" || data === null || Array.isArray(data)) data = {}
    var d = root.defaults
    root.settingsData = data

    root.visibleCols = Math.round(num(data.workspacesPerRow, 1, 10, d.workspacesPerRow))
    root.visibleRows = Math.round(num(data.worldsVisible, 1, 9, d.worldsVisible))
    root.align = data.align === "center" ? "center" : "left"
    root.edgeMargin = num(data.margin, 0, 400, d.margin)
    root.maxTileWidth = num(data.maxTileWidth, 120, 2000, d.maxTileWidth)
    // hintKeys: unique lowercase letters, at least 2; else the default.
    var keys = String(data.hintKeys || "").toLowerCase().replace(/[^a-z]/g, "")
    var uniq = ""
    for (var i = 0; i < keys.length; i++) if (uniq.indexOf(keys.charAt(i)) < 0) uniq += keys.charAt(i)
    root.hintKeys = uniq.length >= 2 ? uniq : d.hintKeys
    root.uppercaseHints = data.uppercaseHints !== false
    root.shortenAppNames = data.shortenAppNames !== false
    root.showPreviews = data.showPreviews !== false
    root.shiftRing = data.shiftRing === true
    root.doubleTap = data.doubleTap !== false
    root.doubleTapMode = data.doubleTapMode === "fullscreen" ? "fullscreen" : "maximized"
    root.doubleTapMs = Math.round(num(data.doubleTapMs, 120, 800, d.doubleTapMs))
    root.badgeBacking = data.badgeBacking === true
    root.hintScale = num(data.hintScale, root.minHintScale, root.maxHintScale, d.hintScale)
    root.badgeMin = num(data.badgeMin, 8, 400, d.badgeMin)
    root.badgeMax = Math.max(root.badgeMin, num(data.badgeMax, 8, 600, d.badgeMax))
    root.badgeFraction = num(data.badgeFraction, 0.05, 1, d.badgeFraction)
    root.windowTintOpacity = num(data.windowTintOpacity, 0, 0.30, d.windowTintOpacity)
    root.badgeTintOpacity = num(data.badgeTintOpacity, 0, 0.30, d.badgeTintOpacity)
    root.backdropOpacity = num(data.backdropOpacity, 0, 1, d.backdropOpacity)
    var pal = Array.isArray(data.palette)
      ? data.palette.filter(function(c) { return /^#[0-9A-Fa-f]{6}$/.test(String(c)) }) : []
    root.hintPalette = pal.length ? pal : d.palette

    root.settingsLoaded = true
    // Fill in any missing keys so the file documents every setting.
    for (var k in d) {
      if (!(k in data)) { settingsSaveTimer.restart(); break }
    }
  }

  function saveSettings() {
    if (!root.settingsLoaded) return
    var data = {}
    for (var k in root.settingsData) data[k] = root.settingsData[k]
    var d = root.defaults
    for (var dk in d) if (!(dk in data)) data[dk] = d[dk]
    data.hintScale = root.hintScale      // the only setting changed from the UI (Ctrl+=/-)
    // Stable, readable key order: known settings first, then anything else.
    var ordered = {}
    for (var ok in d) ordered[ok] = data[ok]
    for (var ek in data) if (!(ek in ordered)) ordered[ek] = data[ek]
    root.settingsData = ordered
    settingsFile.setText(JSON.stringify(ordered, null, 2) + "\n")
  }

  // Ctrl+= / Ctrl+-: grow/shrink every circle by 15% per press, 0.5x-5x.
  readonly property real minHintScale: 0.5
  readonly property real maxHintScale: 5.0
  function adjustHintScale(delta) {
    var next = root.hintScale * Math.pow(1.15, Number(delta || 0))
    root.hintScale = Math.max(minHintScale, Math.min(maxHintScale, Math.round(next * 100) / 100))
    if (root.settingsLoaded) settingsSaveTimer.restart()
    return "ok"
  }

  FileView {
    id: settingsFile
    path: Quickshell.env("HOME") + "/.config/omarchy/hyprwrlds-vimarchy.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadSettings(text())
    onLoadFailed: root.loadSettings("")
    onFileChanged: reload()
  }

  Timer { id: settingsSaveTimer; interval: 150; repeat: false; onTriggered: root.saveSettings() }

  // ---- theme ---------------------------------------------------------------
  property var themeColors: ({})
  readonly property var paletteKeys: [
    ["blue", "color4"], ["red", "color1"], ["cyan", "color6"],
    ["yellow", "color3"], ["magenta", "color5"], ["green", "color2"],
    ["orange", "color11"], ["brown", "color9"], ["foreground", "color7"]
  ]
  readonly property color fg: themeColors.foreground || "#575279"
  readonly property color bg: themeColors.background || "#faf4ed"
  readonly property color accent: themeColors.accent || "#56949f"

  function worldColor(w) {
    var keys = paletteKeys[(w - 1) % paletteKeys.length]
    for (var i = 0; i < keys.length; i++) {
      if (themeColors[keys[i]]) return themeColors[keys[i]]
    }
    return root.accent
  }

  function parseColors(raw) {
    var out = {}
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
      if (m) out[m[1]] = m[2]
    }
    themeColors = out
  }

  FileView {
    id: colorsFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: root.parseColors(text())
  }

  // ---- open / close --------------------------------------------------------
  function open(payloadJson) {
    var payload = {}
    try { payload = JSON.parse(String(payloadJson || "{}")) } catch (e) { payload = {} }
    root.mode = (payload.mode === "all" || payload.mode === "workspace") ? payload.mode : "world"
    root.hintStart = Math.max(0, Number(payload.hintStart) || 0)
    root.dry = payload.dry === true
    root.typed = ""
    root.held = null
    root.holdCandidate = ""
    root.virtualWs = ({})
    root.virtualWorlds = []
    root.keepSelectId = 0
    root.notice = ""
    colorsFile.reload()
    root.loadGeneration++
    snapshot.generation = root.loadGeneration
    snapshot.running = true
  }

  function close() {
    root.loadGeneration++
    root.opened = false
    root.typed = ""
    root.rows = []
    root.hints = ({})
    root.dismissed()
  }

  Process {
    id: snapshot
    property int generation: 0
    running: false
    command: ["sh", "-c",
      "printf '{\"clients\":%s,\"monitors\":%s,\"active\":%s}' " +
      "\"$(hyprctl -j clients)\" \"$(hyprctl -j monitors)\" \"$(hyprctl -j activewindow)\""]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applySnapshot(text, snapshot.generation)
    }
    onExited: function(exitCode) { if (exitCode !== 0) root.close() }
  }

  // Short app label from a window class: what's after the last ".", ignoring a
  // Chromium profile suffix ("__-Default") and web-domain endings, so
  // "chrome-web.whatsapp.com__-Default" -> "whatsapp",
  // "md.obsidian.Obsidian" -> "Obsidian", "foot" -> "foot".
  readonly property var domainEndings: ["com", "org", "net", "io", "app", "dev", "ai", "co", "uk",
    "us", "de", "fr", "eu", "me", "tv", "gg", "so", "sh", "edu", "gov", "info", "biz"]
  function shortClass(cls) {
    var s = String(cls || "").replace(/__.*$/, "")
    var parts = s.split(".").filter(function(p) { return p.length > 0 })
    while (parts.length > 1 && domainEndings.indexOf(parts[parts.length - 1].toLowerCase()) >= 0) parts.pop()
    return parts.length ? parts[parts.length - 1] : String(cls || "")
  }

  // Wayland toplevel for a Hyprland window address ("0x5579...").
  function toplevelFor(address) {
    var want = String(address || "").replace(/^0x/, "")
    var values = Hyprland.toplevels.values
    for (var i = 0; i < values.length; i++) {
      if (String(values[i].address).replace(/^0x/, "") === want) return values[i].wayland
    }
    return null
  }

  function worldOf(id) { return id >= 1 ? Math.floor((id - 1) / size) + 1 : 0 }

  // Hints: windows 1-26 get a-z, 27-52 get A-Z (Shift + the same key), in
  // reading order (world, workspace, then left-to-right / top-to-bottom).
  // Beyond 52 every window gets a two-letter lowercase hint.
  // Hints for `total` windows, most of them single keys. Single keys are the
  // hint letters, then (with uppercaseHints) their Shift versions. Only when
  // there are more windows than single keys do the LAST few single keys become
  // prefixes for two-key hints (prefix + lowercase letter), so e.g. 57 windows
  // get a-z, A-Y, then Za..Zf.
  function buildHints(total) {
    var lower = hintKeys.split("")
    var singles = lower.slice()
    if (root.uppercaseHints) singles = singles.concat(lower.map(function(k) { return k.toUpperCase() }))
    var k = singles.length
    if (total <= k) return singles.slice(0, total)
    var p = 1
    while ((k - p) + p * lower.length < total && p < k) p++
    var out = singles.slice(0, k - p)
    var prefixes = singles.slice(k - p)
    for (var i = 0; i < prefixes.length && out.length < total; i++)
      for (var j = 0; j < lower.length && out.length < total; j++)
        out.push(prefixes[i] + lower[j])
    return out
  }

  function isShiftHint(hint) { return hint !== hint.toLowerCase() }

  function applySnapshot(raw, generation) {
    if (generation !== root.loadGeneration) return
    root.lastRaw = raw
    var data
    try { data = JSON.parse(raw) } catch (e) { console.warn("hyprwrlds-vimarchy: bad snapshot", e); root.close(); return }

    // Focused monitor, in logical (layout) coordinates.
    var mons = data.monitors || []
    var mon = null
    for (var i = 0; i < mons.length; i++) if (mons[i].focused) mon = mons[i]
    if (!mon && mons.length) mon = mons[0]
    if (!mon) { root.close(); return }
    var scale = mon.scale || 1
    root.monitor = {
      name: mon.name, x: mon.x, y: mon.y,
      width: Math.round(mon.width / scale), height: Math.round(mon.height / scale)
    }
    root.activeWorkspace = mon.activeWorkspace ? mon.activeWorkspace.id : 0
    root.activeAddress = data.active && data.active.address ? data.active.address : ""
    var currentWorld = worldOf(root.activeWorkspace) || 1

    // Group mapped windows on numbered workspaces: world -> workspace -> windows.
    var byWorld = {}
    var clients = data.clients || []
    for (var c = 0; c < clients.length; c++) {
      var cl = clients[c]
      var wsId = cl.workspace ? cl.workspace.id : 0
      if (wsId < 1 || !cl.mapped || cl.hidden) continue
      var w = worldOf(wsId)
      if (!byWorld[w]) byWorld[w] = {}
      if (!byWorld[w][wsId]) byWorld[w][wsId] = []
      byWorld[w][wsId].push({
        address: cl.address, cls: root.shortenAppNames ? shortClass(cl["class"]) : (cl["class"] || ""), fullClass: cl["class"] || "", title: cl.title || "",
        x: cl.at[0] - mon.x, y: cl.at[1] - mon.y, w: cl.size[0], h: cl.size[1],
        floating: cl.floating === true, fullscreen: (cl.fullscreen || 0) !== 0, workspace: wsId
      })
    }

    // Hints are GLOBAL: assigned over every window in reading order (world,
    // workspace, then left-to-right / top-to-bottom), so a window has the same
    // letter (and colour) in all three views. Each view then shows, and
    // accepts keys for, only its own windows.
    function shown(world, wsId) {
      if (root.mode === "world") return world === currentWorld
      if (root.mode === "workspace") return wsId === root.activeWorkspace
      return true
    }
    var out = []
    var ordered = []
    var worldIds = Object.keys(byWorld).map(Number).sort(function(a, b) { return a - b })
    for (var wi = 0; wi < worldIds.length; wi++) {
      var world = worldIds[wi]
      var wsIds = Object.keys(byWorld[world]).map(Number).sort(function(a, b) { return a - b })
      var wsList = []
      for (var si = 0; si < wsIds.length; si++) {
        var wins = byWorld[world][wsIds[si]]
        wins.sort(function(a, b) { return (a.x - b.x) || (a.y - b.y) })
        for (var k = 0; k < wins.length; k++) {
          wins[k].shown = shown(world, wsIds[si])
          ordered.push(wins[k])
        }
        if (shown(world, wsIds[si]))
          wsList.push({ id: wsIds[si], slot: wsIds[si] - (world - 1) * size, windows: wins })
      }
      if (wsList.length) out.push({ world: world, letter: letters.charAt(world - 1), workspaces: wsList })
    }

    var map = {}
    var allHints = buildHints(ordered.length + root.hintStart)
    for (var h = 0; h < ordered.length; h++) {
      ordered[h].hint = allHints[h + root.hintStart]
      ordered[h].color = hintPalette[(h + root.hintStart) % hintPalette.length]
      if (ordered[h].shown) map[ordered[h].hint] = ordered[h]
    }

    // Empty workspaces/worlds added with Alt+N / Alt+Shift+N (not in the
    // single-workspace view). They become real once a window is dropped in.
    if (root.mode !== "workspace") {
      var vw = {}
      for (var vk in root.virtualWs) vw[vk] = root.virtualWs[vk].slice()
      if (root.mode === "all") {
        for (var vi = 0; vi < root.virtualWorlds.length; vi++) {
          var nw = root.virtualWorlds[vi]
          if (!vw[nw]) vw[nw] = []
          if (vw[nw].indexOf(1) < 0) vw[nw].push(1)
        }
      }
      for (var vwKey in vw) {
        var vWorld = Number(vwKey)
        if (root.mode === "world" && vWorld !== currentWorld) continue
        var row = null
        for (var ri = 0; ri < out.length; ri++) if (out[ri].world === vWorld) row = out[ri]
        if (!row) {
          row = { world: vWorld, letter: letters.charAt(vWorld - 1), workspaces: [] }
          out.push(row)
        }
        for (var vs = 0; vs < vw[vwKey].length; vs++) {
          var slot = vw[vwKey][vs]
          var vid = (vWorld - 1) * size + slot
          var exists = false
          for (var ei = 0; ei < row.workspaces.length; ei++) if (row.workspaces[ei].id === vid) exists = true
          if (!exists) row.workspaces.push({ id: vid, slot: slot, windows: [], virtual: true })
        }
        row.workspaces.sort(function(a, b) { return a.id - b.id })
      }
      out.sort(function(a, b) { return a.world - b.world })
    }

    if (out.length === 0) { root.close(); return }
    root.hints = map
    root.rows = out

    // Start with the current workspace selected (else the current world's
    // first workspace, else the first row).
    var sr = -1, sc = 0
    var want = root.keepSelectId || root.activeWorkspace
    for (var r = 0; r < out.length; r++) {
      for (var q = 0; q < out[r].workspaces.length; q++) {
        if (out[r].workspaces[q].id === want) { sr = r; sc = q }
      }
    }
    root.keepSelectId = 0
    if (sr < 0) {
      for (var r2 = 0; r2 < out.length; r2++) if (out[r2].world === currentWorld) sr = r2
      if (sr < 0) sr = 0
    }
    root.selRow = sr
    root.selCol = sc
    root.rowOffset = 0
    root.colOffsets = ({})
    root.ensureVisible()
    root.opened = !root.dry
  }

  // ---- moving windows (keyboard-first) ---------------------------------------
  // Alt+hold a hint (holdMs) picks the window up. Then drop it with Enter (the
  // selected workspace), a digit 1-9/0 (that workspace of the selected row's
  // world), or a click on a workspace tile. Alt+N adds an empty workspace to
  // the selected row's world; Alt+Shift+N adds a new world (all-worlds view).
  // Moves are silent (you stay put) and the overview refreshes.
  property var held: null
  property string holdCandidate: ""
  property var virtualWs: ({})          // world -> [slot, ...]
  property var virtualWorlds: []
  property int keepSelectId: 0
  property string notice: ""
  property string lastRaw: ""
  readonly property int holdMs: 350

  Timer {
    id: holdTimer
    interval: root.holdMs
    onTriggered: {
      var w = root.hints[root.holdCandidate]
      if (w) { root.held = w; root.typed = ""; root.notice = "" }
      root.holdCandidate = ""
    }
  }

  function beginHold(seq) { root.holdCandidate = seq; holdTimer.restart() }
  function cancelHold() { holdTimer.stop(); root.holdCandidate = "" }

  function selectedWorld() {
    var row = rows[selRow]
    return row ? row.world : (worldOf(activeWorkspace) || 1)
  }

  function dropInto(wsId) {
    if (!root.held || !wsId) return
    if (root.held.workspace === wsId) { root.notice = "Already on that workspace"; return }
    moveProcess.command = ["hyprctl", "dispatch",
      "hl.dsp.window.move({ window = \"address:" + root.held.address + "\", workspace = \"" + wsId + "\", follow = false })"]
    root.keepSelectId = wsId
    root.held = null
    root.notice = ""
    moveProcess.running = true
  }

  function dropDigit(d) {
    var slot = d === 0 ? 10 : d
    var world = root.mode === "workspace" ? (worldOf(activeWorkspace) || 1) : selectedWorld()
    dropInto((world - 1) * size + slot)
  }

  Process { id: moveProcess; running: false; onExited: root.refresh() }

  // Re-read windows but keep the overview open (after a move).
  function refresh() {
    root.loadGeneration++
    snapshot.generation = root.loadGeneration
    snapshot.running = true
  }

  // Rebuild from the last snapshot (after adding an empty workspace/world).
  function rebuild() { if (root.lastRaw) root.applySnapshot(root.lastRaw, root.loadGeneration) }

  function newWorkspace() {
    if (root.mode === "workspace") { root.notice = "Alt+N works in the world views"; return }
    var row = rows[selRow]
    if (!row) return
    var used = row.workspaces.map(function(w) { return w.slot })
    for (var slot = 1; slot <= size; slot++) {
      if (used.indexOf(slot) < 0) {
        var next = {}
        for (var k in root.virtualWs) next[k] = root.virtualWs[k].slice()
        if (!next[row.world]) next[row.world] = []
        next[row.world].push(slot)
        root.virtualWs = next
        root.keepSelectId = (row.world - 1) * size + slot
        root.notice = ""
        root.rebuild()
        return
      }
    }
    root.notice = "World " + row.letter + " already has 10 workspaces"
  }

  function newWorld() {
    if (root.mode !== "all") { root.notice = "Alt+Shift+N works in the all-worlds view (Alt+Shift+Space)"; return }
    var used = rows.map(function(r) { return r.world })
    for (var w = 1; w <= maxWorlds; w++) {
      if (used.indexOf(w) < 0) {
        root.virtualWorlds = root.virtualWorlds.concat([w])
        root.keepSelectId = (w - 1) * size + 1
        root.notice = ""
        root.rebuild()
        return
      }
    }
    root.notice = "All 9 worlds are in use"
  }

  // ---- selection / paging --------------------------------------------------
  // At most visibleRows worlds and visibleCols workspaces per row are drawn.
  // Arrows move a selected workspace (wrapping); the view follows it. Hints
  // keep their letters while scrolling and work for off-screen windows too.
  property int visibleRows: 3            // "worldsVisible"
  property int visibleCols: 3            // "workspacesPerRow"
  property int selRow: 0
  property int selCol: 0
  property int rowOffset: 0
  property var colOffsets: ({})          // row index -> first visible workspace index

  function slotLabel(ws) { return ws ? (ws.slot === 10 ? "0" : String(ws.slot)) : "" }

  function colCount(r) { return rows[r] ? rows[r].workspaces.length : 0 }
  function colOffset(r) { return colOffsets[r] || 0 }

  function ensureVisible() {
    var vr = Math.min(visibleRows, rows.length)
    var ro = rowOffset
    if (selRow < ro) ro = selRow
    if (selRow >= ro + vr) ro = selRow - vr + 1
    rowOffset = Math.max(0, Math.min(ro, rows.length - vr))
    var n = colCount(selRow), vc = Math.min(visibleCols, n)
    var co = colOffset(selRow)
    if (selCol < co) co = selCol
    if (selCol >= co + vc) co = selCol - vc + 1
    co = Math.max(0, Math.min(co, n - vc))
    var next = {}
    for (var k in colOffsets) next[k] = colOffsets[k]
    next[selRow] = co
    colOffsets = next
  }

  function moveSel(dr, dc) {
    if (!rows.length) return
    if (dr !== 0) {
      selRow = (selRow + dr + rows.length) % rows.length
      selCol = Math.min(selCol, colCount(selRow) - 1)
    }
    if (dc !== 0) {
      var n = colCount(selRow)
      if (n > 0) selCol = (selCol + dc + n) % n
    }
    ensureVisible()
  }

  function visibleRowIndices() {
    var out = []
    var vr = Math.min(visibleRows, rows.length)
    for (var i = 0; i < vr; i++) out.push(rowOffset + i)
    return out
  }

  function visibleWorkspaces(r) {
    var co = colOffset(r)
    return rows[r] ? rows[r].workspaces.slice(co, co + visibleCols) : []
  }

  function selectedWorkspaceId() {
    var row = rows[selRow]
    return row && row.workspaces[selCol] ? row.workspaces[selCol].id : 0
  }

  // Enter: go to the selected workspace.
  function enterSelected() {
    var id = selectedWorkspaceId()
    if (!id) return
    jumpProcess.command = ["hyprctl", "dispatch", "hl.dsp.focus({ workspace = \"" + id + "\" })"]
    jumpProcess.running = true
    root.close()
  }

  // ---- keys ----------------------------------------------------------------
  // Returns the window a key sequence would select (no side effects).
  function resolve(seq) { return root.hints[seq] || null }

  function press(key) {
    if (!root.opened) return
    var next = root.typed + String(key)
    if (root.hints[next]) { root.jump(root.hints[next], true); return }
    for (var hint in root.hints) {
      if (hint.indexOf(next) === 0) { root.typed = next; return }
    }
    root.typed = ""       // no match: start over
  }

  // Jump to a window. For a typed hint, also arm the double-tap: a quick
  // repeat of the hint's last key toggles fullscreen on it (handled in
  // ~/.config/hypr/hyprwrlds.lua, so other keys pass straight to the app).
  function jump(win, viaKey) {
    var cmd = "hyprctl dispatch 'hl.dsp.focus({ window = \"address:" + win.address + "\" })' >/dev/null"
    if (viaKey && root.doubleTap) {
      var key = String(win.hint).slice(-1)
      cmd += "; hyprctl eval 'hyprwrlds.arm_double_tap(\"" + key + "\", \"" + root.doubleTapMode + "\", " + root.doubleTapMs + ")' >/dev/null"
    }
    jumpProcess.command = ["sh", "-c", cmd]
    jumpProcess.running = true
    root.close()
  }

  Process { id: jumpProcess; running: false }

  // ---- layout --------------------------------------------------------------
  // Tile size: fit the widest row and all rows on screen, capped for looks.
  readonly property int maxCols: {
    var m = 1
    for (var i = 0; i < rows.length; i++) m = Math.max(m, rows[i].workspaces.length)
    return Math.min(visibleCols, m)
  }
  readonly property real aspect: monitor ? monitor.width / Math.max(1, monitor.height) : 16 / 10

  Variants {
    model: Quickshell.screens

    PanelWindow {
      id: overlay
      required property var modelData
      screen: modelData
      visible: root.opened && root.monitor !== null && modelData.name === root.monitor.name

      anchors { top: true; bottom: true; left: true; right: true }
      color: "transparent"
      exclusionMode: ExclusionMode.Ignore
      WlrLayershell.namespace: "hyprwrlds-vimarchy"
      WlrLayershell.layer: WlrLayer.Overlay
      WlrLayershell.keyboardFocus: visible ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None

      readonly property real margin: root.edgeMargin
      readonly property real gap: 18
      readonly property real labelW: root.mode === "all" ? 44 : 0
      readonly property real arrowW: 40
      readonly property real headerH: 22
      readonly property real tileW: {
        var byWidth = (width - margin * 2 - labelW - arrowW * 2 - gap * (root.maxCols + 1)) / root.maxCols
        var rowsN = Math.max(1, Math.min(root.visibleRows, root.rows.length))
        var byHeight = ((height - margin * 2 - 60 - gap * (rowsN - 1)) / rowsN - headerH) * root.aspect
        var cap = root.mode === "workspace" ? 100000 : root.maxTileWidth
        return Math.max(120, Math.min(cap, byWidth, byHeight))
      }
      readonly property real tileH: tileW / root.aspect
      readonly property real sx: tileW / (root.monitor ? root.monitor.width : 1)

      // Backdrop: dims the desktop; a click anywhere closes.
      Rectangle {
        anchors.fill: parent
        color: Qt.rgba(root.bg.r, root.bg.g, root.bg.b, root.backdropOpacity)
        MouseArea { anchors.fill: parent; onClicked: root.close() }
      }

      FocusScope {
        anchors.fill: parent
        focus: true
        Keys.onPressed: function(event) {
          var alt = (event.modifiers & Qt.AltModifier) !== 0
          var shift = (event.modifiers & Qt.ShiftModifier) !== 0
          if (event.key === Qt.Key_Escape) {
            // Esc cancels a pick-up first; a second Esc closes.
            if (root.held || root.holdCandidate !== "") { root.held = null; root.cancelHold(); root.notice = "" }
            else root.close()
            event.accepted = true; return
          }
          if (event.modifiers & Qt.ControlModifier) {
            if (event.key === Qt.Key_Equal || event.key === Qt.Key_Plus) { root.adjustHintScale(1); event.accepted = true; return }
            if (event.key === Qt.Key_Minus || event.key === Qt.Key_Underscore) { root.adjustHintScale(-1); event.accepted = true; return }
            return
          }
          if (event.key === Qt.Key_Left)  { root.moveSel(0, -1); event.accepted = true; return }
          if (event.key === Qt.Key_Right) { root.moveSel(0, 1);  event.accepted = true; return }
          if (event.key === Qt.Key_Up)    { root.moveSel(-1, 0); event.accepted = true; return }
          if (event.key === Qt.Key_Down)  { root.moveSel(1, 0);  event.accepted = true; return }
          if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            if (root.held) root.dropInto(root.selectedWorkspaceId()); else root.enterSelected()
            event.accepted = true; return
          }
          if (alt && event.key === Qt.Key_N) {
            if (!event.isAutoRepeat) { if (shift) root.newWorld(); else root.newWorkspace() }
            event.accepted = true; return
          }
          if (event.key >= Qt.Key_0 && event.key <= Qt.Key_9 && !alt) {
            if (root.held) root.dropDigit(event.key - Qt.Key_0)
            event.accepted = true; return
          }
          if (event.key === Qt.Key_Backspace) {
            if (root.typed === "") root.close(); else root.typed = ""
            event.accepted = true; return
          }
          // Letters by key code (works with Alt held). Case comes from Shift,
          // not the produced text, so Caps Lock can't flip a hint.
          if (event.key >= Qt.Key_A && event.key <= Qt.Key_Z) {
            var ch = String.fromCharCode(event.key).toLowerCase()
            if (root.hintKeys.indexOf(ch) < 0) return
            event.accepted = true
            if (event.isAutoRepeat) return
            var k = shift ? ch.toUpperCase() : ch
            if (alt) {
              // Alt+hold: pick the window up once held for holdMs.
              var seq = root.typed + k
              if (root.hints[seq]) { root.typed = ""; root.beginHold(seq); return }
              for (var h in root.hints) if (h.indexOf(seq) === 0) { root.typed = seq; return }
              root.typed = ""
              return
            }
            if (root.held) { root.notice = "Moving — pick a workspace (Esc cancels)"; return }
            root.press(k)
          }
        }

        Keys.onReleased: function(event) {
          if (event.isAutoRepeat) return
          // Letting go of the letter before holdMs cancels the pick-up.
          if (root.holdCandidate !== "" && event.key >= Qt.Key_A && event.key <= Qt.Key_Z) {
            var ch = String.fromCharCode(event.key).toLowerCase()
            if (root.holdCandidate.slice(-1).toLowerCase() === ch) root.cancelHold()
          }
        }

        // Move banner / notices, top-left.
        Rectangle {
          x: overlay.margin
          y: 14
          z: 20
          visible: root.held !== null || root.notice !== ""
          width: bannerText.implicitWidth + 24
          height: bannerText.implicitHeight + 12
          radius: 8
          color: root.held ? root.held.color : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.12)
          Text {
            id: bannerText
            anchors.centerIn: parent
            text: root.held
              ? "Moving  " + root.held.hint + " · " + root.held.cls + "   →   arrows + Enter,  1–9 / 0,  or click a workspace   ·   Alt+N new workspace   ·   Esc cancels"
              : root.notice
            color: root.held ? root.bg : root.fg
            font.family: root.fontFamily
            font.pixelSize: 14
            font.bold: root.held !== null
          }
        }

        // Left-justified with a margin (not centred), vertically centred.
        Column {
          anchors.left: root.align === "left" ? parent.left : undefined
          anchors.leftMargin: overlay.margin
          anchors.horizontalCenter: root.align === "center" ? parent.horizontalCenter : undefined
          anchors.verticalCenter: parent.verticalCenter
          spacing: overlay.gap

          // ▲ worlds above the visible ones
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: root.mode === "all" && root.rows.length > root.visibleRows
            opacity: 0.8
            text: visible ? "▲ " + root.rows[(root.rowOffset - 1 + root.rows.length) % root.rows.length].letter : ""
            color: root.fg
            font.family: root.fontFamily
            font.pixelSize: 14
          }

          Repeater {
            model: root.visibleRowIndices()

            Row {
              id: worldRow
              required property int modelData
              readonly property int rowIndex: modelData
              readonly property var rowData: root.rows[rowIndex] || ({ world: 1, letter: "", workspaces: [] })
              readonly property color hue: root.worldColor(rowData.world)
              // Workspace just outside the view on each side (wrapping), shown
              // only when the row has more workspaces than fit.
              readonly property int wsCount: rowData.workspaces.length
              readonly property bool overflows: wsCount > root.visibleCols
              readonly property string leftLabel: overflows
                ? root.slotLabel(rowData.workspaces[(root.colOffset(rowIndex) - 1 + wsCount) % wsCount]) : ""
              readonly property string rightLabel: overflows
                ? root.slotLabel(rowData.workspaces[(root.colOffset(rowIndex) + root.visibleCols) % wsCount]) : ""
              spacing: overlay.gap

              // World letter (all-worlds mode only)
              Item {
                visible: root.mode === "all"
                width: overlay.labelW - overlay.gap > 0 ? overlay.labelW - overlay.gap : 0
                height: overlay.tileH + overlay.headerH
                Text {
                  anchors.centerIn: parent
                  anchors.verticalCenterOffset: overlay.headerH / 2
                  text: worldRow.rowData.letter
                  color: worldRow.hue
                  font.family: root.fontFamily
                  font.pixelSize: 26
                  font.bold: true
                }
              }

              // ‹ n workspaces to the left
              Text {
                width: overlay.arrowW
                height: overlay.tileH + overlay.headerH
                verticalAlignment: Text.AlignVCenter
                horizontalAlignment: Text.AlignRight
                topPadding: overlay.headerH
                text: worldRow.leftLabel !== "" ? "‹ " + worldRow.leftLabel : ""
                color: worldRow.hue
                font.family: root.fontFamily
                font.pixelSize: 16
                font.bold: true
              }

              Repeater {
                model: root.visibleWorkspaces(worldRow.rowIndex)

                Column {
                  id: wsCol
                  required property var modelData
                  readonly property bool isActive: modelData.id === root.activeWorkspace
                  readonly property bool isSelected: worldRow.rowIndex === root.selRow && modelData.id === root.selectedWorkspaceId()
                  spacing: 4

                  Text {
                    height: overlay.headerH - 4
                    text: (wsCol.isSelected ? "▸ " : "") + (root.mode !== "world" ? worldRow.rowData.letter + " · " : "") +
                          (wsCol.modelData.slot === 10 ? "0" : String(wsCol.modelData.slot)) +
                          (wsCol.modelData.virtual ? "  (new)" : "")
                    color: worldRow.hue
                    font.family: root.fontFamily
                    font.pixelSize: 14
                    font.bold: wsCol.isActive || wsCol.isSelected
                  }

                  // Mini-screen for this workspace
                  Rectangle {
                    width: overlay.tileW
                    height: overlay.tileH
                    radius: 8
                    color: Qt.rgba(root.bg.r, root.bg.g, root.bg.b, 0.95)
                    border.width: wsCol.isSelected ? 4 : (wsCol.isActive ? 3 : 1.5)
                    border.color: wsCol.isSelected ? root.fg
                                : (wsCol.isActive ? worldRow.hue : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.35))
                    clip: true

                    // While a window is held, clicking a tile drops it here.
                    MouseArea {
                      anchors.fill: parent
                      enabled: root.held !== null
                      cursorShape: root.held ? Qt.PointingHandCursor : Qt.ArrowCursor
                      onClicked: root.dropInto(wsCol.modelData.id)
                    }

                    Text {
                      anchors.centerIn: parent
                      visible: wsCol.modelData.windows.length === 0
                      text: root.held ? "drop here" : "empty"
                      color: root.fg
                      opacity: 0.45
                      font.family: root.fontFamily
                      font.pixelSize: 16
                    }

                    Repeater {
                      model: wsCol.modelData.windows

                      Rectangle {
                        id: winBox
                        required property var modelData
                        readonly property bool isActive: modelData.address === root.activeAddress
                        readonly property bool matches: root.typed === "" || modelData.hint.indexOf(root.typed) === 0
                        x: Math.max(0, modelData.x * overlay.sx)
                        y: Math.max(0, modelData.y * overlay.sx)
                        width: Math.max(18, modelData.w * overlay.sx)
                        height: Math.max(14, modelData.h * overlay.sx)
                        radius: 4
                        readonly property color accent: modelData.color
                        readonly property var toplevel: root.showPreviews ? root.toplevelFor(modelData.address) : null
                        // Plain background while there is no preview.
                        color: preview.hasContent ? "transparent" : Qt.rgba(root.bg.r, root.bg.g, root.bg.b, 1)

                        // Captured app contents (one still frame per open), clipped
                        // to the box; the hint circle is NOT clipped.
                        Item {
                          anchors.fill: parent
                          clip: true
                          ScreencopyView {
                            id: preview
                            anchors.fill: parent
                            captureSource: winBox.toplevel
                            live: false
                            constraintSize: Qt.size(Math.max(1, winBox.width), Math.max(1, winBox.height))
                            visible: winBox.toplevel !== null && hasContent
                          }
                        }

                        // Vimarchy tint + outline over the preview.
                        Rectangle {
                          anchors.fill: parent
                          radius: parent.radius
                          color: Qt.rgba(winBox.accent.r, winBox.accent.g, winBox.accent.b,
                                         winBox.isActive ? 0.20 : root.windowTintOpacity)
                          border.width: 2
                          border.color: winBox.accent
                        }
                        opacity: matches ? 1 : 0.25
                        z: modelData.fullscreen ? 0 : (modelData.floating ? 2 : 1)

                        Rectangle {
                          anchors { left: parent.left; bottom: parent.bottom; margins: 3 }
                          visible: parent.height > 34
                          width: Math.min(parent.width - 6, appLabel.implicitWidth + 8)
                          height: appLabel.implicitHeight + 2
                          radius: 3
                          color: Qt.rgba(root.bg.r, root.bg.g, root.bg.b, 0.85)
                          z: 4
                          Text {
                            id: appLabel
                            anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; leftMargin: 4; rightMargin: 4 }
                            text: winBox.modelData.cls
                            elide: Text.ElideRight
                            color: root.fg
                            font.family: root.fontFamily
                            font.pixelSize: 10
                          }
                        }

                        // The window being moved: heavy dark outline.
                        Rectangle {
                          anchors.fill: parent
                          anchors.margins: -2
                          radius: parent.radius + 2
                          color: "transparent"
                          border.width: 4
                          border.color: root.fg
                          visible: root.held !== null && root.held.address === winBox.modelData.address
                          z: 6
                        }

                        MouseArea {
                          anchors.fill: parent
                          onClicked: root.held ? root.dropInto(wsCol.modelData.id) : root.jump(winBox.modelData)
                        }
                      }
                    }

                    // Hint circles in their own layer above EVERY window box (like
                    // Vimarchy's overlay), so sub-windows never cover a letter.
                    Repeater {
                      model: wsCol.modelData.windows

                      Item {
                        id: hintItem
                        required property var modelData
                        readonly property color accent: modelData.color
                        readonly property bool matches: root.typed === "" || modelData.hint.indexOf(root.typed) === 0
                        x: Math.max(0, modelData.x * overlay.sx)
                        y: Math.max(0, modelData.y * overlay.sx)
                        width: Math.max(18, modelData.w * overlay.sx)
                        height: Math.max(14, modelData.h * overlay.sx)
                        z: 10
                        opacity: matches ? 1 : 0.25

                        // Hint badge, Vimarchy style: translucent circle in the
                        // window's colour, letter in full colour. Size follows the
                        // box and Ctrl+= / Ctrl+-. Shift hints (A-Z) get a solid ring.
                        Rectangle {
                          id: badge
                          readonly property bool shifted: root.isShiftHint(hintItem.modelData.hint)
                          readonly property real d: root.vimarchyBadge(hintItem.modelData.w, hintItem.modelData.h) * overlay.sx
                          anchors.centerIn: parent
                          width: d
                          height: d
                          radius: d / 2
                          z: 5
                          // Same as Vimarchy: only a translucent tint of the window's
                          // colour. Optional cream backing ("badgeBacking") for
                          // legibility over busy previews.
                          color: root.badgeBacking ? Qt.rgba(root.bg.r, root.bg.g, root.bg.b, 0.88) : "transparent"
                          Rectangle {
                            anchors.fill: parent
                            radius: parent.radius
                            color: Qt.rgba(hintItem.accent.r, hintItem.accent.g, hintItem.accent.b, root.badgeTintOpacity)
                          }
                          border.width: (shifted && root.shiftRing) ? Math.max(1.5, d * 0.08) : 0
                          border.color: hintItem.accent
                          Text {
                            anchors.centerIn: parent
                            text: hintItem.modelData.hint
                            color: hintItem.accent
                            font.family: root.fontFamily
                            font.pixelSize: Math.max(9, Math.round(badge.d * (text.length > 1 ? 0.46 : 0.62)))
                            font.bold: true
                          }
                        }

                      }
                    }
                  }
                }
              }

              // n workspaces to the right ›
              Text {
                width: overlay.arrowW
                height: overlay.tileH + overlay.headerH
                verticalAlignment: Text.AlignVCenter
                horizontalAlignment: Text.AlignLeft
                topPadding: overlay.headerH
                text: worldRow.rightLabel !== "" ? worldRow.rightLabel + " ›" : ""
                color: worldRow.hue
                font.family: root.fontFamily
                font.pixelSize: 16
                font.bold: true
              }
            }
          }

          // ▼ worlds below the visible ones
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: root.mode === "all" && root.rows.length > root.visibleRows
            opacity: 0.8
            text: visible ? "▼ " + root.rows[(root.rowOffset + root.visibleRows) % root.rows.length].letter : ""
            color: root.fg
            font.family: root.fontFamily
            font.pixelSize: 14
          }
        }
      }
    }
  }
}
