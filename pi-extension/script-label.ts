// J660 (Angus: "quiet-render label for a bash change that is a script shows the path it writes if detectable
// (changed ~/.pi/agent/mcp.json), else "ran a script that changed files", never the raw command start").
// scriptLabel(command) is null for a bash command that is not an inline script (quiet.ts keeps "ran <first line>"),
// else "changed <path>[, <path>][ +N more]" or "ran a script that changed files". Reads the text only, like bashKind.
import * as os from "node:os";

const INTERP = String.raw`(?:python[23]?(?:\.\d+)?|node|bun|deno|ruby|perl|php|bash|sh|zsh|dash|osascript|lua|tsx|ts-node)`;
const OPTS = String.raw`(?:\s+-[A-Za-z-]+)*?`;
const SCRIPT_OPT = String.raw`(?:-[A-Za-z]*[ceE]|--eval|--command|-)`;
// an inline script: a heredoc, `python3 -`, `node -e/--eval '…'`, `bash -c/-lc "…"`, `/usr/bin/python3 -c …`
const INLINE = new RegExp(String.raw`<<-?\s*['"]?[A-Za-z_]\w*|(?:^|[\s;&|(/])${INTERP}${OPTS}\s+${SCRIPT_OPT}(?=\s|$|['"])`, "m");
const BODY = new RegExp(String.raw`((?:^|[\s;&|(/])(${INTERP})${OPTS}\s+(?:-[A-Za-z]*[ceE]|--eval|--command)\s*)(?:'([^']*)'|"((?:[^"\\]|\\[\s\S])*)")`, "g");

// Quoted text with spaces is data (a commit message that mentions "<<EOF" or "node -e"), unless it is a -c/-e body.
const noData = (t: string) => t.replace(BODY, (_m, pre) => `${pre} X`).replace(/'[^'\n]*\s[^'\n]*'|"[^"\n]*\s[^"\n]*"/g, '""');
export function isInlineScript(command: string): boolean {
  const t = String(command ?? "");
  return t.length > 0 && INLINE.test(noData(t));
}

