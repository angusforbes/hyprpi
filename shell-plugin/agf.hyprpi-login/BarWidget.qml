import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// hyprpi alert (J136): hyprpi's daemon writes ~/.local/state/hyprpi/alert.json; while it says a model login
// has lapsed this shows a red key + "login" (yellow when one is only about to end). Hidden otherwise.
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

  Flow {
    id: layout
    anchors.centerIn: parent
    flow: root.vertical ? Flow.TopToBottom : Flow.LeftToRight
    spacing: 0

    WidgetButton {
      bar: root.bar
      text: "󰌾 login"
      fontSize: Style.font.caption
      horizontalMargin: 3.5
      active: true
      activeColor: root.alert && root.alert.active ? Color.urgent : Color.accent
      useActiveColor: true
      tooltipText: root.tip
      onPressed: function(button) {
        Quickshell.execDetached(["notify-send", "-u", "critical", "-a", "hyprpi login", "hyprpi: model login", root.tip])
      }
    }
  }
}
