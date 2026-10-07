import Quickshell
import Quickshell.Io
import QtQuick

// Omarchy overlay entry for hyprwrlds-vimarchy.
//   omarchy-shell shell summon agf.hyprwrlds-vimarchy '{"mode":"world"}'   (or "all")
// The shell calls open(payload) / close(). When the overview dismisses itself
// (jump, Escape, click) we tell the shell to hide us so its open state and
// Loader stay in sync.
Item {
  id: root
  property bool closingFromShell: false

  function open(payloadJson) { overview.open(payloadJson) }
  function close() {
    root.closingFromShell = true
    overview.close()
    root.closingFromShell = false
  }

  Overview {
    id: overview
    onDismissed: if (!root.closingFromShell) hideShell.running = true
  }

  Process {
    id: hideShell
    running: false
    command: ["omarchy-shell", "shell", "hide", "agf.hyprwrlds-vimarchy"]
  }
}
