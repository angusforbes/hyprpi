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

  function open(payloadJson) {
    // J209: {"grid":[dx,dy,ctrl,shift]} = a SUPER+ALT(+CTRL/+SHIFT)+arrow pressed while the switcher is
    // open (hyprwrlds-vimarchy.lua passes it here); never (re)opens.
    var p = {}
    try { p = JSON.parse(String(payloadJson || "{}")) } catch (e) { p = {} }
    if (p && Array.isArray(p.grid)) {
      if (overview.opened) overview.gridKey(Number(p.grid[0]) || 0, Number(p.grid[1]) || 0, p.grid[2] === true, p.grid[3] === true)
      else hideShell.running = true // closed meanwhile: keep the shell's open state in sync
      return
    }
    overview.open(payloadJson)
  }
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
