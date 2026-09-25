// Build the command line that opens an agent's terminal window.
//
// config.terminal:
//   "auto" (default)  Omarchy's default terminal (xdg-terminal-exec --print-id,
//                     i.e. ~/.config/xdg-terminals.list), falling back to foot.
//   "kitty" | "foot" | "alacritty" | "ghostty"   force one of the known terminals.
// config.terminalCommand (optional): full override for any other terminal, an
//   array with {class} {title} {cwd} placeholders; the pi command is appended,
//   e.g. ["wezterm", "start", "--class", "{class}", "--cwd", "{cwd}", "--"].
//
// Every window gets app-id/class "hyprpi.agent" (Hyprland rules match it) and
// must be its own process: the daemon finds an agent's window by walking up
// from pi's pid, so single-instance modes are turned off where they exist.
import { execFileSync } from "node:child_process";

export const AGENT_CLASS = "hyprpi.agent";

const KNOWN = {
  foot: ({ cls, title, cwd }) => ["foot", `--app-id=${cls}`, `--title=${title}`, `--working-directory=${cwd}`, "--"],
  // Herdr used to give select-to-copy; ask kitty for it just for these windows.
  kitty: ({ cls, title, cwd }) => ["kitty", `--class=${cls}`, `--title=${title}`, `--directory=${cwd}`, "-o", "copy_on_select=clipboard", "--"],
  alacritty: ({ cls, title, cwd }) => ["alacritty", "--class", cls, "--title", title, "--working-directory", cwd, "-e"],
  ghostty: ({ cls, title, cwd }) => ["ghostty", `--class=${cls}`, `--title=${title}`, `--working-directory=${cwd}`, "--gtk-single-instance=false", "-e"],
};

// "kitty.desktop", "com.mitchellh.ghostty.desktop", "org.codeberg.dnkl.foot.desktop:new-window" -> known name
export function terminalFromDesktopId(id) {
  const base = String(id || "").trim().split(":")[0].replace(/\.desktop$/i, "");
  const name = base.split(".").pop().toLowerCase();
  return KNOWN[name] ? name : null;
}

export function omarchyDefaultTerminal() {
  try {
    const id = execFileSync("xdg-terminal-exec", ["--print-id"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return terminalFromDesktopId(id.split("\n")[0]);
  } catch { return null; }
}

export function resolveTerminal(cfg) {
  const want = String(cfg.terminal || "auto").toLowerCase();
  if (want !== "auto") {
    if (!KNOWN[want]) throw new Error(`unknown terminal "${cfg.terminal}" (known: auto, ${Object.keys(KNOWN).join(", ")}; or set terminalCommand)`);
    return want;
  }
  return omarchyDefaultTerminal() || "foot";
}

// Returns [argv0, ...args] for the terminal, ending just before the command to run.
export function terminalCommand(cfg, { title = "pi", cwd }) {
  const vars = { class: AGENT_CLASS, title, cwd };
  if (Array.isArray(cfg.terminalCommand) && cfg.terminalCommand.length) {
    return cfg.terminalCommand.map((s) => String(s).replace(/\{(class|title|cwd)\}/g, (_, k) => vars[k]));
  }
  return KNOWN[resolveTerminal(cfg)]({ cls: AGENT_CLASS, title, cwd });
}
