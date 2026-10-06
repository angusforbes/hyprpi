import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// hyprpi alert (J136): hyprpi's daemon writes ~/.local/state/hyprpi/alert.json; while it says a model login
// has lapsed this shows a pulsing red pill "󰌾 Claude login expired" (an amber one when a login is only about to
// end). Hidden otherwise.
// Hover: what happened and the fix. Click: notify the fix again.
BarWidget {
  id: root
  moduleName: "agf.hyprpi-login"

  property var alert: ({ active: false, warn: false, items: [] })
  readonly property bool shown: !!(alert && (alert.active || alert.warn))
  readonly property string tip: (alert && alert.items ? alert.items : []).map(function(i) { return i.text }).join("\n")

  visible: shown
  implicitWidth: shown ? (vertical ? barSize : layout.implicitWidth) : 0
  implicitHeight: shown ? (vertical ? layout.implicitHeight : barSize) : 0

  function parse(t) {
    try { var v = JSON.parse(String(t || "{}")); root.alert = v && typeof v === "object" ? v : { active: false } } catch (e) { }
  }

  FileView {
    id: file
    path: Quickshell.env("HOME") + "/.local/state/hyprpi/alert.json"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: root.parse(text())
    onLoadFailed: root.alert = ({ active: false, warn: false, items: [] })
  }
  // The daemon replaces the file atomically (rename), which a watch can miss: re-read every few seconds too.
  Timer { interval: 5000; repeat: true; running: true; onTriggered: file.reload() }

  // Angus (via Knock): "too subtle". Lapsed = a filled red pill, white bold text, a gentle pulse; warning = an
  // amber pill. Colours from the theme's colors.toml (red/color1, yellow/color3), as agent-activity picks them.
  property var themeKeys: ({})
  function tk(names, fallback) { for (var i = 0; i < names.length; i++) if (themeKeys[names[i]]) return themeKeys[names[i]]; return String(fallback) }
  readonly property string firstTitle: alert && alert.items && alert.items.length ? String(alert.items[0].title || "") : ""
  readonly property bool lapsed: !!(alert && alert.active)
  readonly property color pillColor: lapsed ? tk(["red", "color1"], "#d03030") : tk(["yellow", "color3"], "#e0a020")
  FileView {
    id: themeFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: {
      var out = {}, lines = String(text()).split("\n")
      for (var i = 0; i < lines.length; i++) { var m = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/); if (m) out[m[1]] = m[2] }
      root.themeKeys = out
    }
  }
  Connections { target: Color; function onAccentChanged() { themeFile.reload() } function onBackgroundChanged() { themeFile.reload() } }

  Item {
    id: layout
    anchors.centerIn: parent
    implicitWidth: pill.width + 8
    implicitHeight: pill.height

    Rectangle {
      id: pill
      anchors.centerIn: parent
      width: label.implicitWidth + 16
      height: label.implicitHeight + 6
      radius: height / 2
      color: root.pillColor
      SequentialAnimation on opacity {
        running: root.lapsed && root.shown
        loops: Animation.Infinite
        alwaysRunToEnd: true
        NumberAnimation { from: 1; to: 0.55; duration: 900; easing.type: Easing.InOutSine }
        NumberAnimation { from: 0.55; to: 1; duration: 900; easing.type: Easing.InOutSine }
      }
      Text {
        id: label
        anchors.centerIn: parent
        text: "󰌾 " + (root.firstTitle || (root.lapsed ? "login expired" : "login ends soon"))
        color: root.lapsed ? "#ffffff" : "#1a1a1a"
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.body
        font.bold: true
      }
    }
    MouseArea {
      anchors.fill: pill
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: if (root.bar) root.bar.showTooltip(pill, root.tip)
      onExited: if (root.bar) root.bar.hideTooltip(pill)
      onClicked: Quickshell.execDetached(["notify-send", "-u", "critical", "-a", "hyprpi login", "hyprpi: model login", root.tip])
    }
  }
}
