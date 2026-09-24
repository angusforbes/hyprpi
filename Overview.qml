import Quickshell
import Quickshell.Io
import Quickshell.Wayland
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

  readonly property int size: 10
  readonly property string letters: "ABCDEFGHI"
  readonly property string hintKeys: "asdfghjklqwertyuiopzxcvbnm"
  property string fontFamily: "JetBrainsMono Nerd Font"

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
    root.mode = payload.mode === "all" ? "all" : "world"
    root.hintStart = Math.max(0, Number(payload.hintStart) || 0)
    root.typed = ""
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

  function worldOf(id) { return id >= 1 ? Math.floor((id - 1) / size) + 1 : 0 }

  // Hints: windows 1-26 get a-z (home row first), 27-52 get A-Z (Shift +
  // the same key). Beyond 52 every window gets a two-letter lowercase hint.
  function hintFor(index, total) {
    var n = hintKeys.length
    if (total <= n * 2) {
      return index < n ? hintKeys.charAt(index) : hintKeys.charAt(index - n).toUpperCase()
    }
    return hintKeys.charAt(Math.floor(index / n) % n) + hintKeys.charAt(index % n)
  }

  function isShiftHint(hint) { return hint !== hint.toLowerCase() }

  function applySnapshot(raw, generation) {
    if (generation !== root.loadGeneration) return
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
      if (root.mode === "world" && w !== currentWorld) continue
      if (!byWorld[w]) byWorld[w] = {}
      if (!byWorld[w][wsId]) byWorld[w][wsId] = []
      byWorld[w][wsId].push({
        address: cl.address, cls: cl["class"] || "", title: cl.title || "",
        x: cl.at[0] - mon.x, y: cl.at[1] - mon.y, w: cl.size[0], h: cl.size[1],
        floating: cl.floating === true, workspace: wsId
      })
    }

    // Rows in world order, workspaces in id order, windows left-to-right then
    // top-to-bottom; hints follow that reading order.
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
        for (var k = 0; k < wins.length; k++) ordered.push(wins[k])
        wsList.push({ id: wsIds[si], slot: wsIds[si] - (world - 1) * size, windows: wins })
      }
      out.push({ world: world, letter: letters.charAt(world - 1), workspaces: wsList })
    }

    var map = {}
    for (var h = 0; h < ordered.length; h++) {
      ordered[h].hint = hintFor(h + root.hintStart, ordered.length + root.hintStart)
      map[ordered[h].hint] = ordered[h]
    }

    if (ordered.length === 0) { root.close(); return }
    root.hints = map
    root.rows = out
    root.opened = true
  }

  // ---- keys ----------------------------------------------------------------
  // Returns the window a key sequence would select (no side effects).
  function resolve(seq) { return root.hints[seq] || null }

  function press(key) {
    if (!root.opened) return
    var next = root.typed + String(key)
    if (root.hints[next]) { root.jump(root.hints[next]); return }
    for (var hint in root.hints) {
      if (hint.indexOf(next) === 0) { root.typed = next; return }
    }
    root.typed = ""       // no match: start over
  }

  function jump(win) {
    jumpProcess.command = ["hyprctl", "dispatch",
      "hl.dsp.focus({ window = \"address:" + win.address + "\" })"]
    jumpProcess.running = true
    root.close()
  }

  Process { id: jumpProcess; running: false }

  // ---- layout --------------------------------------------------------------
  // Tile size: fit the widest row and all rows on screen, capped for looks.
  readonly property int maxCols: {
    var m = 1
    for (var i = 0; i < rows.length; i++) m = Math.max(m, rows[i].workspaces.length)
    return m
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

      readonly property real margin: 48
      readonly property real gap: 18
      readonly property real labelW: root.mode === "all" ? 44 : 0
      readonly property real headerH: 22
      readonly property real tileW: {
        var byWidth = (width - margin * 2 - labelW - gap * (root.maxCols - 1)) / root.maxCols
        var rowsN = Math.max(1, root.rows.length)
        var byHeight = ((height - margin * 2 - gap * (rowsN - 1)) / rowsN - headerH) * root.aspect
        return Math.max(120, Math.min(360, byWidth, byHeight))
      }
      readonly property real tileH: tileW / root.aspect
      readonly property real sx: tileW / (root.monitor ? root.monitor.width : 1)

      // Backdrop: dims the desktop; a click anywhere closes.
      Rectangle {
        anchors.fill: parent
        color: Qt.rgba(root.bg.r, root.bg.g, root.bg.b, 0.94)
        MouseArea { anchors.fill: parent; onClicked: root.close() }
      }

      FocusScope {
        anchors.fill: parent
        focus: true
        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Escape) { root.close(); event.accepted = true; return }
          if (event.key === Qt.Key_Backspace) {
            if (root.typed === "") root.close(); else root.typed = ""
            event.accepted = true; return
          }
          // Case comes from Shift, not from the produced text, so Caps Lock
          // can't flip a hint.
          var t = String(event.text || "").toLowerCase()
          if (t.length === 1 && root.hintKeys.indexOf(t) >= 0) {
            root.press((event.modifiers & Qt.ShiftModifier) ? t.toUpperCase() : t)
            event.accepted = true
          }
        }

        Column {
          anchors.centerIn: parent
          spacing: overlay.gap

          Repeater {
            model: root.rows

            Row {
              id: worldRow
              required property var modelData
              readonly property color hue: root.worldColor(modelData.world)
              spacing: overlay.gap

              // World letter (all-worlds mode only)
              Item {
                visible: root.mode === "all"
                width: overlay.labelW - overlay.gap > 0 ? overlay.labelW - overlay.gap : 0
                height: overlay.tileH + overlay.headerH
                Text {
                  anchors.centerIn: parent
                  anchors.verticalCenterOffset: overlay.headerH / 2
                  text: worldRow.modelData.letter
                  color: worldRow.hue
                  font.family: root.fontFamily
                  font.pixelSize: 26
                  font.bold: true
                }
              }

              Repeater {
                model: worldRow.modelData.workspaces

                Column {
                  id: wsCol
                  required property var modelData
                  readonly property bool isActive: modelData.id === root.activeWorkspace
                  spacing: 4

                  Text {
                    height: overlay.headerH - 4
                    text: (root.mode === "all" ? worldRow.modelData.letter + " · " : "") +
                          (wsCol.modelData.slot === 10 ? "0" : String(wsCol.modelData.slot))
                    color: worldRow.hue
                    font.family: root.fontFamily
                    font.pixelSize: 14
                    font.bold: wsCol.isActive
                  }

                  // Mini-screen for this workspace
                  Rectangle {
                    width: overlay.tileW
                    height: overlay.tileH
                    radius: 8
                    color: Qt.rgba(root.bg.r, root.bg.g, root.bg.b, 0.95)
                    border.width: wsCol.isActive ? 3 : 1.5
                    border.color: wsCol.isActive ? worldRow.hue : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.35)
                    clip: true

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
                        color: Qt.rgba(worldRow.hue.r, worldRow.hue.g, worldRow.hue.b, isActive ? 0.22 : 0.08)
                        border.width: isActive ? 2 : 1.25
                        border.color: Qt.rgba(worldRow.hue.r, worldRow.hue.g, worldRow.hue.b, 0.9)
                        opacity: matches ? 1 : 0.25
                        z: modelData.floating ? 2 : 1

                        Text {
                          anchors { left: parent.left; right: parent.right; bottom: parent.bottom; margins: 4 }
                          visible: parent.height > 34
                          text: winBox.modelData.cls
                          elide: Text.ElideRight
                          color: root.fg
                          opacity: 0.7
                          font.family: root.fontFamily
                          font.pixelSize: 10
                        }

                        // Hint badge: filled for a-z, outlined for Shift hints (A-Z).
                        Rectangle {
                          readonly property bool shifted: root.isShiftHint(winBox.modelData.hint)
                          // Shrinks to fit small boxes so crowded workspaces stay legible.
                          readonly property real d: Math.max(15, Math.min(26, winBox.width - 4, winBox.height - 4))
                          anchors.centerIn: parent
                          width: Math.max(d, hintText.implicitWidth + d * 0.45)
                          height: d
                          radius: d / 2
                          color: shifted ? root.bg : worldRow.hue
                          border.width: shifted ? 2 : 0
                          border.color: worldRow.hue
                          Text {
                            id: hintText
                            anchors.centerIn: parent
                            anchors.verticalCenterOffset: -1
                            text: winBox.modelData.hint
                            color: parent.shifted ? worldRow.hue : root.bg
                            font.family: root.fontFamily
                            font.pixelSize: Math.max(10, Math.round(parent.d * 0.58))
                            font.bold: true
                          }
                        }

                        MouseArea {
                          anchors.fill: parent
                          onClicked: root.jump(winBox.modelData)
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
