import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons

// herdr.voice — bar button + panel for voice dictation to hyprpi agents and Thoughts (hyprpi voice-routing;
// the id is kept from its herdr-voice-to-agents days so existing bars and keys keep working).
//
// Thin view over ~/.local/bin/voice-agent: all state comes from
// `voice-agent panel-state` (JSON) and every action is a voice-agent call, so
// the panel, the SUPER+Caps keys, /voice-switch and the CLI never disagree.
//
// Bar glyph:  󰍭 hands-free off & no target · 󰍬 push-to-talk ready ·
//             colour: dim grey = hands-free off/paused · light blue = listening ·
//             red = transcribing (2026-09-22, Angus: match the dim-when-off look of
//             the tray icons)
Panel {
  id: root
  moduleName: "herdr.voice"
  ipcTarget: "herdr.voice"
  manageIpc: false

  // ---- state (from voice-agent panel-state) --------------------------------
  property var vs: ({ handsfree: false, listener: "off", autostart: false, recording: false,
                         target: { id: "", name: "" }, agents: [], rooms: [], phrases: {}, model: "small.en" })
  property bool busy: false
  property string lastError: ""

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Optimistic UI: flip immediately on click, reconcile when the next
  // panel-state arrives (services take ~1-4 s to start).
  property int pendingHandsfree: -1   // -1 none, 0 off, 1 on
  property int pendingAutostart: -1
  readonly property bool handsfree: pendingHandsfree >= 0 ? pendingHandsfree === 1 : !!vs.handsfree
  readonly property bool autostart: pendingAutostart >= 0 ? pendingAutostart === 1 : !!vs.autostart
  readonly property color listenBlue: "#00C0E8"   // same blue as the VPN bar icon when connected
  readonly property color transcribeRed: "#FF4D4D"
  // dimmed bar foreground, like a disabled tray icon (~45% opacity)
  readonly property color offGrey: bar ? Qt.alpha(bar.barForeground, 0.45) : "#9A9A9A"
  readonly property string listener: String(vs.listener || "off")   // off | idle | on | paused
  readonly property bool transcribing: listener === "on" || !!vs.recording
  readonly property string targetId: (vs.target && vs.target.id) || ""
  readonly property string targetName: (vs.target && vs.target.name) || ""
  // Optimistic target set: local overrides applied on click, cleared once the
  // reported set agrees (or after the next refresh at the latest).
  // id -> { want: bool, since: ms }. The row shows the intended state at once;
  // the entry clears when the reported set agrees, or reverts after 5 s.
  property var pendingTargets: ({})
  readonly property int pendingTimeoutMs: 5000
  readonly property var reportedIds: (vs.target && vs.target.ids) || []
  readonly property var targetIds: {
    var base = reportedIds.slice()
    for (var id in pendingTargets) {
      var i = base.indexOf(id)
      if (pendingTargets[id].want && i < 0) base.push(id)
      if (!pendingTargets[id].want && i >= 0) base.splice(i, 1)
    }
    return base
  }
  function isPending(id) { return pendingTargets[id] !== undefined }
  function reconcilePending(now) {
    var next = {}, changed = false
    for (var id in pendingTargets) {
      var pnd = pendingTargets[id]
      var reported = reportedIds.indexOf(id) >= 0
      if (reported === pnd.want) { changed = true; continue }            // confirmed
      if (now - pnd.since > pendingTimeoutMs) { changed = true; continue } // gave up -> revert
      next[id] = pnd
    }
    if (changed) pendingTargets = next
  }
  Timer { interval: 500; running: Object.keys(root.pendingTargets).length > 0; repeat: true
          onTriggered: root.reconcilePending(Date.now()) }
  readonly property bool hasTarget: targetIds.length > 0
  function isTargeted(id) { return targetIds.indexOf(id) >= 0 }

  readonly property string icon: (!handsfree && !hasTarget) ? "󰍭" : "󰍬"
  readonly property color iconColor: transcribing ? transcribeRed
                                    : (handsfree && listener !== "paused") ? listenBlue
                                    : offGrey
  readonly property string heroStatusText: {
    if (transcribing) return "Transcribing" + (hasTarget ? " → " + targetName : "")
    if (handsfree && listener === "paused") return "Hands-free paused"
    if (handsfree) return "Listening for “" + (vs.phrases.on || "on on on") + "”" + (hasTarget ? " → " + targetName : " — no target")
    if (hasTarget) return "Push-to-talk → " + targetName
    return "Off — no target"
  }

  // keyboard cursor over the target list (-1 = none)
  property int cursorIndex: -1
  function moveCursor(dy) {
    var n = targetList.rows.length
    if (n === 0) return
    cursorIndex = cursorIndex < 0 ? (dy > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cursorIndex + dy))
    targetList.ensureVisible(cursorIndex)
  }
  function activateCursor() {
    if (cursorIndex < 0 || cursorIndex >= targetList.rows.length) return
    var e = targetList.rows[cursorIndex]
    e.kind === "thoughts" ? resetToThoughts() : toggleTarget(e.id)
  }
  onOpenedChanged: if (!opened) cursorIndex = -1

  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent) : "transparent"
  readonly property color selectedFill: bar ? Style.selectedFillFor(bar.foreground, Color.accent) : "transparent"

  // ---- plumbing ---------------------------------------------------------
  function refresh() { if (!stateProc.running) stateProc.running = true }

  property var actionQueue: []
  function run(args) {
    var q = actionQueue.slice(); q.push(args); actionQueue = q
    pumpQueue()
  }
  function pumpQueue() {
    if (actionProc.running || actionQueue.length === 0) return
    var q = actionQueue.slice(); var args = q.shift(); actionQueue = q
    busy = true
    actionProc.command = ["env", "VOICE_AGENT_NO_FOCUS=1", "VOICE_AGENT_QUIET=1", "voice-agent"].concat(args)
    actionProc.running = true
  }

  function toggleHandsfree() {
    var next = !handsfree
    pendingHandsfree = next ? 1 : 0
    run(["handsfree", next ? "on" : "off"])
  }
  function setTarget(id) { run(["set", id]) }
  function toggleTarget(id) {
    if (isPending(id)) return                 // locked until the change is confirmed or times out
    var want = !isTargeted(id)
    var p = Object.assign({}, pendingTargets); p[id] = { want: want, since: Date.now() }
    if (want && isTargeted("thoughts")) p["thoughts"] = { want: false, since: Date.now() }   // J98 v3: a pick replaces the default
    pendingTargets = p
    run([want ? "add" : "remove", id])
  }
  // J98 v3: back to the default (the focused world's Thoughts), the only target
  function resetToThoughts() {
    if (Object.keys(pendingTargets).length > 0) return
    var p = {}, cur = targetIds, now = Date.now()
    for (var i = 0; i < cur.length; i++) if (cur[i] !== "thoughts") p[cur[i]] = { want: false, since: now }
    p["thoughts"] = { want: true, since: now }
    pendingTargets = p
    run(["set", "thoughts"])
  }
  function clearTarget() {
    if (Object.keys(pendingTargets).length > 0) return
    var p = Object.assign({}, pendingTargets), cur = targetIds, now = Date.now()
    for (var i = 0; i < cur.length; i++) p[cur[i]] = { want: false, since: now }
    pendingTargets = p
    run(["set", "none"])
  }
  function setAutostart(on) { pendingAutostart = on ? 1 : 0; run(["autostart", on ? "on" : "off"]) }
  function savePhrase(key, value) {
    if (value === (vs.phrases[key] || "")) return
    run(["phrase", key, value])
  }

  Process {
    id: stateProc
    command: ["voice-agent", "panel-state"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var parsed = JSON.parse(String(text || "{}"))
          if (parsed && typeof parsed === "object") {
            root.vs = parsed
            root.reconcilePending(Date.now())
            if (root.pendingHandsfree >= 0 && !!parsed.handsfree === (root.pendingHandsfree === 1)) root.pendingHandsfree = -1
            if (root.pendingAutostart >= 0 && !!parsed.autostart === (root.pendingAutostart === 1)) root.pendingAutostart = -1
          }
        } catch (e) { /* keep last good state */ }
      }
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.lastError = "" }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: if (String(text).trim() !== "") root.lastError = String(text).trim() }
    onExited: function(code) {
      root.busy = false
      if (code !== 0 && root.lastError === "") root.lastError = "voice-agent exited " + code
      root.refresh()
      root.pumpQueue()
    }
  }

  // Poll faster while the panel is open; slow heartbeat for the bar glyph.
  Timer {
    interval: root.opened ? 2500 : 8000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }
  Connections { target: root; function onOpenedChanged() { if (root.opened) root.refresh() } }

  IpcHandler {
    target: "herdr.voice"
    function open() { root.open() }
    function close() { root.close() }
    function toggle() { root.toggle() }
    function toggleHandsfree() { root.toggleHandsfree() }
    function refresh() { root.refresh() }
  }

  // ---- bar button --------------------------------------------------------
  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.icon
    foreground: root.iconColor
    tooltipText: root.heroStatusText
    onPressed: function(b) {
      if (b === Qt.RightButton) root.toggleHandsfree()
      else root.toggle()
    }
  }

  // ---- panel ---------------------------------------------------------------
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (phraseOn.isEditing || phraseSend.isEditing || phraseOff.isEditing) return
        if (t === "f" || t === "F") root.toggleHandsfree()
      }

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(14)

        // ---------- Hero: mic · Voice · status · hands-free switch ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, hfSwitch.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: root.icon
            color: root.iconColor
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            opacity: (root.handsfree || root.hasTarget) ? 1.0 : 0.5
          }

          ToggleSwitch {
            id: hfSwitch
            checked: root.handsfree
            foreground: root.bar.foreground
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            onToggled: root.toggleHandsfree()
            PanelToolTip {
              visible: hfSwitch.containsMouse
              text: root.handsfree ? "Turn hands-free off (close the mic)" : "Turn hands-free on (listen for phrases)"
              fontFamily: root.bar.fontFamily
            }
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: hfSwitch.left
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Voice"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }
            Text {
              textFormat: Text.PlainText
              text: root.heroStatusText.toUpperCase()
              color: root.transcribing ? root.transcribeRed : Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }
        }

        PanelSeparator { width: parent.width }

        // ---------- Target ----------
        PanelSectionHeader {
          width: parent.width
          text: "SEND MY VOICE TO" + (root.targetIds.length > 1 ? "  ·  " + root.targetIds.length + " SELECTED" : "  ·  STAYS UNTIL CHANGED")
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Flickable {
          id: targetList
          width: parent.width
          height: Math.min(targetColumn.implicitHeight, Style.space(260))
          contentHeight: targetColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height

          readonly property var rows: {
            // J98 v3: the default first, the focused world's Thoughts (also the reset: picking it clears the rest)
            var th = root.vs.thoughts || { id: "thoughts", name: "Thoughts (current world)" }
            var out = [{ kind: "thoughts", id: "thoughts", name: th.name || "Thoughts (current world)", sub: "default · say \u201cName, \u2026\u201d first to send one dictation to an agent", glyph: "💭" }]
            var a = root.vs.agents || []
            for (var i = 0; i < a.length; i++) {
              var full = String(a[i].name || "").trim(), glyph = "🤖", label = full
              var sp = full.indexOf(" ")
              if (sp > 0 && !/^[A-Za-z0-9]/.test(full)) { glyph = full.slice(0, sp); label = full.slice(sp + 1) }
              var sub = (a[i].workspace || a[i].pane) + " · " + a[i].status + (a[i].topic ? " · " + a[i].topic : "")
              out.push({ kind: "agent", id: a[i].pane, name: label, sub: sub, glyph: glyph })
            }
            // J98 v3: projects (this world first), each to its owner like "@project"; rooms are gone
            var pr = root.vs.projects || []
            for (var j = 0; j < pr.length; j++)
              out.push({ kind: "project", id: pr[j].id, name: pr[j].name, sub: "world " + pr[j].room + (pr[j].owner ? " · owner " + pr[j].owner : ""), glyph: pr[j].icon || "📋" })
            return out
          }

          function ensureVisible(i) {
            var y = i * (rowHeightHint + targetColumn.spacing)
            if (y < contentY) contentY = y
            else if (y + rowHeightHint > contentY + height) contentY = Math.min(contentHeight - height, y + rowHeightHint - height)
          }
          property real rowHeightHint: Style.space(44)

          // Stable model: rows are updated in place by id, so delegates survive
          // polls and clicks instead of being destroyed and recreated (no blink).
          ListModel { id: targetModel }
          function syncModel() {
            var want = rows, i, j
            for (i = 0; i < want.length; i++) {
              var w = want[i], found = -1
              for (j = 0; j < targetModel.count; j++) if (targetModel.get(j).id === w.id) { found = j; break }
              if (found < 0) targetModel.insert(Math.min(i, targetModel.count), { kind: w.kind, id: w.id, name: w.name, sub: w.sub, glyph: w.glyph })
              else {
                if (found !== i) targetModel.move(found, i, 1)
                var cur = targetModel.get(i)
                if (cur.name !== w.name) targetModel.setProperty(i, "name", w.name)
                if (cur.sub !== w.sub) targetModel.setProperty(i, "sub", w.sub)
                if (cur.glyph !== w.glyph) targetModel.setProperty(i, "glyph", w.glyph)
              }
            }
            while (targetModel.count > want.length) targetModel.remove(targetModel.count - 1)
          }
          onRowsChanged: syncModel()
          Component.onCompleted: syncModel()

          Column {
            id: targetColumn
            width: parent.width
            spacing: Style.space(2)
            Repeater {
              model: targetModel
              delegate: TargetRow {
                rowIndex: index
                entry: ({ kind: model.kind, id: model.id, name: model.name, sub: model.sub, glyph: model.glyph })
              }
            }
          }
        }

        PanelSeparator { width: parent.width }

        // ---------- Phrases ----------
        PanelSectionHeader {
          width: parent.width
          text: "SPOKEN COMMANDS"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Column {
          width: parent.width
          spacing: Style.space(6)
          PhraseField { id: phraseOn;   label: "Start";           phraseKey: "on";   hint: "begin transcribing" }
          PhraseField { id: phraseSend; label: "Send & continue"; phraseKey: "send"; hint: "deliver what you said, keep going" }
          PhraseField { id: phraseOff;  label: "Stop";            phraseKey: "off";  hint: "deliver and stop transcribing" }
          Text {
            width: parent.width
            text: root.lastError !== "" ? root.lastError : "Two or more words; last words must differ. Saving restarts the listener."
            color: root.lastError !== "" ? root.bar.urgent : Qt.darker(root.bar.foreground, 1.5)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        PanelSeparator { width: parent.width }

        // ---------- Options ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(autoLabel.implicitHeight, autoSwitch.implicitHeight)
          Column {
            id: autoLabel
            anchors.left: parent.left
            anchors.right: autoSwitch.left
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(1)
            Text { text: "Hands-free on at login"; color: root.bar.foreground; font.family: root.bar.fontFamily; font.pixelSize: Style.font.body }
            Text { text: "Otherwise the mic stays closed until you turn it on"; color: Qt.darker(root.bar.foreground, 1.5); font.family: root.bar.fontFamily; font.pixelSize: Style.font.caption; wrapMode: Text.WordWrap; width: parent.width }
          }
          ToggleSwitch {
            id: autoSwitch
            checked: root.autostart
            foreground: root.bar.foreground
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            onToggled: root.setAutostart(!root.autostart)
          }
        }

        Text {
          width: parent.width
          text: "↑↓ / j k  move   ·   Enter / Space  add / remove   ·   F  hands-free   ·   push-to-talk & panel keys: see hypr/bindings.lua   ·   whisper " + root.vs.model
          color: Qt.darker(root.bar.foreground, 1.6)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }

  // ---- components -----------------------------------------------------------
  component TargetRow: CursorSurface {
    id: row
    property var entry: ({ kind: "none", id: "", name: "", sub: "", glyph: "" })
    property int rowIndex: -1
    width: targetColumn.width
    readonly property bool isCurrent: root.isTargeted(entry.id)
    readonly property bool isPending: root.isPending(entry.id)
    readonly property bool cursorHere: root.cursorIndex === rowIndex

    // hover / arrow cursor -> shared hover fill; selected target -> accent border
    hasCursor: cursorHere
    current: false
    foreground: root.bar.foreground
    accent: Color.accent
    fill: root.hoverFill
    borderSpec: cursorHere ? Border.controlSpec("hover-cursor", root.bar.foreground, Color.accent) : Border.none()
    color: cursorHere ? root.hoverFill : (isCurrent ? root.selectedFill : "transparent")
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    // selected target: an unmistakable accent outline (kept under the cursor fill too)
    Rectangle {
      anchors.fill: parent
      visible: row.isCurrent
      color: "transparent"
      radius: Style.cornerRadius
      border.width: 2
      border.color: Qt.alpha(Color.accent, 0.85)
    }
    onImplicitHeightChanged: if (rowIndex === 0) targetList.rowHeightHint = implicitHeight

    MouseArea {
      id: rowMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: row.isPending ? Qt.BusyCursor : Qt.PointingHandCursor
      onContainsMouseChanged: if (containsMouse) root.cursorIndex = row.rowIndex
      onClicked: row.entry.kind === "thoughts" ? root.resetToThoughts() : root.toggleTarget(row.entry.id)
    }

    Item {
      id: rowContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      implicitHeight: Math.max(rowGlyph.implicitHeight, rowInfo.implicitHeight)

      Text {
        id: rowGlyph
        textFormat: Text.PlainText
        text: row.entry.glyph || ""
        color: root.bar.foreground
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.heading
        horizontalAlignment: Text.AlignHCenter
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(28)
      }

      Text {
        id: pendingMark
        visible: row.isPending
        text: "󰔟"
        color: Qt.darker(root.bar.foreground, 1.4)
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.body
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        SequentialAnimation on opacity { running: row.isPending; loops: Animation.Infinite
          NumberAnimation { to: 0.25; duration: 450 } NumberAnimation { to: 1.0; duration: 450 } }
      }

      Column {
        id: rowInfo
        spacing: Style.space(1)
        anchors.left: rowGlyph.right
        anchors.leftMargin: Style.space(10)
        anchors.right: pendingMark.visible ? pendingMark.left : parent.right
        anchors.rightMargin: pendingMark.visible ? Style.space(8) : 0
        anchors.verticalCenter: parent.verticalCenter
        Text {
          textFormat: Text.PlainText
          text: row.entry.name || ""
          color: root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          font.bold: row.isCurrent
          elide: Text.ElideRight
          width: parent.width
        }
        Text {
          textFormat: Text.PlainText
          text: row.entry.sub || ""
          visible: text !== ""
          color: Qt.darker(root.bar.foreground, 1.5)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          width: parent.width
        }
      }
    }
  }

  component PhraseField: Item {
    id: pf
    required property string label
    required property string phraseKey
    property string hint: ""
    readonly property bool isEditing: field.activeFocus
    width: parent ? parent.width : 0
    implicitHeight: field.implicitHeight

    Text {
      id: pfLabel
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(120)
      text: pf.label
      color: root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }
    TextField {
      id: field
      anchors.left: pfLabel.right
      anchors.leftMargin: Style.space(8)
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      foreground: root.bar.foreground
      verticalPadding: Style.space(4)
      placeholderText: pf.hint
      text: root.vs.phrases[pf.phraseKey] || ""
      onEditingFinished: root.savePhrase(pf.phraseKey, text.trim())
      Keys.onEscapePressed: { text = root.vs.phrases[pf.phraseKey] || ""; focus = false }
    }
  }
}
