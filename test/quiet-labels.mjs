// J660 + J637/J642: quiet render's change lines (pi-extension/quiet.ts changeLine), stub pi packages, text only.
// An inline bash script says what it changed; everything else renders exactly as before. Run: node test/quiet-labels.mjs
import assert from "node:assert/strict";
const STUB = "data:text/javascript," + encodeURIComponent("export class Container{}; export class Text{}; export const truncateToWidth=(s)=>s; export default {};");
const { register } = await import("node:module");
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, n) { if (s === "@earendil-works/pi-tui") return { url: ${JSON.stringify(STUB)}, shortCircuit: true }; return n(s, c); }`));
const { changeLine, bashKind, toolKind } = await import("../pi-extension/quiet.ts");
const old = (cmd) => `ran ${cmd.split("\n")[0].replace(/\s+/g, " ")}`;

// W1/W2: inline scripts
const mcp = "cd ~/.pi/agent; cp mcp.json mcp.json.bak-J489-$(date +%Y%m%d-%H%M%S); python3 - <<'E'\nimport json\np='mcp.json'\nd=json.load(open(p))\nopen(p,'w').write(json.dumps(d))\nE";
assert.equal(bashKind(mcp), "change");
assert.equal(changeLine("bash", { command: mcp }), "changed ~/.pi/agent/mcp.json");
const opaque = "python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['make','install'])\nEOF";
assert.equal(changeLine("bash", { command: opaque }), "ran a script that changed files");
assert.ok(!changeLine("bash", { command: mcp }).includes("cd ~/.pi/agent; cp"));

// W3: ordinary bash changes and other tools are unchanged
for (const cmd of ["git commit -am x", "rm -rf build", "echo hi > /tmp/x", "sed -i 's/a/b/' f.txt", "./deploy.sh", "systemctl --user restart foo", "python3 manage.py migrate", "cp a b && mv b c"])
  assert.equal(changeLine("bash", { command: cmd }), old(cmd), cmd);
assert.equal(changeLine("edit", { path: "/x/NOTES.md" }), "edited NOTES.md");
assert.equal(changeLine("write", { path: "/x/TODO.md" }), "wrote TODO.md");
assert.equal(changeLine("board_update", { project: "@x" }), "board_update @x");
assert.equal(toolKind("bash", { command: "ls -la" }), "lookup");
console.log("quiet-labels: ok");
