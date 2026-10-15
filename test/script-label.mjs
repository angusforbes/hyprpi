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
