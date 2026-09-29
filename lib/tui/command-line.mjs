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
// Common commands (every panel). Kept to the ones that mean the same thing everywhere:
//   /help     this panel's commands and keys (the panel shows them: ctx.showHelp())
//   /tinker   /tinker [W:] TEXT: drop a friction fix off in the workshop world
//   /quit     close this panel
// ctx: { api(): the daemon connection or null · note(text) · render() · showHelp() · quit()
//        · via: the panel's name for the daemon ("agents-tui") · setBox(text): put text back }

export function parseCommand(text) {
  const t = String(text ?? "");
  if (!t.startsWith("/") || t.startsWith("//")) return null;
  const m = /^\/([^\s/]*)(?:\s+([\s\S]*))?$/.exec(t.trim());
  if (!m) return null;
  return { name: "/" + m[1].toLowerCase(), arg: (m[2] || "").trim() };
}

const tinkerNote = (r) => "🔧 " + (r.set ? `workshop is world ${r.set.workshop} now${r.set.previous ? " (was " + r.set.previous + ")" : ""} · ` : "")
  + (r.nothing ? "nothing to fix given" : r.queued ? `queued for the workshop (room ${r.room})${r.spawning ? ", opening an agent" : ""}` : `dropped off in the workshop (room ${r.room})`);

export function commonCommands(ctx) {
  return [
    { name: "/help", help: "this list", run: () => { ctx.showHelp(); } },
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