const isShell = (interp: string) => /^(?:bash|sh|zsh|dash)$/.test(interp);
type Ev = { shell?: string; code?: string };
// The command as events in order: shell lines, and code (heredoc bodies fed to an interpreter, -c/-e strings).
// Bodies of `cat > f <<EOF` are data: skipped. bash -c '…' and `bash <<EOF` bodies are more shell.
function events(command: string): Ev[] {
  const bodies: Array<{ interp: string; text: string }> = [];
  const t = command.replace(BODY, (_m, pre, interp, sq, dq) => { bodies.push({ interp, text: sq ?? (dq ?? "").replace(/\\(["\\$`])/g, "$1") }); return `${pre}\u0002${bodies.length - 1}\u0002`; });
  const out: Ev[] = [];
  const rows = t.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // in order: the shell text before a -c body, the body, the text after it (so `cd a; bash -c …; cd b` keeps its cwd)
    for (const part of row.split(/(\u0002\d+\u0002)/)) {
      const m = /^\u0002(\d+)\u0002$/.exec(part);
      if (!m) { if (part.trim()) out.push({ shell: part }); continue; }
      const b = bodies[+m[1]];
      out.push(isShell(b.interp) ? { shell: b.text.split("\n").join(" ; ") } : { code: b.text });
    }
    for (const d of [...row.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g)]) {
      const body: string[] = [];
      for (i++; i < rows.length; i++) {
        const r = d[1] ? rows[i].replace(/^\t+/, "") : rows[i];
        if (r.trim() === d[3]) break;
        body.push(rows[i]);
      }
      const last = row.slice(0, d.index).split(/[;&|]/).pop() ?? "";
      const it = new RegExp(String.raw`(?:^|[\s/])(${INTERP})\b`).exec(last);
      if (it) out.push(isShell(it[1]) ? { shell: body.join(" ; ") } : { code: body.join("\n") });
    }
  }
  return out;
}

const STR = String.raw`(?:'([^'\n]{1,300})'|"([^"\n]{1,300})"|\x60([^\x60\n]{1,300})\x60)`;
const s = (m: RegExpMatchArray, k = 1) => m[k] ?? m[k + 1] ?? m[k + 2];

function codeWrites(code: string): string[] {
  // name -> [position, value][] so a write uses the assignment in force at that point (p='a'; open(p); p='b'; open(p))
  const assigns = new Map<string, Array<[number, string | undefined]>>();
  const vars = { set: (k: string, v: string | undefined, at = 0) => { const l = assigns.get(k) ?? []; l.push([at, v]); assigns.set(k, l); }, delete: (k: string, at = 0) => vars.set(k, undefined, at) };
  let at = 0; // position of the match being resolved
  const lookup = (k: string) => { let v: string | undefined; for (const [pos, val] of assigns.get(k) ?? []) if (pos <= at) v = val; return v; };
  for (const m of code.matchAll(new RegExp(String.raw`(?:^|[\s;(,])(?:const |let |var )?([A-Za-z_]\w*)\s*=\s*(?:Path\(|os\.path\.expanduser\()?\s*` + STR + String.raw`\s*\)?\s*(?:$|[;\n,)])`, "gm"))) vars.set(m[1], s(m, 2), m.index);
  // x = path.join('a', 'b') / os.path.join(…) / Path('a') / 'b': only when every part is a literal
  for (const m of code.matchAll(/(?:^|[\s;(,])(?:const |let |var )?([A-Za-z_]\w*)\s*=\s*(?:path\.join|os\.path\.join|path\.resolve)\(([^)\n]{0,300})\)/gm)) {
    const parts = m[2].split(",").map((x) => x.trim());
    if (parts.every((x) => /^(['"])[^'"]*\1$/.test(x))) vars.set(m[1], parts.map((x) => x.slice(1, -1)).join("/").replace(/\/+/g, "/"), m.index);
    else vars.delete(m[1], m.index);
  }
  const arg = new RegExp(String.raw`\s*(?:` + STR + String.raw`|(?:Path\()?\s*([A-Za-z_]\w*))`);
  const target = (rest: string): string | undefined => {
    const m = rest.match(arg);
    if (!m) return;
    return s(m) ?? (m[4] ? lookup(m[4]) : undefined);
  };
  const found: string[] = [];
  const add = (p?: string) => { if (p) found.push(p); };
  const each = (re: RegExp, f: (m: RegExpMatchArray) => void) => { for (const m of code.matchAll(re)) { at = m.index ?? 0; f(m); } };
  // python open(x, 'w'/'a'/'x'/'r+'); Path(x).write_text/bytes; shutil.copy/move(src, dst); os.replace/rename(src, dst)
  each(/\bopen\(([^),\n]{0,300}),\s*(?:mode\s*=\s*)?['"]([^'"\n]*)['"]/g, (m) => { if (/[wax+]/.test(m[2])) add(target(m[1])); });
  each(/(?:Path\(([^)\n]{0,300})\)|\b([A-Za-z_]\w*))\.(?:write_text|write_bytes|touch|unlink)\(/g, (m) => { add(m[1] !== undefined ? target(m[1]) : lookup(m[2])); });
  each(/\b(?:shutil\.(?:copy2?|copyfile|move|copytree)|os\.(?:replace|rename))\(([^,\n]{1,300}),([^)\n]{1,300})\)/g, (m) => { add(target(m[2])); });
  each(/\bos\.(?:remove|unlink)\(([^)\n]{1,300})\)/g, (m) => { add(target(m[1])); });
  // node: fs.writeFileSync / appendFileSync / writeFile / copyFileSync(src, dst) / renameSync(src, dst) / rmSync / mkdirSync
  each(/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|rmSync|unlinkSync|createWriteStream)\(([^\n]{0,300})/g, (m) => { add(target(m[1])); });
  each(/\b(?:copyFileSync|renameSync|copyFile|rename|cpSync)\([^,\n]{1,300},([^)\n]{1,300})\)/g, (m) => { add(target(m[1])); });
  return found;
}

function unquote(t: string) { return t.replace(/^(['"])(.*)\1$/, "$2"); }
// split a shell line at ; && || | outside quotes
function segments(line: string): string[] {
  const hidden = line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/[;&|]/g, (c) => ({ ";": "\u0003", "&": "\u0004", "|": "\u0005" } as any)[c]));
  return hidden.split(/\s*(?:;|&&|\|\||\||(?<![>&<])&(?![>&\d]))\s*/).map((x) => x.replace(/\u0003/g, ";").replace(/\u0004/g, "&").replace(/\u0005/g, "|"));
}
type Shell = { cwd?: string; vars: Map<string, string> };
function shellLineWrites(line: string, st: Shell): string[] {
  const paths: string[] = [];
  const sub = (w: string) => w.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, v) => st.vars.get(v) ?? m);
  for (const seg of segments(line)) {
    const words = seg.trim().match(/(?:'[^']*'|"(?:[^"\\]|\\.)*"|\$\([^)]*\)|[^\s'"])+/g) ?? [];
    if (!words.length) continue;
    if (words[0] === "cd" && words[1]) { const d = sub(unquote(words[1])); st.cwd = /^[~/$]/.test(d) || !st.cwd ? d : `${st.cwd.replace(/\/$/, "")}/${d}`; continue; }
    const asg = /^([A-Za-z_]\w*)=(.+)$/.exec(words[0]);
    if (asg && words.length === 1) { st.vars.set(asg[1], sub(unquote(asg[2]))); continue; }
    while (words.length && /^(sudo|env|command|nohup|timeout|nice|[A-Za-z_]\w*=\S*|-\S+|\d+[smh]?)$/.test(words[0]) && words.length > 1) words.shift();
    for (let i = 0; i < words.length; i++) words[i] = sub(words[i]);
    for (let i = 0; i < words.length; i++) {
      const m = /^(?:\d?>>?|&>>?)(.*)$/.exec(words[i]);
      if (m && !/^&\d?$/.test(m[1])) { const t = m[1] || words[i + 1]; if (t && !t.startsWith("<")) paths.push(unquote(t)); }
    }
    const cmd = words[0].split("/").pop();
    const args = words.slice(1).filter((w) => !/^-/.test(w) && !/^[<>&\d]*[<>]/.test(w) && !/^\u0002/.test(w)).map(unquote);
    if (cmd === "tee") paths.push(...args);
    else if ((cmd === "cp" || cmd === "mv" || cmd === "install" || cmd === "ln") && args.length >= 2) paths.push(args[args.length - 1]);
    else if (cmd === "sed" && words.some((w) => /^-[a-zA-Z]*i/.test(w) || w === "--in-place") && args.length >= 2) paths.push(args[args.length - 1]);
    else if ((cmd === "touch" || cmd === "rm" || cmd === "truncate") && args.length) paths.push(...args);
  }
  return paths;
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

const clean = (p: string) => p.replace(/["']/g, "");
const usable = (p: string) => !!p && (/^[\w~./@+, :-]+$/.test(p) || /^\$\{?HOME\b/.test(p)) && !NOISE.test(p) && !/[$`]\(|\$\{?[A-Za-z_]/.test(p.replace(/^\$\{?HOME\}?/, ""));

export function scriptWrites(command: string): string[] {
  const st: Shell = { vars: new Map() };
  const all: string[] = [];
  for (const ev of events(String(command ?? ""))) {
    const found = ev.shell !== undefined ? shellLineWrites(ev.shell, st) : codeWrites(ev.code ?? "");
    for (const p of found.map(clean)) if (usable(p)) all.push(pretty(p, st.cwd)); // relative to the cwd at that point
  }
  const out = [...new Set(all)];
  // backups and scratch files only when nothing else was written
  const keep = out.filter((p) => !BACKUP.test(p));
  const main = keep.filter((p) => !TEMP.test(p));
  return main.length ? main : keep.length ? keep : out;
}

const MAX = 64_000; // longer commands: label from the first 64 KB (it runs on every render of a bash change)
export function scriptLabel(command: string): string | null {
  command = String(command ?? "");
  if (command.length > MAX) command = command.slice(0, MAX);
  if (!isInlineScript(command)) return null;
  const paths = scriptWrites(command);
  if (!paths.length) return "ran a script that changed files";
  const shown = paths.slice(0, 2).join(", ");
  return `changed ${shown}${paths.length > 2 ? ` +${paths.length - 2} more` : ""}`;
}
