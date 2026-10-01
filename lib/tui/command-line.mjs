// The command line shared by the four hyprpi panels (agents, room, search, board): one parser, one
// registry per panel, one completion / Tab / help, and the commands common to every panel,
// implemented once here. Each panel adds its own commands to the registry. The editing itself is
// lib/tui/input-box.mjs; inputRows() below draws a bottom command line from that box.
//
//   const cmds = createCommands({ panel: "agents", commands: [...], ctx })
//   cmds.run(text)      -> true if text was a command (ran it, or set an error note); false if not
//   cmds.complete(pre)  -> command names starting with pre ("/t" -> ["/tinker"])
//   cmds.tab(box, note) -> Tab on a "/partial" in the box: complete / cycle; returns true if used
//   cmds.help()         -> [[usage, description], ...] panel commands first, then the common ones
//
// A command is { name: "/new", usage?: "/new [DIR]", help: "…", run(arg, text) }.
// Typing: "/name args" runs it; a unique prefix also runs it ("/tin fix x"); "//text" is not a
// command (the panel takes "/text" literally). A panel command wins over a common one of the
// same name (so a panel can specialise /help).
//
import { spawn } from "node:child_process";
import { agentIn } from "./agent-click.mjs";
import { loadConfig } from "../paths.mjs";

// Common commands (every panel; Angus 2026-09-28). The ones that mean the same thing everywhere:
//   /help            this panel's commands and keys (the panel shows them: ctx.showHelp())
//   /agents /room /search /board (/projects)   go to that panel for this world: jump to it wherever it is,
//                    or open it here (mockups/panel-here; the agents panel opens top-left)
//   /search WORDS    from any panel: the search panel (jumped to / opened) runs it · /ai Q, /ask Q
//                    the same in AI mode. (The search panel's own /search /ai /ask override these.)
//   /world X         switch this panel to world X (as ^Tab steps through them)
//   /go @Name        jump to that agent's window (the typed Ctrl+click; Tab completes the name)
//   /new [DIR]       a new agent here (projects: /project on the board)
//   /tinker [W:] X   drop a friction fix off in the workshop world
//   /quit            close this panel
// ctx: { panel: "agents" | "room" | "search" | "board" · api(): the daemon connection or null
//        · note(text) · render() · showHelp() · quit() · via: the panel's name for the daemon
//        · setBox(text): put text back · world(): this panel's world letter · worlds(): the letters
//        · cycle(d): step the panel's world by d (its ^Tab) · agents(): live agents (for /go)
//        · newAgent(dir)?: the panel's own new-agent (else `hyprpi new` is run) }

export function parseCommand(text) {
  const t = String(text ?? "");
  if (!t.startsWith("/") || t.startsWith("//")) return null;
  const m = /^\/([^\s/]*)(?:\s+([\s\S]*))?$/.exec(t.trim());
  if (!m) return null;
  return { name: "/" + m[1].toLowerCase(), arg: (m[2] || "").trim() };
}

const tinkerNote = (r) => "🔧 " + (r.set ? `workshop is world ${r.set.workshop} now${r.set.previous ? " (was " + r.set.previous + ")" : ""} · ` : "")
  + (r.nothing ? "nothing to fix given" : r.queued ? `queued for the workshop (room ${r.room})${r.spawning ? ", opening an agent" : ""}` : `dropped off in the workshop (room ${r.room})`);

const PANELS = { agents: "the agents panel", room: "the Stream panel", search: "the search panel", board: "the projects panel" };
const here = new URL("../../mockups/", import.meta.url).pathname;
// Run a mockups/ helper detached (panel-here, hyprpi new), outside any agent's identity.
function detached(cmd, args, env = {}) {
  const e = { ...process.env, ...env }; delete e.HYPRPI_AGENT_ID;
  const p = spawn(cmd, args, { detached: true, stdio: "ignore", env: e }); p.on("error", () => {}); p.unref();
}
function goPanel(ctx, kind, extra = []) {
  if (ctx.panel === kind && !extra.length) { ctx.note(`this is ${PANELS[kind]}`); return; }
  detached(here + "panel-here", [kind, ctx.world?.() || "", ...extra]);
  ctx.note(`→ ${PANELS[kind]}${ctx.world?.() ? " " + ctx.world() : ""}`);
}

