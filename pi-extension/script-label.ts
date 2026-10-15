// J660 (Angus: "quiet-render label for a bash change that is a script shows the path it writes if detectable
// (changed ~/.pi/agent/mcp.json), else "ran a script that changed files", never the raw command start").
// scriptLabel(command) is null for a bash command that is not an inline script (quiet.ts keeps "ran <first line>"),
// else "changed <path>[, <path>][ +N more]" or "ran a script that changed files". Reads the text only, like bashKind.
import * as os from "node:os";

const INTERP = String.raw`(?:python3?|node|bun|deno|ruby|perl|php|bash|sh|zsh|osascript|lua|tsx|ts-node)`;
// an inline script: a heredoc, `python3 -`, `node -e '…'`, `bash -c "…"`, `python3 -c …`
const INLINE = new RegExp(String.raw`<<-?\s*['"]?[A-Za-z_]\w*|(?:^|[\s;&|(])${INTERP}(?:\s+-[A-Za-z]+)*\s+(?:-[ceE]\b|-(?:\s|$))`, "m");

export function isInlineScript(command: string): boolean {
  return INLINE.test(String(command ?? ""));
}

type Split = { shell: string[]; code: string[] };
// Heredoc bodies and -c/-e strings are code; the rest is shell. Bodies of `cat > f <<EOF` are data: skipped.
function split(command: string): Split {
  const out: Split = { shell: [], code: [] };
  const rows = command.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    out.shell.push(row);
    const docs = [...row.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g)];
    for (const d of docs) {
      const body: string[] = [];
      for (i++; i < rows.length; i++) {
        const r = d[1] ? rows[i].replace(/^\t+/, "") : rows[i];
        if (r.trim() === d[3]) break;
        body.push(rows[i]);
      }
      const before = row.slice(0, d.index);
      const last = before.split(/[;&|]/).pop() ?? "";
      if (/(?:^|[\s/])(?:bash|sh|zsh)\b/.test(last)) out.shell.push(...body);
      else if (new RegExp(INTERP + String.raw`\b`).test(last)) out.code.push(body.join("\n"));
    }
  }
  const shellBodies: string[] = []; // bash -c '…' is more shell
  // -c / -e strings on shell lines are code too (their quotes are dropped from the shell text)
  out.shell = out.shell.map((line) => line.replace(new RegExp(String.raw`(${INTERP}(?:\s+-[A-Za-z]+)*\s+-[ceE]\s+)(['"])([\s\S]*?)\2`, "g"), (_m, pre, _q, body) => { (/^\s*(?:\S*\/)?(?:bash|sh|zsh)\b/.test(pre) ? shellBodies : out.code).push(body); return pre + "…"; }));
  out.shell.push(...shellBodies.flatMap((b) => b.split("\n")));
  return out;
}

const STR = String.raw`(?:'([^'\n]+)'|"([^"\n]+)"|\x60([^\x60\n]+)\x60)`;
const s = (m: RegExpMatchArray, k = 1) => m[k] ?? m[k + 1] ?? m[k + 2];

function codeWrites(code: string): string[] {
  const vars = new Map<string, string>();
  for (const m of code.matchAll(new RegExp(String.raw`(?:^|[\s;(,])(?:const |let |var )?([A-Za-z_]\w*)\s*=\s*(?:Path\(|path\.join\(|os\.path\.expanduser\()?\s*` + STR, "gm"))) vars.set(m[1], s(m, 2));
  const arg = new RegExp(String.raw`\s*(?:` + STR + String.raw`|(?:Path\()?\s*([A-Za-z_]\w*))`);
  const target = (rest: string): string | undefined => {
    const m = rest.match(arg);
    if (!m) return;
    return s(m) ?? (m[4] ? vars.get(m[4]) : undefined);
  };
  const found: string[] = [];
  const add = (p?: string) => { if (p) found.push(p); };
  // python open(x, 'w'/'a'/'x'/'r+'); Path(x).write_text/bytes; shutil.copy/move(src, dst); os.replace/rename(src, dst)
  for (const m of code.matchAll(/\bopen\(([^)\n]*?),\s*(?:mode\s*=\s*)?['"]([^'"]*)['"]/g)) if (/[wax+]/.test(m[2])) add(target(m[1]));
  for (const m of code.matchAll(/(?:Path\(([^)\n]*)\)|\b([A-Za-z_]\w*))\.(?:write_text|write_bytes|touch|unlink)\(/g)) add(m[1] !== undefined ? target(m[1]) : vars.get(m[2]));
  for (const m of code.matchAll(/\b(?:shutil\.(?:copy2?|copyfile|move|copytree)|os\.(?:replace|rename))\(([^,\n]+),([^)\n]+)\)/g)) add(target(m[2]));
  for (const m of code.matchAll(/\bos\.(?:remove|unlink)\(([^)\n]+)\)/g)) add(target(m[1]));
  // node: fs.writeFileSync / appendFileSync / writeFile / copyFileSync(src, dst) / renameSync(src, dst) / rmSync / mkdirSync
  for (const m of code.matchAll(/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|rmSync|unlinkSync|createWriteStream)\(([^\n]*)/g)) add(target(m[1]));
  for (const m of code.matchAll(/\b(?:copyFileSync|renameSync|copyFile|rename|cpSync)\([^,\n]+,([^)\n]+)\)/g)) add(target(m[1]));
  return found;
}

