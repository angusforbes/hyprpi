#!/usr/bin/env node
// J437 (from StateCheck437's repro): the phone server's upload log follows HYPRPI_STATE (else XDG_STATE_HOME,
// else HOME's ~/.local/state/hyprpi as before). Safe: every run uses a scratch HOME.
//   node test/phone-log-isolation.mjs     (exit 0 = pass)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
if (process.env.J437_CHILD) {
  const { filesRoutes } = await import(path.join(ROOT, "remote-control/files-routes.mjs"));
  const HOME = os.homedir(); // as server.mjs does
  const handle = filesRoutes({ HOME, UPLOAD_DIR: path.join(HOME, "Phone"), FILE_ROOTS: [], fileAllowed: () => false, refusedPart: () => false, underRoot: () => false,
    json: (res, status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); }, body: async () => ({}), log: () => {}, getApi: () => null, room: () => null });
  const server = http.createServer((req, res) => { handle(req, res, new URL(req.url, "http://localhost")).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    const { token } = await (await fetch(origin + "/api/files/token")).json();
    const r = await fetch(origin + "/api/upload", { method: "POST", headers: { origin, "x-upload-token": token, "x-batch": "independent437", "x-file-name": "scratch.txt" }, body: "J437 test upload." });
    console.log(JSON.stringify({ status: r.status, body: await r.text() }));
  } finally { server.close(); server.closeAllConnections(); }
  process.exit(0);
}
let fails = 0;
const ok = (c, what) => { console.log(`${c ? "PASS" : "FAIL"} ${what}`); if (!c) fails++; };
const run = (name, extra) => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), `j437p-${name}-`)), home = path.join(T, "home");
  fs.mkdirSync(home);
  const env = { ...process.env, J437_CHILD: "1", HOME: home, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, path.join(T, v)])) };
  for (const k of ["HYPRPI_STATE", "XDG_STATE_HOME"]) if (!(k in extra)) delete env[k];
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname], { env, encoding: "utf8", timeout: 20000 });
  const st = JSON.parse((r.stdout || "{}").trim().split("\n").pop() || "{}").status;
  const where = ["state/phone-uploads.log", "xdg/hyprpi/phone-uploads.log", "home/.local/state/hyprpi/phone-uploads.log"].filter((f) => fs.existsSync(path.join(T, f)));
  fs.rmSync(T, { recursive: true, force: true });
  return { st, where };
};
const a = run("both", { HYPRPI_STATE: "state", XDG_STATE_HOME: "xdg" });
ok(a.st === 200 && a.where.join() === "state/phone-uploads.log", `HYPRPI_STATE + XDG_STATE_HOME: the log is in HYPRPI_STATE (${a.where})`);
const b = run("state", { HYPRPI_STATE: "state" });
ok(b.st === 200 && b.where.join() === "state/phone-uploads.log", `HYPRPI_STATE only: in HYPRPI_STATE (${b.where})`);
const c = run("xdg", { XDG_STATE_HOME: "xdg" });
ok(c.st === 200 && c.where.join() === "xdg/hyprpi/phone-uploads.log", `XDG_STATE_HOME only: in XDG_STATE_HOME/hyprpi (${c.where})`);
const d = run("none", {});
ok(d.st === 200 && d.where.join() === "home/.local/state/hyprpi/phone-uploads.log", `neither (live): HOME's ~/.local/state/hyprpi, as before (${d.where})`);
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