export function commonCommands(ctx) {
  return [
    { name: "/help", help: "this list", run: () => { ctx.showHelp(); } },
    // (/search is below: with words it also runs them; alone it just goes to the search panel)
    ...Object.keys(PANELS).filter((kind) => kind !== "search").map((kind) => ({ name: "/" + kind, help: `go to ${PANELS[kind]} for this world (open it here if it isn't open)`, run: () => goPanel(ctx, kind) })),
    { name: "/search", usage: "/search [WORDS]", help: "go to the Thoughts window for this world; with WORDS a /keyword search there",
      run: (arg) => goPanel(ctx, "search", arg ? ["--mode", "keyword", "--query", arg] : []) },
    { name: "/projects", help: "go to the projects panel for this world (the same as /board)", run: () => goPanel(ctx, "board") },
    { name: "/stream", help: "go to the Stream panel for this world (the same as /room; in the Stream, /stream filters it)", run: () => goPanel(ctx, "room") },
    { name: "/ai", usage: "/ai QUESTION", help: "ask about this world's history in the Thoughts window (/ask: an answer + the turns it cites)",
      run: (arg) => goPanel(ctx, "search", ["--mode", "ai", ...(arg ? ["--query", arg] : [])]) },
    // Thoughts (lib/thoughts.mjs): tell this world's own agent, Thoughts-<world>; the reply shows in
    // the search panel's 💭 Thoughts mode, which this brings here (or opens).
    { name: "/thought", usage: "/thought TEXT", help: "tell this world's Thoughts agent (the reply is in the Thoughts window, SUPER+ALT+/)",
      run: (arg) => {
        const a = ctx.api?.();
        if (arg && a) a.call("thoughts.send", { room: ctx.world?.() || "", text: arg }).catch((e) => ctx.note(`✗ ${e.message}`));
        else if (arg) { ctx.note("✗ daemon offline"); return; }
        goPanel(ctx, "search", ["--mode", "thoughts"]);
      } },
    // /digest: a summary of the Stream by project, written by Thoughts in the Thoughts window.
    { name: "/digest", usage: "/digest [@names…] [3h|today|since 9am] [words]", help: "Thoughts sums up the Stream by project (done · decided · waiting on you) in the Thoughts window; alone: since you last looked there",
      run: (arg) => { if (ctx.panel === "search") return; goPanel(ctx, "search", ["--mode", "digest", ...(arg ? ["--query", arg] : [])]); } },
    { name: "/ask", usage: "/ask QUESTION", help: "the same as /ai", run: (arg) => goPanel(ctx, "search", ["--mode", "ai", ...(arg ? ["--query", arg] : [])]) },
    {
      name: "/world", usage: "/world X", help: "switch this panel to world X (^Tab steps through them)",
      run: (arg) => {
        const ids = ctx.worlds?.() || [], cur = ctx.world?.() || "", want = arg.replace(/^@/, "").toUpperCase();
        if (!want) { ctx.note(`world ${cur} · worlds: ${ids.join(" ")} · /world X`); return; }
        if (!ids.includes(want)) { ctx.setBox?.(`/world ${arg}`); ctx.note(`✗ no world ${want} (worlds with agents or a board: ${ids.join(" ") || "none"})`); return; }
        if (want !== cur) ctx.cycle(ids.indexOf(want) - ids.indexOf(cur));
      },
    },
    {
      name: "/go", usage: "/go @Name", help: "jump to that agent's window, wherever it is (Tab completes the name; the same as Ctrl+click)",
      run: (arg, text) => {
        const api = ctx.api();
        if (!arg) { ctx.setBox?.("/go @"); ctx.note("/go @Name: Tab completes"); return; }
        const hit = agentIn(arg, ctx.agents?.() || []);
        if (!hit) { ctx.setBox?.(text); ctx.note(`✗ no live agent ${arg.startsWith("@") ? arg : "@" + arg}`); return; }
        if (!api) { ctx.setBox?.(text); ctx.note("✗ daemon offline"); return; }
        api.call("agent.focus", { agent: hit.id }).then(() => ctx.note(`→ @${hit.display}`)).catch((e) => ctx.note("✗ " + e.message));
      },
    },
    {
      name: "/new", usage: "/new [DIR]", help: "a new agent here (projects: /project on the board)",
      run: (arg) => {
        if (ctx.newAgent) { ctx.newAgent(arg); return; }
        const cwd = (arg || loadConfig().cwd || "~").replace(/^~(?=$|\/)/, process.env.HOME);
        detached(new URL("../../bin/hyprpi", import.meta.url).pathname, ["new", "--cwd", cwd]);
        ctx.note(`starting a new agent in ${cwd.replace(process.env.HOME, "~")} …`);
      },
    },
    {
      name: "/tinker", usage: "/tinker [W:] TEXT", help: "drop a friction fix off in the workshop world (one free agent there does it); W: sets the workshop to world W",
      run: (arg, text) => {
        if (!arg) { ctx.setBox?.("/tinker "); ctx.note("/tinker what to fix: it goes to a free agent in the workshop world"); return; }
        const api = ctx.api();
        if (!api) { ctx.setBox?.(text); ctx.note("✗ daemon offline"); return; }
        api.call("tinker", { text: arg, via: ctx.via || "panel" })
          .then((r) => ctx.note(tinkerNote(r)))
          .catch((e) => { ctx.setBox?.(text); ctx.note("✗ " + e.message); });
      },
    },
    { name: "/quit", help: "close this panel", run: () => { ctx.quit(); } },
  ];
}

