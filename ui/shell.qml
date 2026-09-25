// hyprpi room widget — a fixed-size panel pinned under the bar's world
// letters, one per Hyprland instance. Started by `hyprpi room [ROOM] [--toggle]`,
// which passes the daemon socket in HYPRPI_SOCKET.
//
//   qs -p ~/Work/hyprpi/ui ipc call hyprpi toggle ""     (current world, follows it)
//   qs -p ~/Work/hyprpi/ui ipc call hyprpi toggle B      (room B, pinned to B)
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
  // ---- the panel ----
  property bool panelOpen: false
  property string panelRoom: "A"
  property bool panelFollow: true        // opened for "current world": follow world changes
  readonly property string shownRoom: panelFollow && activeRoom ? activeRoom : panelRoom
  onShownRoomChanged: if (shownRoom && !messages[shownRoom]) loadRoom(shownRoom)
  // Moving to another world while the widget is open shows that world's room,
  // empty or not (it never pops up by itself).
  // ---- the search window ----
  property bool searchOpen: false
  property string searchRoom: "A"
  function openSearch(room, toggle) {
    room = String(room || activeRoom || "A")
    if (toggle && searchOpen && searchRoom === room) { searchOpen = false; return }
    searchRoom = room
    searchOpen = true
  }
  // Placement (logical px): under the bar, lined up with the world letters.
  property int panelGap: 10   // = Hyprland gaps_out, so it lines up with tiled windows
  property int panelLeft: 10   // whole physical pixels at scale 1.6 (x1.6 = 16), else the edge blurs
  property int panelWidth: 430
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
  // Match Omarchy's popups (e.g. the volume panel): theme popups border colour
  // (falls back to accent), 2px, corners = Hyprland decoration:rounding (0 here).
  readonly property color popupBorder: shellToml["popups.border"] || accent
  readonly property color popupBg: shellToml["popups.background"] || bg
  // Omarchy: Style.space(2) = round(2 * spacing.scale * font.base-size / 12)
  // (spacing scale-with-font is on); user ~/.config/omarchy/shell.toml wins.
  readonly property int popupBorderWidth: Math.max(1, Math.round(2 * spacingScale * Math.max(1 / 12, fontBase / 12)))
  readonly property real spacingScale: Number(tomlUser["spacing.scale"] || tomlTheme["spacing.scale"] || 1)
  readonly property real fontBase: Number(tomlUser["font.base-size"] || tomlTheme["font.base-size"] || 12)
  property int radius: 0
  property var tomlTheme: ({})
  property var tomlUser: ({})
  readonly property var shellToml: Object.assign({}, tomlTheme, tomlUser)
  function parseToml(raw) {
    var out = {}, section = "", lines = String(raw).split("\n")
    for (var i = 0; i < lines.length; i++) {
      var h = lines[i].match(/^\s*\[([^\]]+)\]/)
      if (h) { section = h[1]; continue }
      var m = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6,8}|-?[0-9.]+)/)
      if (m) out[section + "." + m[1]] = m[2]
    }
    return out
  }
  FileView {
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/shell.toml"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: shell.tomlTheme = shell.parseToml(text())
  }
  FileView {
    path: Quickshell.env("HOME") + "/.config/omarchy/shell.toml"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: shell.tomlUser = shell.parseToml(text())
  }
  Process {
    running: true
    command: ["hyprctl", "getoption", "decoration:rounding", "-j"]
    stdout: StdioCollector { onStreamFinished: { try { shell.radius = Math.max(0, Number(JSON.parse(text).int) || 0) } catch (e) {} } }
  }
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
        shell.messages = ({})
        if (shell.shownRoom) shell.loadRoom(shell.shownRoom)
      }
    }
    parser: SplitParser {
      onRead: data => {
        var m
        try { m = JSON.parse(data) } catch (e) { return }
        if (m.event === "agents") shell.applyList(m.data)
        else if (m.event === "message") shell.onMessage(m.data)
        else if (m.event === "open") shell.open(m.data.room || "", !!m.data.toggle)
        else if (m.event === "search") shell.openSearch(m.data.room || "", !!m.data.toggle)
        else if (m.id !== undefined && shell.callbacks[m.id]) {
          var cb = shell.callbacks[m.id]; delete shell.callbacks[m.id]
          cb(m.result === undefined ? null : m.result, m.error || "")
        }
      }
    }
  }
  // Keep retrying while the daemon is away (restarts, crashes).
  Timer { id: reconnect; interval: 1500; repeat: true; running: !shell.online
    onTriggered: { sock.connected = false; sock.connected = true } }

  // ---- open / toggle ----------------------------------------------------------
  // room "" = the current world's room (and keep following it).
  function open(room, toggle) {
    var follow = !room
    var target = follow ? (activeRoom || "A") : String(room)
    if (toggle && panelOpen && shownRoom === target) { panelOpen = false; return }
    panelFollow = follow
    panelRoom = target
    if (!messages[target]) loadRoom(target)
    panelOpen = true
  }

  RoomPanel { room: shell.shownRoom; app: shell }
  SearchWindow { app: shell }

  IpcHandler {
    target: "hyprpi"
    function ping(): string { return "pong" }
    function open(room: string): void { shell.open(room, false) }
    function toggle(room: string): void { shell.open(room, true) }
    function close(): void { shell.panelOpen = false }
    function search(room: string): void { shell.openSearch(room, false) }
  }
}
