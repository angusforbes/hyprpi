// The project board (docs/board-plan.md): one board per world (room), several projects each.
// Pure data + operations; the daemon wires them to agents, sounds (ding) and panels.
//
// ~/.local/state/hyprpi/boards/<room>.json   the board (rewritten on every change)
// ~/.local/state/hyprpi/boards/<room>.log.jsonl  append-only change log (nothing erased is lost)
//
// A project (card):
//   { id: "p-7k2m", name: "boards" (the @slug), title, status: new|active|paused|archived,
//     members: [agentId], writer: agentId, created, updated, by,
//     where: { text, by, ts }, next_step: { text, by, ts }, seq: { D, N, H },
//     items: [{ h: "D1", sec: "decide"|"next"|"heard"|"done", text, by: { id, name }, ts, updated,
//               options: [{ key: "a", text }], recommend: "a", default: "a",   (decide)
//               prio (heard; higher = more important), verified (done),
//               was: "decide"|"next"|"heard" (done: the section it came from), resolution }] }
// Handles: section letter + number (D decide, N next, H heard), never reused; an item keeps its
// handle when it is edited or done (Done shows N2 as N2).
import fs from "node:fs";
import path from "node:path";

export const SECTIONS = ["decide", "next", "heard", "done"];
const LETTER = { decide: "D", next: "N", heard: "H" };
const SLUG = /^[a-z0-9][a-z0-9_-]{1,39}$/;
export const slugify = (s) => String(s || "").trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export function createBoards({ dir, log = () => {}, onChange = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const boards = new Map(); // room -> { room, projects: [] }
  const file = (room) => path.join(dir, `${room}.json`);
  function load(room) {
    let b = boards.get(room);
    if (b) return b;
    try { b = JSON.parse(fs.readFileSync(file(room), "utf8")); } catch { b = null; }
    if (!b || !Array.isArray(b.projects)) b = { room, projects: [] };
    b.room = room;
    boards.set(room, b);
    return b;
  }
  // Every board on disk (for name uniqueness and lookups across worlds).
  function all() {
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) load(f.slice(0, -5));
    return [...boards.values()];
  }
  // A failed write throws (the caller sees the error) instead of looking like it worked.
  function save(b, change) {
    try {
      fs.writeFileSync(file(b.room) + ".tmp", JSON.stringify(b));
      fs.renameSync(file(b.room) + ".tmp", file(b.room));
    } catch (e) { log("board save failed:", e.message); boards.delete(b.room); throw new Error(`board ${b.room} could not be saved: ${e.message}`); }
    try { if (change) fs.appendFileSync(path.join(dir, `${b.room}.log.jsonl`), JSON.stringify({ ts: Date.now(), room: b.room, ...change }) + "\n"); }
    catch (e) { log("board log append failed:", e.message); }
    onChange(b, change);
  }
  const newId = () => "p-" + Math.random().toString(36).slice(2, 6);

  // Find a project by id or @name, on any board (room given = prefer that board).
  function find(ref, room = null) {
    const key = String(ref || "").trim().replace(/^@/, "").toLowerCase();
    if (!key) return null;
    const order = room ? [load(room), ...all().filter((b) => b.room !== room)] : all();
    for (const b of order) for (const p of b.projects) if (p.id === key || p.name === key) return { board: b, project: p };
    return null;
  }
  function must(ref, room) {
    const f = room ? find(ref, room) : find(ref);
    if (f && room && f.board.room !== room) throw new Error(`@${f.project.name} is on board ${f.board.room}, not ${room}`);
    if (!f) throw new Error(`no project @${String(ref || "").replace(/^@/, "")}${room ? ` (board ${room})` : ""}`);
    return f;
  }
  const touch = (p, by) => { p.updated = Date.now(); if (by) p.lastBy = by; };

  return {
    load, all, find, must,
    changes(room, limit = 50, project = null) {
      try {
        const lines = fs.readFileSync(path.join(dir, `${room}.log.jsonl`), "utf8").trim().split("\n");
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
          try { const c = JSON.parse(lines[i]); if (!project || c.project === project) out.push(c); } catch { /* skip */ }
        }
        return out;
      } catch { return []; }
    },

    // nameTaken(name) -> true if an agent uses it (the daemon checks live agents).
    create(room, { name, title = "", members = [], by, status = "active" }, nameTaken = () => false) {
      const slug = slugify(name);
      if (!SLUG.test(slug)) throw new Error("project name: 2-40 letters, digits, - or _ (e.g. boards)");
      if (find(slug)) throw new Error(`@${slug} is already a project`);
      if (nameTaken(slug)) throw new Error(`@${slug} is an agent's name; pick another project name`);
      const b = load(room), now = Date.now();
      let id; do id = newId(); while (find(id));
      const p = { id, name: slug, title: String(title || "").slice(0, 200), status, members: [...new Set(members)], writer: members[0] || "",
        created: now, updated: now, by: by?.name || "", where: null, next_step: null, seq: { D: 0, N: 0, H: 0 }, items: [] };
      b.projects.push(p);
      save(b, { project: id, op: "create", by: by?.name || "", text: `@${slug}${title ? " — " + title : ""}` });
      return p;
    },
    update(ref, room, { name, title, status, writer, where, next_step }, by, nameTaken = () => false) {
      const { board: b, project: p } = must(ref, room);
      const said = [];
      if (name != null) {
        const slug = slugify(name);
        if (!SLUG.test(slug)) throw new Error("project name: 2-40 letters, digits, - or _");
        if (slug !== p.name) {
          if (find(slug)) throw new Error(`@${slug} is already a project`);
          if (nameTaken(slug)) throw new Error(`@${slug} is an agent's name`);
          said.push(`renamed @${p.name} → @${slug}`); p.name = slug;
        }
      }
      if (title != null) { p.title = String(title).slice(0, 200); said.push("title"); }
      if (status != null) {
        if (!["new", "active", "paused", "archived"].includes(status)) throw new Error("status: new, active, paused or archived");
        p.status = status; said.push(`status ${status}`);
      }
      if (writer != null) { if (!p.members.includes(writer)) throw new Error("the writer must be a member"); p.writer = writer; said.push("writer"); }
      if (where != null) { p.where = { text: String(where).slice(0, 600), by: by?.name || "", ts: Date.now() }; said.push("where"); }
      if (next_step != null) { p.next_step = { text: String(next_step).slice(0, 600), by: by?.name || "", ts: Date.now() }; said.push("next step"); }
      if (p.status === "new" && by?.human) p.status = "active";
      touch(p, by?.name);
      save(b, { project: p.id, op: "update", by: by?.name || "", text: said.join(", ") });
      return p;
    },
    // Membership. Leaving is the daemon's job to announce (hand-off note to the rest).
    join(ref, room, agentId, by) {
      const { board: b, project: p } = must(ref, room);
      if (p.members.includes(agentId)) return p; // already a member: nothing to log
      p.members.push(agentId);
      if (!p.writer) p.writer = agentId;
      touch(p, by?.name);
      save(b, { project: p.id, op: "join", by: by?.name || "", text: by?.who || agentId });
      return p;
    },
    leave(ref, room, agentId, by) {
      const { board: b, project: p } = must(ref, room);
      p.members = p.members.filter((x) => x !== agentId);
      if (p.writer === agentId) p.writer = p.members[0] || "";
      touch(p, by?.name);
      save(b, { project: p.id, op: "leave", by: by?.name || "", text: by?.who || agentId });
      return p;
    },
    remove(ref, room, by) { // merge helper / mistakes: the log keeps it
      const { board: b, project: p } = must(ref, room);
      b.projects = b.projects.filter((x) => x !== p);
      save(b, { project: p.id, op: "remove", by: by?.name || "", text: `@${p.name}` });
      return p;
    },
    // Move a card to another world's board (spin-out; pi·ze03's board.moveCard hook).
    move(ref, fromRoom, toRoom, by) {
      const { board: b, project: p } = must(ref, fromRoom);
      const to = load(toRoom);
      if (to === b) return p;
      // Destination first: a crash in between leaves the card on both boards (a duplicate
      // to clean up), never on neither.
      to.projects.push(p); touch(p, by?.name);
      save(to, { project: p.id, op: "moved-in", by: by?.name || "", text: `← board ${b.room}` });
      b.projects = b.projects.filter((x) => x !== p);
      save(b, { project: p.id, op: "moved-out", by: by?.name || "", text: `→ board ${toRoom}` });
      return p;
    },

    // Move one item to another project on the same board (split / merge). It gets the next
    // handle of its section there (handles are per project); the old handle is kept as `from`.
    transferItem(fromRef, toRef, room, h, by) {
      const { board: b, project: p } = must(fromRef, room), { project: q } = must(toRef, room);
      const it = p.items.find((x) => x.h.toLowerCase() === String(h).toLowerCase());
      if (!it) throw new Error(`no item ${h} on @${p.name}`);
      const letter = it.h.replace(/\d+$/, "") || "N";
      q.seq[letter] = (q.seq[letter] || 0) + 1;
      const moved = { ...it, h: letter + q.seq[letter], from: `@${p.name} ${it.h}`, updated: Date.now() };
      p.items = p.items.filter((x) => x !== it); q.items.push(moved);
      touch(p, by?.name); touch(q, by?.name);
      save(b, { project: p.id, op: "item-out", h: it.h, by: by?.name || "", text: `→ @${q.name} ${moved.h}` });
      save(b, { project: q.id, op: "item-in", h: moved.h, by: by?.name || "", text: `← @${p.name} ${it.h}: ${it.text}` });
      return { from: it.h, to: moved.h, item: moved };
    },

    // Items.
    addItem(ref, room, { section, text, options, recommend, default: dflt, prio, verified }, by) {
      const { board: b, project: p } = must(ref, room);
      if (!["decide", "next", "heard", "done"].includes(section)) throw new Error("section: decide, next, heard or done");
      const t = String(text || "").trim();
      if (!t) throw new Error("empty item");
      const letter = LETTER[section] || "N"; // an item added straight to done counts as a next
      p.seq[letter] = (p.seq[letter] || 0) + 1;
      const it = { h: letter + p.seq[letter], sec: section, text: t.slice(0, 2000), by: { id: by?.id || "", name: by?.name || "" }, ts: Date.now(), updated: Date.now() };
      if (section === "done") { it.was = "next"; if (verified) it.verified = String(verified).slice(0, 400); }
      if (section === "decide") {
        const opts = (Array.isArray(options) ? options : []).map((o, i) => typeof o === "string" ? { key: String.fromCharCode(97 + i), text: o } : { key: String(o.key || String.fromCharCode(97 + i)).toLowerCase(), text: String(o.text || "") }).filter((o) => o.text);
        if (opts.length) it.options = opts;
        if (recommend) it.recommend = String(recommend).toLowerCase();
        if (dflt) it.default = String(dflt).toLowerCase();
      }
      if (section === "heard") it.prio = Number(prio) || 0;
      p.items.push(it); touch(p, by?.name);
      if (p.status === "new" && by?.human) p.status = "active";
      save(b, { project: p.id, op: "add", h: it.h, by: by?.name || "", text: `${section}: ${t}` });
      return { project: p, item: it };
    },
    editItem(ref, room, h, { text, options, recommend, default: dflt, prio, verified }, by) {
      const { board: b, project: p } = must(ref, room);
      const it = p.items.find((x) => x.h.toLowerCase() === String(h).toLowerCase());
      if (!it) throw new Error(`no item ${h} on @${p.name}`);
      if (text != null) it.text = String(text).slice(0, 2000);
      if (Array.isArray(options)) it.options = options.map((o, i) => typeof o === "string" ? { key: String.fromCharCode(97 + i), text: o } : { key: String(o.key || String.fromCharCode(97 + i)).toLowerCase(), text: String(o.text || "") });
      if (recommend != null) it.recommend = String(recommend).toLowerCase();
      if (dflt != null) it.default = String(dflt).toLowerCase();
      if (prio != null) it.prio = Number(prio) || 0;
      if (verified != null) it.verified = String(verified).slice(0, 400);
      it.updated = Date.now(); touch(p, by?.name);
      save(b, { project: p.id, op: "edit", h: it.h, by: by?.name || "", text: it.text });
      return { project: p, item: it };
    },
    // Done (with how it was verified), or a decision resolved (resolution = the answer).
    doneItem(ref, room, h, { verified, resolution } = {}, by) {
      const { board: b, project: p } = must(ref, room);
      const it = p.items.find((x) => x.h.toLowerCase() === String(h).toLowerCase());
      if (!it) throw new Error(`no item ${h} on @${p.name}`);
      if (it.sec === "done" && !verified && !resolution) throw new Error(`${it.h} is already done (add how it was verified to update that)`);
      if (it.sec !== "done") { it.was = it.sec; it.sec = "done"; }
      if (verified) it.verified = String(verified).slice(0, 400);
      if (resolution) it.resolution = String(resolution).slice(0, 600);
      it.updated = Date.now(); touch(p, by?.name);
      save(b, { project: p.id, op: resolution ? "decided" : "done", h: it.h, by: by?.name || "", text: resolution || verified || it.text });
      return { project: p, item: it };
    },
    dropItem(ref, room, h, by) {
      const { board: b, project: p } = must(ref, room);
      const it = p.items.find((x) => x.h.toLowerCase() === String(h).toLowerCase());
      if (!it) throw new Error(`no item ${h} on @${p.name}`);
      p.items = p.items.filter((x) => x !== it); touch(p, by?.name);
      // Kept for undo (restoreItem): the last 20 dropped items of this project.
      (p.dropped ||= []).push({ ...it, droppedAt: Date.now(), droppedBy: by?.name || "" });
      if (p.dropped.length > 20) p.dropped.splice(0, p.dropped.length - 20);
      save(b, { project: p.id, op: "drop", h: it.h, by: by?.name || "", text: it.text });
      return { project: p, item: it };
    },
    // Undo a drop: the given handle, else the most recently dropped item. Same handle.
    restoreItem(ref, room, h, by) {
      const { board: b, project: p } = must(ref, room);
      const list = p.dropped || [];
      const i = h ? list.findLastIndex((x) => x.h.toLowerCase() === String(h).toLowerCase()) : list.length - 1;
      if (i < 0) throw new Error(h ? `no dropped item ${h} on @${p.name}` : `nothing dropped on @${p.name}`);
      const [d] = list.splice(i, 1);
      if (p.items.some((x) => x.h === d.h)) throw new Error(`${d.h} is already on @${p.name}`);
      const { droppedAt, droppedBy, ...it } = d;
      it.updated = Date.now(); p.items.push(it); touch(p, by?.name);
      save(b, { project: p.id, op: "restore", h: it.h, by: by?.name || "", text: it.text });
      return { project: p, item: it };
    },
    // Angus looked at the card (for "since you left").
    seen(ref, room) {
      const f = find(ref, room); if (!f) return null;
      f.project.seenAt = Date.now();
      save(f.board, null);
      return f.project;
    },
  };
}

