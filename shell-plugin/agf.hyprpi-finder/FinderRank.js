.pragma library
// hyprpi (J17, Angus): typing ONE character that is a world letter ("D", any case) or a workspace
// number ("1": A1, B1, C1 …; "0": the 10th) lists the agents and projects there first, sorted by
// world, workspace, name, then most recent; then the usual matches (label or detail contains the
// query), in the order given. Any other query: the usual matches only, unchanged. Pure JS, shared by
// Menu.qml and the node tests (no Qt here).
//
//   rank(rows, query) -> indices into rows, in display order
//   rows: [{ label, detail, worlds ("DC": the worlds it is in), ws (workspace number, 0 = none),
//            home (the world letter of ws, "" = none), slot (1–10 within its world, 0 = none), name, recent (ms) }]
//
// J195 (Angus: "why a C agent is first … without even a 'd' in its name"): a world letter ranks in
// four groups. 1. what is ON that world's workspaces (home = the letter), by workspace, name, then
// most recent; 2. what belongs to that world but sits elsewhere (a board-D project whose writer is
// on C5; a D panel summoned to C3), by name; 3. names starting with the letter; 4. the other
// matches (label or detail contains it), in the order given. Before, groups 1 and 2 were one, sorted
// by workspace number, so "@orchestration · C5" (board D, writer on C5: ws 25) beat D1 (ws 31).

function matches(row, q) {
  return !q || String(row.label || "").toLowerCase().indexOf(q) >= 0 || String(row.detail || "").toLowerCase().indexOf(q) >= 0;
}

function rank(rows, query) {
  var q = String(query || "").trim().toLowerCase();
  var out = [], i;
  var world = /^[a-i]$/.test(q) ? q.toUpperCase() : "";
  var slot = /^[0-9]$/.test(q) ? (q === "0" ? 10 : Number(q)) : 0;
  if (!world && !slot) {
    for (i = 0; i < rows.length; i++) if (matches(rows[i], q)) out.push(i);
    return out;
  }
  var first = [], belongs = [], prefix = [];
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (world) {
      var onWs = r.ws > 0 && (r.home ? String(r.home) === world : String(r.worlds || "").indexOf(world) >= 0);
      if (onWs) first.push(i);
      else if (String(r.worlds || "").indexOf(world) >= 0) belongs.push(i);
      else if (String(r.name || "").toLowerCase().replace(/^[@>]/, "").indexOf(q) === 0) prefix.push(i);
      else if (matches(r, q)) out.push(i);
    } else if (r.ws > 0 && Number(r.slot || 0) === slot) first.push(i);
    else if (matches(r, q)) out.push(i);
  }
  first.sort(function (a, b) {
    var wa = rows[a].ws || 1e9, wb = rows[b].ws || 1e9; // world, then workspace (ws numbers run A1…A10, B1…); none: last
    if (wa !== wb) return wa - wb;
    var na = String(rows[a].name || rows[a].label || "").toLowerCase(), nb = String(rows[b].name || rows[b].label || "").toLowerCase();
    if (na < nb) return -1;
    if (na > nb) return 1;
    var ra = rows[a].recent || 0, rb = rows[b].recent || 0; // then most recent first
    if (ra !== rb) return rb - ra;
    return a - b;
  });
  belongs.sort(function (a, b) {
    var na = String(rows[a].name || rows[a].label || "").toLowerCase(), nb = String(rows[b].name || rows[b].label || "").toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : a - b;
  });
  return first.concat(belongs, prefix, out);
}

if (typeof module !== "undefined") module.exports = { rank: rank, matches: matches };