function unquote(t: string) { return t.replace(/^(['"])(.*)\1$/, "$2"); }
function shellWrites(lines: string[]): { paths: string[]; cwd?: string } {
  const paths: string[] = [];
  let cwd: string | undefined;
  const vars = new Map<string, string>(); // N="…"; cat >> "$N"
  const sub = (w: string) => w.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, v) => vars.get(v) ?? m);
  for (const raw of lines) {
    // drop quoted text that isn't a whole word (messages, -m "…"), keep quoted paths after > and as arguments
    for (const seg of raw.split(/\s*(?:;|&&|\|\||\|)\s*/)) {
      const words = seg.trim().match(/(?:'[^']*'|"[^"]*"|\$\([^)]*\)|[^\s'"])+/g) ?? [];
      if (!words.length) continue;
      if (words[0] === "cd" && words[1]) { cwd = sub(unquote(words[1])); continue; }
      const asg = /^([A-Za-z_]\w*)=(.+)$/.exec(words[0]);
      if (asg && words.length === 1) { vars.set(asg[1], sub(unquote(asg[2]))); continue; }
      for (let i = 0; i < words.length; i++) words[i] = sub(words[i]);
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const m = /^(?:\d?>>?|&>>?)(.*)$/.exec(w);
        if (m && !/^&\d?$/.test(m[1])) { const t = m[1] || words[i + 1]; if (t && !t.startsWith("<")) paths.push(unquote(t)); }
      }
      const cmd = words[0].split("/").pop();
      const args = words.slice(1).filter((w) => !/^-/.test(w) && !/^[<>&\d]*[<>]/.test(w)).map(unquote);
      if (cmd === "tee") paths.push(...args);
      else if ((cmd === "cp" || cmd === "mv" || cmd === "install" || cmd === "ln") && args.length >= 2) paths.push(args[args.length - 1]);
      else if (cmd === "sed" && words.some((w) => /^-[a-zA-Z]*i/.test(w) || w === "--in-place") && args.length >= 2) paths.push(args[args.length - 1]);
      else if ((cmd === "touch" || cmd === "rm" || cmd === "truncate") && args.length) paths.push(...args);
    }
  }
  return { paths, cwd };
}

const HOME = os.homedir();
function pretty(p: string, cwd?: string): string {
  let q = p.replace(/^\$HOME(?=\/|$)/, "~").replace(/^\$\{HOME\}(?=\/|$)/, "~").replace(/^os\.homedir\(\)/, "~");
  if (q.startsWith(HOME + "/") || q === HOME) q = "~" + q.slice(HOME.length);
  if (cwd && !/^[~/$]/.test(q)) {
    let c = cwd.replace(/^\$HOME(?=\/|$)/, "~");
    if (c.startsWith(HOME + "/") || c === HOME) c = "~" + c.slice(HOME.length);
    if (/^[~/]/.test(c)) q = `${c.replace(/\/$/, "")}/${q.replace(/^\.\//, "")}`;
  }
  return q;
}

const NOISE = /^\/dev\/(null|std(err|out))$|^&|^\d$/;
const BACKUP = /\.(bak|orig|old)\b|[-.]bak[-.]|backup|~$/i;
const TEMP = /^\/tmp\/|^\/run\/user\//;

export function scriptWrites(command: string): string[] {
  const { shell, code } = split(String(command ?? ""));
  const sh = shellWrites(shell);
  const all = [...code.flatMap(codeWrites), ...sh.paths].map((p) => p.replace(/["']/g, "")).filter((p) => /^[\w~./@+, :-]+$/.test(p) || /^\$\{?HOME\b/.test(p)).filter((p) => p && !NOISE.test(p) && !/[$`]\(|\$\{?[A-Za-z_]/.test(p.replace(/^\$\{?HOME\}?/, "")));
  const seen = new Set<string>(), out: string[] = [];
  for (const p of all.map((x) => pretty(x, sh.cwd))) if (!seen.has(p)) { seen.add(p); out.push(p); }
  // backups and scratch files only when nothing else was written
  const main = out.filter((p) => !BACKUP.test(p) && !TEMP.test(p));
  return main.length ? main : out.filter((p) => !BACKUP.test(p)).length ? out.filter((p) => !BACKUP.test(p)) : out;
}

export function scriptLabel(command: string): string | null {
  if (!isInlineScript(command)) return null;
  const paths = scriptWrites(command);
  if (!paths.length) return "ran a script that changed files";
  const shown = paths.slice(0, 2).join(", ");
  return `changed ${shown}${paths.length > 2 ? ` +${paths.length - 2} more` : ""}`;
}
