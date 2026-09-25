// hyprpi room windows — one normal window per room, all served by this one
// Quickshell instance. Started by `hyprpi room [ROOM]`, which passes the daemon
// socket in HYPRPI_SOCKET.
//
//   qs -p ~/Work/hyprpi/ui ipc call hyprpi open A
//   qs -p ~/Work/hyprpi/ui ipc call hyprpi close A
import Quickshell
import Quickshell.Io
import QtQuick

ShellRoot {
  id: shell

  // ---- daemon state ---------------------------------------------------------
  property var agents: []
  property var rooms: []
  property string activeRoom: ""
  property bool online: false
  property var openRooms: []
  // room -> array of messages (kept per room; windows bind to their own)
  property var messages: ({})
  property int messagesVersion: 0

  // ---- theme ------------------------------------------------------------------
  property var theme: ({})
  readonly property color fg: theme.foreground || "#575279"
  readonly property color dimFg: theme.dark_foreground || "#9893a5"
  readonly property color bg: theme.background || "#faf4ed"
  readonly property color bg2: theme.lighter_background || "#f2e9e1"
  readonly property color bg3: theme.dark_background || "#ede7e1"
  readonly property color accent: theme.accent || "#56949f"
  readonly property color border: theme.muted || "#cecacd"
  readonly property string fontFamily: "JetBrainsMono Nerd Font"
  readonly property var worldKeys: ["blue", "red", "cyan", "yellow", "magenta", "green", "orange", "brown", "foreground"]
  function roomColor(room) {
    var i = "ABCDEFGHI".indexOf(String(room).charAt(0))
    if (i < 0) return accent
    return theme[worldKeys[i % worldKeys.length]] || accent
  }
  function statusColor(s) {
    if (s === "working") return theme.blue || "#56949f"
    if (s === "done") return theme.green || "#286983"
    if (s === "blocked") return theme.red || "#b4637a"
    return dimFg
  }
  FileView {
    id: colorsFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: {
      var out = {}, lines = String(text()).split("\n")
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
        if (m) out[m[1]] = m[2]
      }
      shell.theme = out
    }
  }

  // ---- daemon connection -----------------------------------------------------
  property int nextId: 1
  property var callbacks: ({})
  function call(method, params, cb) {
    if (!sock.connected) { if (cb) cb(null, "not connected"); return }
    var id = nextId++
    if (cb) callbacks[id] = cb
    sock.write(JSON.stringify({ id: id, method: method, params: params || {} }) + "\n")
    sock.flush()
  }
  function applyList(r) {
    if (!r) return
    agents = r.agents || []
    rooms = r.rooms || []
    activeRoom = r.active_room || ""
  }
  function loadRoom(room) {
    call("room.read", { room: room, tail: true, limit: 200 }, function (r, err) {
      if (!r) return
      var m = messages; m[room] = r.messages || []; messages = m; messagesVersion++
    })
  }
  function onMessage(msg) {
    var m = messages
    if (!m[msg.room]) return   // not loaded: will load when opened
    m[msg.room] = m[msg.room].concat([msg])
    messages = m; messagesVersion++
  }

  Socket {
    id: sock
    path: Quickshell.env("HYPRPI_SOCKET") || ""
    connected: true
    onConnectedChanged: {
      shell.online = connected
      if (connected) {
        shell.call("ui.subscribe", { windows: true }, function (r) { shell.applyList(r) })
        for (var i = 0; i < shell.openRooms.length; i++) shell.loadRoom(shell.openRooms[i])
      } else reconnect.start()
    }
    parser: SplitParser {
      onRead: data => {
        var m
        try { m = JSON.parse(data) } catch (e) { return }
        if (m.event === "agents") shell.applyList(m.data)
        else if (m.event === "message") shell.onMessage(m.data)
        else if (m.event === "open") shell.open(m.data.room)
        else if (m.id !== undefined && shell.callbacks[m.id]) {
          var cb = shell.callbacks[m.id]; delete shell.callbacks[m.id]
          cb(m.result === undefined ? null : m.result, m.error || "")
        }
      }
    }
  }
  Timer { id: reconnect; interval: 2000; onTriggered: if (!sock.connected) sock.connected = true }

  // ---- windows ----------------------------------------------------------------
  function open(room) {
    room = String(room || activeRoom || "A")
    if (openRooms.indexOf(room) < 0) { openRooms = openRooms.concat([room]); loadRoom(room) }
  }
  function close(room) { openRooms = openRooms.filter(r => r !== room) }

  Variants {
    model: shell.openRooms
    RoomWindow {
      required property var modelData
      room: modelData
      app: shell
    }
  }

  IpcHandler {
    target: "hyprpi"
    function ping(): string { return "pong" }
    function open(room: string): void { shell.open(room) }
    function close(room: string): void { shell.close(room) }
    function rooms(): string { return JSON.stringify(shell.openRooms) }
  }
}
