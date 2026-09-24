// Development harness for hyprwrlds-vimarchy: a standalone Quickshell
// instance, independent of omarchy-shell (restart it freely; the bar is not
// touched).
//
//   qs -p ~/Work/hyprwrlds-vimarchy            start
//   qs -p ~/Work/hyprwrlds-vimarchy ipc call hwv open world|all
//   qs -p ~/Work/hyprwrlds-vimarchy ipc call hwv press a
//   qs -p ~/Work/hyprwrlds-vimarchy ipc call hwv close
//   qs -p ~/Work/hyprwrlds-vimarchy kill
//
// Safety: the overlay grabs the keyboard, so in this harness it closes by
// itself after 20 s.
import Quickshell
import Quickshell.Io
import QtQuick

ShellRoot {
  Overview {
    id: overview
    onOpenedChanged: if (opened) safety.restart(); else safety.stop()
  }

  Timer {
    id: safety
    interval: 20000
    onTriggered: overview.close()
  }

  IpcHandler {
    target: "hwv"
    function open(mode: string): void { overview.open(JSON.stringify({ mode: mode })) }
    function close(): void { overview.close() }
    function press(key: string): void { overview.press(key) }
    function state(): string {
      var hints = Object.keys(overview.hints).sort()
      return JSON.stringify({ opened: overview.opened, mode: overview.mode, rows: overview.rows.length,
                              hints: hints.map(function(h) { return h + "=" + overview.hints[h].workspace + ":" + overview.hints[h].cls }) })
    }
  }
}