export function createCommands({ commands = [], ctx }) {
  const list = [...commands];
  for (const c of commonCommands(ctx)) if (!list.some((x) => x.name === c.name)) list.push(c);
  const names = () => list.map((c) => c.name);
  const complete = (prefix) => names().filter((n) => n.startsWith(String(prefix || "").toLowerCase()));
  const find = (name) => list.find((c) => c.name === name) || (() => { const hs = complete(name); return hs.length === 1 ? list.find((c) => c.name === hs[0]) : null; })();

  function run(text) {
    const p = parseCommand(text);
    if (!p) return false;
    const c = find(p.name);
    if (!c) {
      const hs = complete(p.name);
      ctx.setBox?.(text);
      ctx.note(hs.length > 1 ? `which one? ${hs.join(" ")}` : `✗ unknown command ${p.name} · /help lists them · to say it instead, start with //`);
      return true;
    }
    c.run(p.arg, text);
    return true;
  }

  // Tab on "/partial" (nothing after it): one match completes it (+ a space); several: their
  // common prefix, or the next one if already at it; the matches go in the note.
  function tab(box) {
    const text = box.text;
    const go = /^(\/go\s+)@?(\S*)$/i.exec(text);
    if (go) { // "/go @Na" → the live agents' names
      const names = (ctx.agents?.() || []).map((a) => a.display).filter((n) => n.toLowerCase().startsWith(go[2].toLowerCase()));
      if (!names.length) { ctx.note(`no live agent @${go[2]}…`); return true; }
      if (names.length === 1) { box.set(`${go[1]}@${names[0]} `); ctx.note(""); return true; }
      let p = names[0]; while (!names.every((x) => x.toLowerCase().startsWith(p.toLowerCase()))) p = p.slice(0, -1);
      const i = names.findIndex((n) => n.toLowerCase() === go[2].toLowerCase());
      box.set(`${go[1]}@${p.length > go[2].length ? p : names[(i + 1) % names.length]}`); ctx.note(names.map((n) => "@" + n).join("  "));
      return true;
    }
    if (!/^\/[^\s/]*$/.test(text)) return false;
    const cs = complete(text);
    if (!cs.length) { ctx.note("no such command · /help"); return true; }
    if (cs.length === 1) { box.set(cs[0] + " "); ctx.note(""); return true; }
    let p = cs[0]; while (!cs.every((x) => x.startsWith(p))) p = p.slice(0, -1);
    box.set(p.length > text.length ? p : cs[(cs.indexOf(text) + 1) % cs.length]);
    ctx.note(cs.join(" · "));
    return true;
  }

  const help = () => list.map((c) => [c.usage || c.name, c.help || ""]);
  // What to show after "/partial" while typing it (null when the box isn't a partial command).
  const hint = (text) => /^\/[^\s/]*$/.test(String(text || "")) ? (() => { const cs = complete(text); return cs.length ? cs.join(" · ") + (cs.length === 1 ? "  (Tab)" : "") : "unknown command · /help"; })() : null;
  return { run, complete, tab, help, hint, names, list };
}

// A bottom command line: the prompt, the box's rows (at most a third of the panel, scrolled to
// keep the cursor in view) and the hint after the text, or on the rule above when it doesn't fit.
//   inputRows(box, { W, H, prompt, promptW, hint, width, clip, ruleColor })
//   -> { rows: [strings], ruleOverride: string|null, cursorRow (0-based within rows), cursorCol (1-based) }
export function inputRows(box, { W, H, prompt, promptW, hint = "", width, clip, rule }) {
  const L = box.layout(Math.max(10, W - promptW)), MAXI = Math.max(3, Math.min(10, Math.floor(H / 3)));
  const inTop = L.rows.length > MAXI ? Math.max(0, Math.min(L.cRow - MAXI + 1, L.rows.length - MAXI)) : 0;
  const inRows = L.rows.slice(inTop, inTop + MAXI);
  const fits = !hint || promptW + width(inRows[0] || "") + width(hint) <= W;
  let ruleOverride = null;
  if (!fits) { const h = clip(hint.replace(/^(\s|\x1b\[[0-9;]*m)+/, (m) => m.replace(/ /g, "")), W - 3); ruleOverride = rule(h); }
  const rows = inRows.map((l, i) => (i === 0 ? prompt : " ".repeat(promptW)) + l + (i === 0 && fits ? hint : ""));
  return { rows, ruleOverride, cursorRow: L.cRow - inTop, cursorCol: Math.min(W, promptW + L.cCol + 1) };
}
