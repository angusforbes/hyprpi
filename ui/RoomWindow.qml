// A room window: a normal Hyprland window (at most one per workspace). The
// daemon places a new one as the left-most root of the workspace's dwindle
// tree; after that it is an ordinary window.
// Agents (click to jump, @ to address) above the room's shared conversation.
// Type to the whole room; start with @Name [@Name2 ...] to prompt only them.
import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Controls

FloatingWindow {
  id: win
  property string room: "A"
  property string key: ""
  property var app
  title: "hyprpi room " + room + " · " + key
  implicitWidth: 430
  implicitHeight: 700
  color: app.popupBg
  // Closed by the compositor (SUPER+W, the world click): drop it.
  onVisibleChanged: if (!visible) app.forgetWindow(key)

  readonly property var members: app.agents.filter(a => a.room === room)
  readonly property color roomColor: app.roomColor(room)
  property string note: ""
  // "{#f7768e}S{#ff9e64}p…" -> <font color=…> spans (text before the first tag: fallback colour).
  function markupHtml(m, fallback) {
    var esc = function (t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
    var parts = String(m).split(/(\{#[0-9a-fA-F]{6}\})/), color = String(fallback), out = ""
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].match(/^\{(#[0-9a-fA-F]{6})\}$/)
      if (t) { color = t[1]; continue }
      if (parts[i]) out += "<font color=\"" + color + "\">" + esc(parts[i]) + "</font>"
    }
    return out
  }

  function send() {
    var text = input.text.trim()
    if (!text) return
    // Leading @Name tokens (any number) = prompt just those agents.
    var m = text.match(/^((?:@\S+[\s,]+)+)([\s\S]+)$/)
    if (m) {
      var names = m[1].split(/[\s,]+/).filter(x => x.length > 1).map(x => x.slice(1))
      var body = m[2], sent = [], failed = [], left = names.length
      names.forEach(function (who) {
        app.call("agent.prompt", { agent: who, text: body, via: "room-window" }, function (r, err) {
          if (r) sent.push(r.name); else failed.push(who + " (" + err + ")")
          if (--left === 0) {
            win.note = (sent.length ? "→ sent to " + sent.join(", ") : "") + (failed.length ? "  ✗ " + failed.join(", ") : "")
            noteTimer.restart()
          }
        })
      })
    } else {
      app.call("room.post", { room: room, text: text, as_human: true, via: "room-window" }, function (r, err) {
        if (!r) { win.note = "✗ " + err; noteTimer.restart(); return }
        win.note = r.delivered.length ? ("→ " + r.delivered.join(", ")) : "saved · no agents in this room yet"
        noteTimer.restart()
      })
    }
    input.text = ""
  }
  Timer { id: noteTimer; interval: 5000; onTriggered: win.note = "" }

  // @ adds "@Name " to the front block of mentions (once per agent).
  function mention(a) {
    var tag = "@" + (a.name || a.display).replace(/\s+/g, "")
    var t = input.text
    var lead = (t.match(/^(?:@\S+[\s,]*)*/) || [""])[0]
    if (lead.split(/[\s,]+/).indexOf(tag) >= 0) { input.forceActiveFocus(); return }
    var rest = t.slice(lead.length)
    lead = lead.replace(/\s*$/, "")
    input.text = (lead ? lead + " " : "") + tag + " " + rest
    input.forceActiveFocus()
    input.cursorPosition = input.text.length
  }

  Process { id: newAgent; command: [Quickshell.shellDir + "/../bin/hyprpi", "new"] }

  Rectangle { anchors.fill: parent; color: app.popupBg }

  Column {
    id: top
    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 12 }
    spacing: 8

    // ---- header ----
    Item {
      width: parent.width; height: 34
      Rectangle {
        id: closeBtn
        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
        width: 26; height: 26; radius: app.radius
        color: closeMouse.containsMouse ? app.bg3 : "transparent"
        Text { anchors.centerIn: parent; text: "✕"; color: app.dimFg; font.pixelSize: 13 }
        MouseArea { id: closeMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: win.visible = false }
      }
      Rectangle {
        id: searchBtn
        anchors { right: closeBtn.left; rightMargin: 4; verticalCenter: parent.verticalCenter }
        width: 26; height: 26; radius: app.radius
        color: searchMouse.containsMouse ? app.bg3 : "transparent"
        Text { anchors.centerIn: parent; text: "⌕"; color: app.dimFg; font.pixelSize: 16 }
        MouseArea { id: searchMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: app.openSearch(win.room, false) }
      }
      Rectangle { id: badge; width: 34; height: 34; radius: app.radius; color: win.roomColor
        Text { anchors.centerIn: parent; text: win.room; color: "white"; font.family: app.fontFamily; font.pixelSize: 17; font.bold: true } }
      Column {
        anchors { left: badge.right; leftMargin: 10; verticalCenter: parent.verticalCenter }
        Text { text: "Room " + win.room; color: app.fg; font.family: app.fontFamily; font.pixelSize: 15; font.bold: true }
        Text { text: win.members.length + (win.members.length === 1 ? " agent" : " agents") + (app.online ? "" : "  ·  daemon offline")
               color: app.online ? app.dimFg : "#b4637a"; font.family: app.fontFamily; font.pixelSize: 11 }
      }
      Rectangle {
        anchors { right: searchBtn.left; rightMargin: 6; verticalCenter: parent.verticalCenter }
        width: addText.implicitWidth + 18; height: 26; radius: app.radius
        color: addMouse.containsMouse ? app.bg3 : app.bg2; border.color: app.border
        Text { id: addText; anchors.centerIn: parent; text: "＋ agent"; color: app.fg; font.family: app.fontFamily; font.pixelSize: 12 }
        MouseArea { id: addMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: newAgent.running = true }
      }
    }

    // ---- agents ----
    Column {
      width: parent.width
      spacing: 3
      Repeater {
        model: win.members
        delegate: Rectangle {
          required property var modelData
          width: parent.width; height: 42; radius: app.radius
          color: rowMouse.containsMouse ? app.bg3 : (modelData.focused ? app.bg2 : "transparent")
          border.color: modelData.focused ? Qt.alpha(win.roomColor, 0.7) : "transparent"
          border.width: modelData.focused ? 1.5 : 0
          MouseArea { id: rowMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
            onClicked: app.call("agent.focus", { agent: modelData.id }, null) }
          // Status mark, all in the world's colour, no animation:
          // working = solid dot · done (unseen, with the ding) = \u2713 ·
          // blocked (unseen) = \u00d7 · idle (or done/blocked and seen) = hollow ring.
          Item { id: dot; width: 11; height: 11
            anchors { left: parent.left; leftMargin: 9; verticalCenter: parent.verticalCenter }
            property string mark: modelData.status === "working" ? "solid"
              : (modelData.status === "blocked" && !modelData.seen) ? "x"
              : (modelData.status === "done" && !modelData.seen) ? "check" : "ring"
            Rectangle { visible: dot.mark === "solid" || dot.mark === "ring"; anchors.centerIn: parent
              width: 9; height: 9; radius: 4.5
              color: dot.mark === "solid" ? win.roomColor : "transparent"
              border.color: win.roomColor; border.width: dot.mark === "ring" ? 1.5 : 0 }
            Text { visible: dot.mark === "check" || dot.mark === "x"; anchors.centerIn: parent
              text: dot.mark === "check" ? "\u2713" : "\u00d7"; color: win.roomColor
              font.pixelSize: dot.mark === "check" ? 13 : 15; font.bold: true } }
          Text { id: glyph; text: modelData.icon || "🤖"; font.pixelSize: 17
            anchors { left: dot.right; leftMargin: 9; verticalCenter: parent.verticalCenter } }
          Column {
            anchors { left: glyph.right; leftMargin: 8; right: at.left; rightMargin: 6; verticalCenter: parent.verticalCenter }
            Text { width: parent.width; elide: Text.ElideRight
              // Multicoloured names (herdr-name {#rrggbb} markup) as styled text.
              textFormat: modelData.name_markup ? Text.StyledText : Text.PlainText
              text: modelData.name_markup ? win.markupHtml(modelData.name_markup, modelData.color || app.fg) : modelData.display
              color: modelData.color || app.fg; font.family: app.fontFamily; font.pixelSize: 13; font.bold: true }
            Text { width: parent.width; elide: Text.ElideRight
              text: [modelData.status, String(modelData.workspace_label || "").replace(/^.*:/, ""), modelData.model, modelData.cwd.replace(/^\/home\/[^/]+/, "~")].filter(x => x).join(" · ")
              color: app.dimFg; font.family: app.fontFamily; font.pixelSize: 10 }
          }
          Rectangle { id: at; width: 26; height: 26; radius: app.radius
            anchors { right: parent.right; rightMargin: 8; verticalCenter: parent.verticalCenter }
            color: atMouse.containsMouse ? app.bg2 : "transparent"; border.color: atMouse.containsMouse ? app.border : "transparent"
            Text { anchors.centerIn: parent; text: "@"; color: app.dimFg; font.family: app.fontFamily; font.pixelSize: 13 }
            MouseArea { id: atMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
              onClicked: win.mention(modelData) }
          }
        }
      }
      Text { visible: win.members.length === 0; width: parent.width; wrapMode: Text.WordWrap
        text: "No agents here yet. SUPER+A opens one on the current workspace."
        color: app.dimFg; font.family: app.fontFamily; font.pixelSize: 11 }
    }

    Rectangle { width: parent.width; height: 1; color: app.border }
  }

  // ---- conversation ----
  ListView {
    id: chat
    anchors { left: parent.left; right: parent.right; top: top.bottom; bottom: inputBox.top; margins: 12; topMargin: 6 }
    clip: true
    spacing: 8
    model: { app.messagesVersion; return app.messages[win.room] || [] }
    // Delegate heights settle a frame late: scroll now and again shortly after.
    onCountChanged: { chat.positionViewAtEnd(); toEnd.restart() }
    onModelChanged: toEnd.restart()
    onVisibleChanged: if (visible) toEnd.restart()
    Timer { id: toEnd; interval: 60; onTriggered: chat.positionViewAtEnd() }
    ScrollBar.vertical: ScrollBar {}
    delegate: Rectangle {
      required property var modelData
      readonly property bool human: modelData.author && modelData.author.kind === "human"
      width: chat.width - 4
      height: msgCol.implicitHeight + 12
      radius: app.radius
      color: human ? Qt.alpha(win.roomColor, 0.12) : app.bg2
      Column {
        id: msgCol
        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 6; leftMargin: 9; rightMargin: 9 }
        spacing: 2
        Text {
          width: parent.width; elide: Text.ElideRight
          text: (human ? "Angus" : ((modelData.author.icon ? modelData.author.icon + " " : "") + modelData.author.name))
                + (modelData.reply_to ? "  ↩ #" + modelData.reply_to : "")
                + "   " + new Date(modelData.ts).toLocaleTimeString(Qt.locale(), "HH:mm")
          color: human ? win.roomColor : (modelData.author.color || app.fg)
          font.family: app.fontFamily; font.pixelSize: 11; font.bold: true
        }
        TextEdit {
          width: parent.width; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap
          text: modelData.text; color: app.fg; font.family: app.fontFamily; font.pixelSize: 12
        }
      }
    }
  }

  // ---- input ----
  Rectangle {
    id: inputBox
    anchors { left: parent.left; right: parent.right; bottom: parent.bottom; margins: 12 }
    height: Math.min(140, input.implicitHeight + 16) + (win.note ? 16 : 0)
    radius: app.radius
    color: app.bg2
    border.color: input.activeFocus ? win.roomColor : app.border
    Text {
      visible: win.note !== ""; text: win.note; color: app.dimFg; font.family: app.fontFamily; font.pixelSize: 10
      anchors { left: parent.left; bottom: parent.bottom; leftMargin: 10; bottomMargin: 3 }
    }
    ScrollView {
      anchors { fill: parent; margins: 6; bottomMargin: win.note ? 18 : 6 }
      TextArea {
        id: input
        wrapMode: TextArea.Wrap
        placeholderText: "Message room " + win.room + "  (click @ to address agents · Shift+Enter newline)"
        placeholderTextColor: app.dimFg
        color: app.fg
        font.family: app.fontFamily; font.pixelSize: 12
        background: null
        Keys.onPressed: event => {
          if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) {
            win.send(); event.accepted = true
          }
        }
      }
    }
  }
}