// The board as text, for agents (board_read) and the CLI. names: agentId -> display name.
export function boardText(b, names = (id) => id, { project = null } = {}) {
  const ps = b.projects.filter((p) => (!project || p.id === project.id) && p.status !== "archived");
  if (!ps.length) return `Board ${b.room}: no projects yet.`;
  const out = [`Board ${b.room}`];
  const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  for (const p of ps) {
    out.push("", `@${p.name}${p.title ? " — " + p.title : ""} [${p.status}] id ${p.id} · writer ${p.writer ? "@" + names(p.writer) : "none"} · members ${p.members.map((m) => "@" + names(m)).join(" ") || "none (⚠ nobody on it)"}`);
    if (p.where) out.push(`  Where: ${p.where.text} (${p.where.by}, ${ago(p.where.ts)} ago)`);
    if (p.next_step) out.push(`  Next first step: ${p.next_step.text}`);
    for (const sec of SECTIONS) {
      let items = p.items.filter((it) => it.sec === sec);
      if (sec === "heard") items = items.sort((x, y) => (y.prio || 0) - (x.prio || 0) || x.ts - y.ts);
      if (sec === "done") items = items.slice(-8);
      if (!items.length) continue;
      out.push(`  ${sec[0].toUpperCase() + sec.slice(1)}:`);
      for (const it of items) {
        let line = `    ${it.h} ${it.text}`;
        if (it.options) line += " — " + it.options.map((o) => `${o.key}) ${o.text}${o.key === it.recommend ? " (recommended)" : ""}`).join(" · ") + (it.default ? ` · default ${it.default}` : "");
        if (sec === "heard" && it.prio) line += ` [prio ${it.prio}]`;
        if (it.resolution) line += ` → decided: ${it.resolution}`;
        if (it.verified) line += ` ✓ verified: ${it.verified}`;
        out.push(line + ` (${it.by?.name || "?"}, ${ago(it.updated || it.ts)} ago)`);
      }
    }
  }
  return out.join("\n");
}
