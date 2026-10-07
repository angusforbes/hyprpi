import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Ui

// hyprwrlds bar widget: world letters (A B C ...) then the numbered
// workspaces of the current world. World w holds workspaces (w-1)*10+1 .. w*10.
// Keybindings and per-world memory live in ~/.config/hypr/hyprwrlds.lua.
//
// Colours: every world gets a hue from the current Omarchy theme's
// colors.toml (read live, so theme switches recolour it). The current world is
// shown as the same solid block glyph as the focused workspace (the letter is
// hidden, like the focused number); the workspace numbers take the current
// world's colour.
BarWidget {
  id: root
  moduleName: "agf.hyprwrlds"

  readonly property int size: 10
  readonly property int maxWorlds: 9
  readonly property string letters: "ABCDEFGHI"
  readonly property int minWorlds: Math.max(1, Math.min(maxWorlds, Number(setting("worlds", 3)) || 3))
  // Width of each world letter / workspace number cell, in Style.space units (setting "cellWidth",
  // default 15; ~/.config/omarchy/shell.json, this widget's entry in bar.layout).
  readonly property int cellWidth: Math.max(8, Math.min(40, Number(setting("cellWidth", 15)) || 15))
  readonly property string focusGlyph: "\uDB85\uDCFB"

  // ---- theme palette ------------------------------------------------------
  // World order: A blue, B red, C cyan, D yellow, E magenta, F green,
  // G orange, H brown, I foreground. Falls back to colorN keys, then accent.
  // (B is red rather than magenta: a clearer second colour.)
  readonly property var paletteKeys: [
    ["blue", "color4"], ["red", "color1"], ["cyan", "color6"],
    ["yellow", "color3"], ["magenta", "color5"], ["green", "color2"],
    ["orange", "color11"], ["brown", "color9"], ["foreground", "color7"]
  ]
  property var themeColors: ({})

  function parseColors(raw) {
    var out = {}
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
      if (m) out[m[1]] = m[2]
    }
    themeColors = out
  }

  function worldColor(w) {
    var keys = paletteKeys[(w - 1) % paletteKeys.length]
    for (var i = 0; i < keys.length; i++) {
      if (themeColors[keys[i]]) return themeColors[keys[i]]
    }
    return Color.accent
  }

  FileView {
    id: colorsFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: root.parseColors(text())
  }

  // `omarchy theme set` swaps the whole theme directory and then pushes the
  // palette to the shell over IPC (applyTheme), which may not trip the file
  // watch above. Re-read colors.toml whenever the shell's palette changes, so
  // the worlds recolour together with the rest of the bar.
  Connections {
    target: Color
    function onForegroundChanged() { colorsFile.reload() }
    function onBackgroundChanged() { colorsFile.reload() }
    function onAccentChanged() { colorsFile.reload() }
    function onUrgentChanged() { colorsFile.reload() }
    function onMutedChanged() { colorsFile.reload() }
  }

  // ---- world / workspace state -------------------------------------------
  // Remember the world while a special workspace (scratchpad etc.) is focused.
  property int lastWorld: 1

  function worldOf(id) {
    return id >= 1 ? Math.floor((id - 1) / size) + 1 : 0
  }

  readonly property int focusedId: Hyprland.focusedWorkspace ? Hyprland.focusedWorkspace.id : 0
  onFocusedIdChanged: { var w = worldOf(focusedId); if (w > 0) lastWorld = w }
  readonly property int currentWorld: worldOf(focusedId) > 0 ? worldOf(focusedId) : lastWorld
  readonly property color currentColor: worldColor(currentWorld)

  function workspaceById(id) {
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      if (values[i].id === id) return values[i]
    }
    return null
  }

  function occupied(ws) {
    return ws !== null && ws.toplevels.values.length > 0
  }

  function worldOccupied(w) {
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      if (worldOf(values[i].id) === w && occupied(values[i])) return true
    }
    return false
  }

  function worldIds() {
    var n = Math.max(minWorlds, currentWorld)
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      var w = worldOf(values[i].id)
      if (w > n && w <= maxWorlds) n = w
    }
    var ids = []
    for (var k = 1; k <= n; k++) ids.push(k)
    return ids
  }

  // Slots 1-5 always, plus any existing workspace of the current world.
  function slotIds() {
    var base = (currentWorld - 1) * size
    var ids = [1, 2, 3, 4, 5]
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      var slot = values[i].id - base
      if (slot >= 1 && slot <= size && ids.indexOf(slot) === -1) ids.push(slot)
    }
    ids.sort(function(a, b) { return a - b })
    return ids
  }

  function run(cmd) { if (root.bar) root.bar.run(cmd) }
  function selectWorld(w) { run("hyprctl eval " + Util.shellQuote("hyprwrlds.world(" + w + ")")) }
  function toggleRoom() { run(Quickshell.env("HOME") + "/Work/hyprpi/bin/hyprpi room --toggle") }
  function cycleWorld(delta) { run("hyprctl eval " + Util.shellQuote("hyprwrlds.cycle_world(" + delta + ")")) }
  function focusWorkspace(id) {
    run("hyprctl dispatch " + Util.shellQuote("hl.dsp.focus({ workspace = \"" + id + "\" })"))
  }

  readonly property real trailingGap: root.vertical ? 0 : Style.spaceReal(1.5)
  readonly property real groupGap: root.vertical ? Style.space(4) : Style.space(6)

  implicitWidth: layout.implicitWidth + trailingGap
  implicitHeight: layout.implicitHeight

  GridLayout {
    id: layout
    anchors.fill: parent
    anchors.rightMargin: root.trailingGap
    columns: root.vertical ? 1 : 2
    columnSpacing: root.groupGap
    rowSpacing: root.groupGap

    // World picker
    GridLayout {
      columns: root.vertical ? 1 : root.worldIds().length
      columnSpacing: root.vertical ? 0 : Style.space(1)
      rowSpacing: root.vertical ? Style.space(2) : 0

      Repeater {
        model: root.worldIds()

        WidgetButton {
          id: worldButton
          required property int modelData
          readonly property bool current: modelData === root.currentWorld
          readonly property color hue: root.worldColor(modelData)

          bar: root.bar
          readonly property string letter: root.letters.charAt(modelData - 1)
          // Current world: the same solid block as the focused workspace.
          text: current ? root.focusGlyph : letter
          foreground: hue
          opacity: current || root.worldOccupied(modelData) ? 1 : 0.5
          horizontalMargin: 6
          verticalPadding: 6
          fixedWidth: root.vertical ? root.barSize : Style.space(root.cellWidth)
          fixedHeight: root.barSize
          // Clicking the world you're already in toggles its hyprpi room widget
          // (~/Work/hyprpi); clicking another world just switches to it.
          onPressed: function() { current ? root.toggleRoom() : root.selectWorld(modelData) }
          onWheelMoved: function(delta) { root.cycleWorld(delta < 0 ? 1 : -1) }
        }
      }
    }

    // Workspaces of the current world, tinted with the world's colour.
    GridLayout {
      columns: root.vertical ? 1 : root.slotIds().length
      columnSpacing: root.vertical ? 0 : Style.space(1)
      rowSpacing: root.vertical ? Style.space(2) : 0

      Repeater {
        model: root.slotIds()

        WidgetButton {
          required property int modelData
          readonly property int wsId: (root.currentWorld - 1) * root.size + modelData
          readonly property var workspace: root.workspaceById(wsId)
          readonly property bool focused: root.focusedId === wsId

          bar: root.bar
          text: focused ? root.focusGlyph : (modelData === 10 ? "0" : String(modelData))
          foreground: root.currentColor
          opacity: root.occupied(workspace) || focused ? 1 : 0.5
          horizontalMargin: 6
          verticalPadding: 6
          fixedWidth: root.vertical ? root.barSize : Style.space(root.cellWidth)
          fixedHeight: root.barSize
          onPressed: function() { root.focusWorkspace(wsId) }
        }
      }
    }
  }
}
