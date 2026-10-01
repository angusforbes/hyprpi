.pragma library
// hyprpi (J17, Angus): typing ONE letter that is a world ("D", any case) lists that world's agents
// and projects first, by workspace then name, even when their text doesn't contain the letter;
// then the usual matches (label or detail contains the query), in the order given. Any other query:
// the usual matches only, unchanged. Pure JS, shared by Menu.qml and the node tests (no Qt here).
//
//   rank(rows, query) -> indices into rows, in display order
//   rows: [{ label, detail, worlds ("DC": the worlds it is in), ws (workspace number, 0 = none), name }]

function matches(row, q) {
  return !q || String(row.label || "").toLowerCase().indexOf(q) >= 0 || String(row.detail || "").toLowerCase().indexOf(q) >= 0;
}

function rank(rows, query) {
  var q = String(query || "").trim().toLowerCase();
  var out = [], i;
  var world = /^[a-i]$/.test(q) ? q.toUpperCase() : "";
  if (!world) {
    for (i = 0; i < rows.length; i++) if (matches(rows[i], q)) out.push(i);
    return out;
  }
  var first = [];
  for (i = 0; i < rows.length; i++) {
    if (String(rows[i].worlds || "").indexOf(world) >= 0) first.push(i);
    else if (matches(rows[i], q)) out.push(i);
  }
  first.sort(function (a, b) {
    var wa = rows[a].ws || 1e9, wb = rows[b].ws || 1e9; // no workspace: after the ones with one
    if (wa !== wb) return wa - wb;
    var na = String(rows[a].name || rows[a].label || "").toLowerCase(), nb = String(rows[b].name || rows[b].label || "").toLowerCase();
    if (na < nb) return -1;
    if (na > nb) return 1;
    return a - b;
  });
  return first.concat(out);
}

if (typeof module !== "undefined") module.exports = { rank: rank, matches: matches };
