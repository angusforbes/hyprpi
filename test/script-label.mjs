// J660: quiet render labels for bash inline scripts (heredoc / interpreter -c/-e/-). Text only, no processes.
// Run: node test/script-label.mjs
import assert from "node:assert/strict";
import { scriptLabel } from "../pi-extension/script-label.ts";

const cases = [
  // W1: the case from flow-mode's window (heredoc body writes the file it read; the cp is a backup)
  ["cd ~/.pi/agent; cp mcp.json mcp.json.bak-J489-$(date +%Y%m%d-%H%M%S); python3 - <<'E'\nimport json\np='mcp.json'\nd=json.load(open(p))\nd['x']=1\nopen(p,'w').write(json.dumps(d))\nE", "changed ~/.pi/agent/mcp.json"],
  ["python3 - <<'EOF'\np='pi-extension/quiet.ts'; s=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF", "changed pi-extension/quiet.ts"],
  ["cd ~/Harness/.wt/j653 && python3 - <<'EOF'\np='README.md'; s=open(p).read()\nopen(p,'w').write(s)\nEOF\ngit add README.md", "changed ~/Harness/.wt/j653/README.md"],
  ["mkdir -p /tmp/j653 && cat > /tmp/j653/fake_mcp.py <<'EOF'\nprint('x > y')\nopen('nope','w')\nEOF", "changed /tmp/j653/fake_mcp.py"],
  ["cat > ~/notes/a.md <<'EOF'\nhello\nEOF", "changed ~/notes/a.md"],
  ["node -e \"require('fs').writeFileSync('/home/x/out.json', '{}')\"", "changed /home/x/out.json"],
  ["node - <<'EOF'\nconst fs=require('fs'); const f='cfg.json'; fs.writeFileSync(f, '{}'); fs.copyFileSync('a', '/etc/b')\nEOF", "changed cfg.json, /etc/b"],
  ["python3 -c \"from pathlib import Path; Path('~/x.txt').write_text('hi')\"", "changed ~/x.txt"],
  ["python3 - <<'EOF'\nimport shutil\nshutil.copy('a.txt', 'dir/b.txt')\nEOF", "changed dir/b.txt"],
  ["bash -c 'echo hi > /home/agf/out.log 2>&1'", "changed ~/out.log"],
  ["python3 - <<'EOF'\nfor p in ['a','b','c']:\n  open(p,'w').write('x')\nEOF", "ran a script that changed files"],
  // W2: nothing detectable
  ["python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['make','install'])\nEOF", "ran a script that changed files"],
  ["bash -c \"$CMD\"", "ran a script that changed files"],
  ["cp mcp.json mcp.json.bak; python3 - <<'E'\nimport os\nos.system('x')\nE", "changed mcp.json.bak"],
  // not inline scripts: unchanged quiet behaviour ("ran <first line>")
  ["git commit -am x", null],
  ["python3 manage.py migrate", null],
  ["echo hi > /tmp/x", null],
  ["sed -i 's/a/b/' f.txt", null],
];
let bad = 0;
for (const [cmd, want] of cases) {
  const got = scriptLabel(cmd);
  if (got !== want) { bad++; console.log(`FAIL ${JSON.stringify(cmd.slice(0, 70))}\n  want ${want}\n  got  ${got}`); }
}
// never the raw command start for an inline script
for (const [cmd] of cases) { const got = scriptLabel(cmd); if (got) assert.ok(!got.includes(cmd.split("\n")[0]), cmd); }
assert.equal(bad, 0);
console.log(`script-label: ${cases.length} ok`);
for (const [cmd, want] of [
  ['N="/home/x/Notes/System crash watch.md"; cat >> "$N" <<\'EOF\'\n- line\nEOF', "changed /home/x/Notes/System crash watch.md"],
  ["cd /tmp/j230 && python3 - <<'EOF'\ns=s.replace('fs.writeFile(window.__shl', 'x')\nEOF", "ran a script that changed files"],
]) assert.equal(scriptLabel(cmd), want, cmd);
console.log("script-label: extra ok");
// LabelCheck660's first-round repros (F-series)
for (const [cmd, want] of [
  ["bash -lc 'echo hi > /home/x/a.log'", "changed /home/x/a.log"],
  ["node --eval \"require('fs').writeFileSync('/home/x/b.json','{}')\"", "changed /home/x/b.json"],
  ["/usr/bin/python3 -c \"open('/home/x/c.txt','w').write('x')\"", "changed /home/x/c.txt"],
  ['git commit -m "handle <<EOF heredocs and node -e"', null],
  ["git commit -m 'python3 - is a script'", null],
  ["cd /a && python3 - <<'E'\nopen('f.txt','w')\nE\ncd /b", "changed /a/f.txt"],
  ["cd /a; python3 - <<'E'\nimport os\np = os.path.join('/etc', 'x.conf')\nopen(p,'w')\nE", "changed /etc/x.conf"],
  ["python3 - <<'E'\nimport os\np = os.path.join(base, 'x.conf')\nopen(p,'w')\nE", "ran a script that changed files"],
  ["bash -c 'echo \"a;b\" > /home/x/semi.txt'", "changed /home/x/semi.txt"],
  ["echo 'x; y' > /home/x/q.txt; python3 - <<'E'\nprint(1)\nE", "changed /home/x/q.txt"],
  ["python3 -c \"\nimport json\nopen('/home/x/m.json','w').write('{}')\n\"", "changed /home/x/m.json"],
  ["python3 - <<'E' > /home/x/out.txt 2>&1\nprint(1)\nE", "changed /home/x/out.txt"],
  ["", null],
  ["python3 -c \"unbalanced", "ran a script that changed files"],
]) assert.equal(scriptLabel(cmd), want, JSON.stringify(cmd));
{ const big = "python3 - <<'E'\n" + "x = 1\n".repeat(40000) + "open('/home/x/big.txt','w')\nE"; const t0 = performance.now(); for (let i = 0; i < 5; i++) scriptLabel(big); const ms = (performance.now() - t0) / 5; assert.ok(ms < 50, `slow: ${ms} ms`); console.log(`script-label: 240 KB command in ${ms.toFixed(1)} ms`); }
console.log("script-label: repros ok");
for (const [cmd, want] of [
  ["python3 - <<'E'\np='a.json'\nopen(p,'w')\np='b.json'\nopen(p,'w')\nE", "changed a.json, b.json"],
  ["node -e \"const p=path.join('/home/x', 'cfg.json'); fs.writeFileSync(p, '{}')\"", "changed /home/x/cfg.json"],
  ["bash -c 'echo hi > \"my;notes.txt\"'", "ran a script that changed files"],
  ["python3 -c 'from pathlib import Path\nPath(\"cfg.json\").write_text(\"{}\")'", "changed cfg.json"],
  ["cd /home/x/first; bash -c 'echo hi > a.txt'; cd /home/x/second; bash -c 'echo hi > b.txt'", "changed /home/x/first/a.txt, /home/x/second/b.txt"],
]) assert.equal(scriptLabel(cmd), want, JSON.stringify(cmd));
{ const c = "python3 - <<EOF\n# " + "open(".repeat(40000) + "\nEOF"; const t0 = performance.now(); scriptLabel(c); const ms = performance.now() - t0; assert.ok(ms < 100, `open( x40000: ${ms} ms`); console.log(`script-label: open( x40000 in ${ms.toFixed(1)} ms`); }
assert.equal(scriptLabel(`python3 -c"open('out.txt','w')"`), "changed out.txt");
console.log("script-label: round 2 ok");
