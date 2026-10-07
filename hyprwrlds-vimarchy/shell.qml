// Development harness for hyprwrlds-vimarchy: a standalone Quickshell
// instance, independent of omarchy-shell (restart it freely; the bar is not
// touched).
//
//   qs -p ~/Work/hyprpi/hyprwrlds-vimarchy            start
//   qs -p ~/Work/hyprpi/hyprwrlds-vimarchy ipc call hwv open world|all
//   qs -p ~/Work/hyprpi/hyprwrlds-vimarchy ipc call hwv press a
//   qs -p ~/Work/hyprpi/hyprwrlds-vimarchy ipc call hwv close
//   qs -p ~/Work/hyprpi/hyprwrlds-vimarchy kill
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
    function dry(mode: string): void { overview.open(JSON.stringify({ mode: mode, dry: true })) }
    function openTest(mode: string, hintStart: int): void { overview.open(JSON.stringify({ mode: mode, hintStart: hintStart })) }
    function press(key: string): void { overview.press(key) }
    // Test: build (dry, never shown) from a recorded snapshot (JSON text) instead of live hyprctl (J167):
    //   qs -p . ipc call hwv feed "$(cat snapshot.json)"
    function feed(raw: string): string {
      overview.dry = true; overview.mode = "all"; overview.sessionHints = ({})
      overview.loadGeneration++
      overview.applySnapshot(raw, overview.loadGeneration)
      var e1 = null
      for (var i = 0; i < overview.rows.length; i++) for (var j = 0; j < overview.rows[i].workspaces.length; j++)
        if (overview.rows[i].workspaces[j].id === overview.activeWorkspace) e1 = overview.rows[i].workspaces[j]
      return JSON.stringify({ active: overview.activeWorkspace, special: overview.specialName,
        specialWindows: overview.specialWindows.map(function(w) { return w.cls }),
        activeTileWindows: e1 ? e1.windows.map(function(w) { return w.cls + " [" + w.hint + "]" }) : null,
        hints: Object.keys(overview.hints).length })
    }
    // Dry: what would typing `seq` do?  jump / wait (ambiguous) / prefix / none
    function would(seq: string): string {
      var isHint = !!overview.hints[seq], longer = overview.hasLonger(seq)
      if (isHint && !longer) return "jump " + seq + " (ws " + overview.hints[seq].workspace + ")"
      if (isHint && longer) return "wait " + overview.ambiguityMs + "ms, then " + seq + " (ws " + overview.hints[seq].workspace + "); more keys -> longer hint"
      if (longer) return "prefix, keep typing"
      return "no match"
    }
    // Move testing (no keyboard needed)
    function pick(seq: string): string { var w = overview.hints[seq]; if (!w) { overview.heldList = []; return "cleared" } overview.toggleHeld(w); return "list: " + overview.heldList.map(function(x) { return x.hint + "@" + x.workspace }).join(" ") }
    function dropDigit(d: int): void { overview.dropDigit(d) }
    function newWorkspace(): string { overview.newWorkspace(); return overview.notice || "ok" }
    function newWorld(): string { overview.newWorld(); return overview.notice || "ok" }
    function selectWorkspace(id: int): string {
      for (var r = 0; r < overview.rows.length; r++)
        for (var c = 0; c < overview.rows[r].workspaces.length; c++)
          if (overview.rows[r].workspaces[c].id === id) { overview.selRow = r; overview.selCol = c; overview.ensureVisible(); return "selected " + id }
      return "not shown: " + id
    }
    function rowsSummary(): string {
      return overview.rows.map(function(r) { return r.letter + ":" + r.workspaces.map(function(w) { return (w.slot % 10) + (w.virtual ? "*" : "") + "(" + w.windows.length + ")" }).join(",") }).join("  ")
    }
    // J209: SUPER+ALT(+CTRL/+SHIFT)+arrows without a keyboard; sel() reads the result.
    function grid(dx: int, dy: int, ctrl: bool, shift: bool): void { overview.gridKey(dx, dy, ctrl, shift) }
    function sel(): string {
      var id = overview.selectedWorkspaceId(), w = overview.worldOf(id)
      return "sel=" + (id ? "ABCDEFGHI".charAt(w - 1) + (((id - 1) % 10) + 1) : "-") + " (" + id + ") mode=" + overview.mode + " rows=" + overview.rows.map(function(r) { return r.letter }).join("")
    }
    // Arrow keys for testing: dr/dc = -1, 0, 1
    function move(dr: int, dc: int): string {
      overview.moveSel(dr, dc)
      var vis = overview.visibleRowIndices().map(function(r) {
        return overview.rows[r].letter + ":" + overview.visibleWorkspaces(r).map(function(w) { return w.slot % 10 }).join("")
      })
      return "sel=" + overview.rows[overview.selRow].letter + "·" + (overview.selectedWorkspaceId() - 1) % 10 + 1 + " view=[" + vis.join(" ") + "]"
    }
    // Dry run: what would this key sequence select? (Does not jump.)
    function resolve(seq: string): string {
      var w = overview.resolve(seq)
      return w ? JSON.stringify({ hint: w.hint, workspace: w.workspace, cls: w.cls, address: w.address }) : "none"
    }
    function previews(): string {
      var total = 0, matched = 0
      for (var h in overview.hints) { total++; if (overview.toplevelFor(overview.hints[h].address)) matched++ }
      return matched + "/" + total + " windows have a capture handle"
    }
    function state(): string {
      var hints = Object.keys(overview.hints).sort()
      return JSON.stringify({ opened: overview.opened, mode: overview.mode, rows: overview.rows.length,
                              hints: hints.map(function(h) { return h + "=" + overview.hints[h].workspace + ":" + overview.hints[h].cls }) })
    }
  }
}
