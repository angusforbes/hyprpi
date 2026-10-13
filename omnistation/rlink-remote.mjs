#!/usr/bin/env node
// omnistation/rlink-remote.mjs (J555): the REMOTE end of a world's panel link. omnistation/rlink.mjs on the laptop keeps one ssh to
// this machine (`remote.sh link`), and this carries every laptop panel's connection to this world's daemon over it, so the panels
// run on the laptop (instant typing, local clicks) with this daemon's data. Frames are JSON lines on stdin / stdout:
//   laptop → here:  {t:"o",c}            open channel c (a new connection to the daemon socket)
//                   {t:"d",c,l}          one line for the daemon on channel c (the daemon's own newline-JSON protocol)
//                   {t:"x",c}            close channel c
//                   {t:"p",ts}           keepalive ping (answered {t:"P",ts})
//                   {t:"u",c,id,name,data} upload: a pasted image (base64, at most 10 MB) written to ~/.hyprpi-<x>/clipboard/NAME
//                                        (600), answered {t:"ur",c,id,path} or {t:"ur",c,id,error}
//   here → laptop:  {t:"hi",v,home}      ready; {t:"d",c,l} a daemon line; {t:"x",c,e} channel c ended; {t:"P",ts} pong
// Only this world's daemon socket is ever connected; nothing a frame says is run. Stdin closing (the ssh ended) ends everything.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { socketPath } from "../lib/paths.mjs";

const SOCK = socketPath();
const ROOT = path.dirname(path.resolve(process.env.HYPRPI_STATE || ""));
if (!/\/\.hyprpi-[a-i]$/.test(ROOT)) { process.stdout.write(JSON.stringify({ t: "err", e: "not a remote world's folder" }) + "\n"); process.exit(2); }
const CLIP = path.join(ROOT, "clipboard");
const send = (o) => { try { process.stdout.write(JSON.stringify(o) + "\n"); } catch { /* the link is gone */ } };
const chans = new Map(); // c -> socket
const MAXC = 64;

function open(c) {
  if (chans.has(c) || chans.size >= MAXC) return send({ t: "x", c, e: chans.has(c) ? "already open" : "too many channels" });
  const s = net.createConnection(SOCK); chans.set(c, s); let buf = "";
  s.setEncoding("utf8");
  s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) send({ t: "d", c, l }); } });
  s.on("error", (e) => { if (chans.get(c) === s) { chans.delete(c); send({ t: "x", c, e: e.code || e.message }); } });
  s.on("close", () => { if (chans.get(c) === s) { chans.delete(c); send({ t: "x", c, e: "closed" }); } });
}
function upload(f) {
  const { c, id } = f;
  try {
    const name = String(f.name || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpe?g|webp|gif)$/i.test(name)) throw new Error("bad name");
    const buf = Buffer.from(String(f.data || ""), "base64");
    if (!buf.length || buf.length > 10e6) throw new Error("empty or over 10 MB");
    fs.mkdirSync(CLIP, { recursive: true, mode: 0o700 });
    const p = path.join(CLIP, name), tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, p);
    send({ t: "ur", c, id, path: p });
  } catch (e) { send({ t: "ur", c, id, error: e.message }); }
}

let inbuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  inbuf += d; let i;
  while ((i = inbuf.indexOf("\n")) >= 0) {
    const l = inbuf.slice(0, i); inbuf = inbuf.slice(i + 1);
    let f; try { f = JSON.parse(l); } catch { continue; }
    const c = Number(f.c);
    if (f.t === "p") { send({ t: "P", ts: f.ts }); continue; }
    if (!Number.isInteger(c) || c < 1) continue;
    if (f.t === "o") open(c);
    else if (f.t === "d") { const s = chans.get(c); if (s && typeof f.l === "string") s.write(f.l + "\n"); }
    else if (f.t === "x") { const s = chans.get(c); chans.delete(c); try { s?.end(); s?.destroy(); } catch { /* gone */ } }
    else if (f.t === "u") upload(f);
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
send({ t: "hi", v: 1, home: os.homedir() });
