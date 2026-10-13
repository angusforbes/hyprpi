// J543 (Angus: a remote world's panels must work exactly like a local world's): what a panel does "on the desktop" (jump to an
// agent's window, open a link, bring up another panel, start an agent, paste the clipboard) has to happen on the LAPTOP, where
// the desktop is. A remote world's panel runs on the remote machine (omnistation/remote.sh panel KIND, HYPRPI_REMOTE_PANEL=1)
// in a laptop kitty window, through the laptop's pty relay (omnistation/pty-relay.py, started by omnistation/panel-loop.sh).
// There, instead of acting locally, the panel writes a private OSC to its own terminal:
//
//   ESC ] 5379 ; hyprpi ; base64(JSON { act, ..., n: nonce }) BEL
//
// The relay takes it out of the output and does the action on the laptop (omnistation/laptop-act.mjs), only right after a
// matching local click or key it passed through itself, and only with this run's nonce (HYPRPI_LAPTOP_RELAY, which the relay put
// in the panel's environment), so text a remote agent prints can't drive the laptop. Actions:
//   { act: "focus", agent: ID }    an agent's laptop window (opened with `world X open NAME` if it has none), like agent.focus
//   { act: "open", url }           an http(s) link in the laptop's browser
//   { act: "file", path }          a file on the REMOTE machine: copied to the laptop (~/Downloads/hyprpi-<x>/) and opened there
//   { act: "panel", kind }         one of this world's panels on the laptop (agents | room | search | board), like panel-here
//   { act: "new" }                 a new agent in this world (world X new), like `hyprpi new`
//   { act: "paste" }               the laptop's clipboard: an image is uploaded to this machine and its path typed into the box
//                                  (a bracketed paste, so the box's own paste puts it in); text is pasted as text
// Local panels (no HYPRPI_REMOTE_PANEL) are untouched: every helper below does exactly what the panels did before.
export const OSC_CODE = 5379;
export const remotePanel = (env = process.env) => !!env.HYPRPI_REMOTE_PANEL;
const nonceOf = (env) => (/^[A-Za-z0-9]{16,64}$/.test(env.HYPRPI_LAPTOP_RELAY || "") ? env.HYPRPI_LAPTOP_RELAY : "");
// Is the laptop's relay there to act? (A laptop with an older panel-loop has none: then the panel says so instead.)
export const laptopRelay = (env = process.env) => remotePanel(env) && !!nonceOf(env);
export const NO_RELAY = "this needs the laptop's newer hyprpi (omnistation/pty-relay.py): update it there";

export const laptopOsc = (obj, env = process.env) =>
  `\x1b]${OSC_CODE};hyprpi;${Buffer.from(JSON.stringify({ ...obj, n: nonceOf(env) })).toString("base64")}\x07`;
let writer = (s) => process.stdout.write(s);
export function setLaptopWriter(fn) { writer = fn; } // tests
// -> true when the request went to the laptop's relay
export function laptopAct(obj, env = process.env) {
  if (!laptopRelay(env)) return false;
  writer(laptopOsc(obj, env));
  return true;
}

// Jump to an agent's window: the daemon's agent.focus here; in a remote panel, its laptop window.
export function focusAgent(api, id) {
  if (!remotePanel()) return api.call("agent.focus", { agent: id });
  return laptopAct({ act: "focus", agent: String(id) }) ? Promise.resolve({ laptop: true }) : Promise.reject(new Error(NO_RELAY));
}

// A link (http(s)) or, in a remote panel, a path on this machine (opened from a copy on the laptop). -> a note for the panel
export function laptopOpen(target) {
  const t = String(target || "");
  if (/^https?:\/\//i.test(t)) return laptopAct({ act: "open", url: t }) ? "opening link on the laptop" : "✗ " + NO_RELAY;
  let p = t;
  if (/^file:\/\//i.test(p)) { try { p = decodeURIComponent(p.replace(/^file:\/\//i, "")); } catch { p = p.replace(/^file:\/\//i, ""); } }
  if (p.startsWith("~/")) p = (process.env.HOME || "") + p.slice(1);
  if (!p.startsWith("/")) return "✗ not a link";
  return laptopAct({ act: "file", path: p }) ? "copying it to the laptop to open" : "✗ " + NO_RELAY;
}

// Another of this world's panels: on the laptop (remote panel). -> a note, or "" when this isn't a remote panel
export function laptopPanel(kind) {
  if (!remotePanel()) return "";
  return laptopAct({ act: "panel", kind }) ? `→ the ${kind === "search" ? "Thoughts" : kind} panel on the laptop` : "✗ " + NO_RELAY;
}

// A new agent in this (remote) world: the laptop opens it (world X new). -> true when asked
export const laptopNew = () => laptopAct({ act: "new" });

// The laptop's clipboard into the box (remote panel): -> true when asked (the text arrives as a bracketed paste)
export const laptopPaste = () => laptopAct({ act: "paste" });
