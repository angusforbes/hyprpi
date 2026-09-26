// Search window: search the conversations of every agent in a room (plus the
// room log). Nothing runs until Enter. Keyword = exact phrase. AI = describe
// what you mean; a small model picks matching entries and says why.
// Ctrl+/ switches mode, ↑↓ move, Esc closes. (Choosing a result: later.)
import Quickshell
import QtQuick
import QtQuick.Controls

FloatingWindow {
  id: win
  property var app
  title: "hyprpi search"
  visible: app.searchOpen
  implicitWidth: 640
  implicitHeight: 720
  color: app.bg

  property string mode: "keyword"
  property var results: []
  property string status: ""
  property bool busy: false
  property int generation: 0
  property int selected: -1
  readonly property string room: app.searchRoom

  onVisibleChanged: {
    if (!visible) { app.searchOpen = false; return }
    query.forceActiveFocus(); query.selectAll()
  }
  onRoomChanged: if (visible) { generation++; busy = false; results = []; selected = -1; status = query.text.trim() ? "Enter to search room " + room : "" }

  function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
  function when(ts) {
    var d = new Date(ts), now = new Date()
    return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(Qt.locale(), "HH:mm") : d.toLocaleString(Qt.locale(), "MMM d HH:mm")
  }
  function setMode(m) {
    if (mode === m) return
    mode = m; results = []; selected = -1
    generation++; busy = false
    status = m === "ai" ? "Describe what you're looking for, then Enter." : (query.text.trim() ? "Enter to search" : "")
  }
  function run() {
    var q = query.text.trim()
    var gen = ++generation
    if (!q) { results = []; status = mode === "ai" ? "Describe what you're looking for, then Enter." : ""; busy = false; return }
    busy = true
    status = mode === "ai" ? "Thinking… (reading the room's recent conversations)" : "Searching…"
    app.call("search", { room: room, query: q, mode: mode }, function (r, err) {
      if (gen !== win.generation) return
      busy = false
      if (!r) { results = []; status = "✗ " + err; return }
      results = r.results
      selected = r.results.length ? 0 : -1
      status = r.results.length + (r.results.length === 1 ? " result" : " results")
             + " · " + r.sources + " sources" + (r.scanned ? " · " + r.scanned + " entries read" : "")
             + " · " + (r.ms >= 1000 ? (r.ms / 1000).toFixed(1) + " s" : r.ms + " ms")
      list.positionViewAtBeginning()
    })
  }

  Shortcut { sequence: "Escape"; onActivated: app.searchOpen = false }
  Shortcut { sequence: "Ctrl+/"; onActivated: win.setMode(win.mode === "ai" ? "keyword" : "ai") }

  Column {
    id: head
    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 14 }
    spacing: 10

    Item {
      width: parent.width; height: 30
      Rectangle { id: badge; width: 30; height: 30; radius: app.radius; color: app.roomColor(win.room)
        Text { anchors.centerIn: parent; text: win.room; color: "white"; font.family: app.fontFamily; font.pixelSize: 15; font.bold: true } }
      Column {
        anchors { left: badge.right; leftMargin: 10; verticalCenter: parent.verticalCenter }
        Text { text: "Search room " + win.room; color: app.fg; font.family: app.fontFamily; font.pixelSize: 14; font.bold: true }
        Text { text: "every agent's conversation + the room log"; color: app.dimFg; font.family: app.fontFamily; font.pixelSize: 10 }
      }
      Row {
        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
        spacing: 4
        Repeater {
          model: [{ m: "keyword", t: "Keyword" }, { m: "ai", t: "✦ AI" }]
          delegate: Rectangle {
            required property var modelData
            readonly property bool on: win.mode === modelData.m
            width: chipText.implicitWidth + 20; height: 26; radius: app.radius
            color: on ? app.roomColor(win.room) : (chipMouse.containsMouse ? app.bg3 : app.bg2)
            border.color: on ? "transparent" : app.border
            Text { id: chipText; anchors.centerIn: parent; text: modelData.t; color: on ? "white" : app.fg; font.family: app.fontFamily; font.pixelSize: 12; font.bold: on }
            MouseArea { id: chipMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: win.setMode(modelData.m) }
          }
        }
      }
    }

    Rectangle {
      width: parent.width; height: 38; radius: app.radius
      color: app.bg2
      border.color: query.activeFocus ? app.roomColor(win.room) : app.border
      Text { id: glass; text: win.mode === "ai" ? "✦" : "⌕"; color: app.dimFg; font.pixelSize: 16
        anchors { left: parent.left; leftMargin: 11; verticalCenter: parent.verticalCenter } }
      TextField {
        id: query
        anchors { left: glass.right; right: parent.right; leftMargin: 6; rightMargin: 8; verticalCenter: parent.verticalCenter }
        placeholderText: win.mode === "ai" ? "What are you looking for? e.g. “where did we decide on the colours”" : "Exact words (case-insensitive)"
        placeholderTextColor: app.dimFg
        color: app.fg; font.family: app.fontFamily; font.pixelSize: 13
        background: null
        Keys.onReturnPressed: win.run()
        Keys.onEnterPressed: win.run()
        Keys.onUpPressed: { win.selected = Math.max(0, win.selected - 1); list.positionViewAtIndex(win.selected, ListView.Contain) }
        Keys.onDownPressed: { win.selected = Math.min(win.results.length - 1, win.selected + 1); list.positionViewAtIndex(win.selected, ListView.Contain) }
      }
    }

    Row {
      width: parent.width; spacing: 8
      BusyIndicator { visible: win.busy; running: win.busy; width: 16; height: 16 }
      Text { text: win.status; color: win.status.indexOf("✗") === 0 ? "#b4637a" : app.dimFg; font.family: app.fontFamily; font.pixelSize: 11
        width: parent.width - 30; elide: Text.ElideRight }
    }
  }

  ListView {
    id: list
    anchors { left: parent.left; right: parent.right; top: head.bottom; bottom: parent.bottom; margins: 14; topMargin: 8 }
    clip: true
    spacing: 6
    model: win.results
    ScrollBar.vertical: ScrollBar {}
    delegate: Rectangle {
      required property var modelData
      required property int index
      readonly property bool sel: index === win.selected
      width: list.width - 6
      height: col.implicitHeight + 14
      radius: app.radius
      color: sel ? Qt.alpha(app.roomColor(win.room), 0.14) : (rowMouse.containsMouse ? app.bg3 : app.bg2)
      border.color: sel ? Qt.alpha(app.roomColor(win.room), 0.7) : "transparent"
      MouseArea { id: rowMouse; anchors.fill: parent; hoverEnabled: true; onClicked: win.selected = index }
      Column {
        id: col
        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 7; leftMargin: 10; rightMargin: 10 }
        spacing: 3
        Text {
          width: parent.width; elide: Text.ElideRight
          text: (modelData.icon ? modelData.icon + " " : "") + modelData.name + (modelData.live ? "" : "  (closed)")
                + "   · " + ({ angus: "Angus", agent: "agent", room: "room", talk: "talk" }[modelData.role] || modelData.role)
                + " · " + win.when(modelData.ts) + (modelData.count > 1 ? "  · ×" + modelData.count : "")
          color: modelData.color || app.fg; font.family: app.fontFamily; font.pixelSize: 11; font.bold: true
        }
        Text {
          width: parent.width; wrapMode: Text.Wrap; maximumLineCount: 4; elide: Text.ElideRight
          textFormat: Text.StyledText
          text: win.esc(modelData.pre) + (modelData.match ? "<b><font color=\"" + app.roomColor(win.room) + "\">" + win.esc(modelData.match) + "</font></b>" : "") + win.esc(modelData.post)
          color: app.fg; font.family: app.fontFamily; font.pixelSize: 12
        }
        Text {
          visible: !!modelData.why; width: parent.width; wrapMode: Text.Wrap
          text: "↳ " + (modelData.why || ""); color: app.dimFg; font.family: app.fontFamily; font.pixelSize: 11; font.italic: true
        }
      }
    }
  }

  Text {
    anchors.centerIn: list
    visible: !win.busy && win.results.length === 0 && query.text.trim() !== "" && win.status.indexOf("result") >= 0
    text: win.mode === "ai" ? "Nothing matched that idea." : "No exact matches."
    color: app.dimFg; font.family: app.fontFamily; font.pixelSize: 12
  }
}
