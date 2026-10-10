#!/usr/bin/env node
// J368: offline tests for the agent-free gateway's fixed request types (docker/gateway/types.mjs). Temp folders only.
// Run: node docker/gateway/test-gateway.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-test-"));
const CFG = path.join(T, "cfg"), WORK = path.join(T, "Work"), ROLE = path.join(T, "Downloads");
fs.mkdirSync(CFG, { recursive: true }); fs.mkdirSync(path.join(WORK, "cube-art"), { recursive: true }); fs.mkdirSync(ROLE);
fs.writeFileSync(path.join(CFG, "config.json"), JSON.stringify({ projectFolders: [WORK], roleFolders: { downloads: ROLE } }));
fs.writeFileSync(path.join(WORK, "cube-art", "index.html"), "<h1>cube</h1>");
fs.writeFileSync(path.join(WORK, "cube-art", "notes.md"), "# notes\nline 2\n");
fs.writeFileSync(path.join(WORK, "cube-art", "run.sh"), "echo hi");
fs.writeFileSync(path.join(WORK, "cube-art", "big.pdf"), Buffer.alloc(21 << 20));
fs.writeFileSync(path.join(WORK, "cube-art", "id_rsa.txt"), "nope");
fs.writeFileSync(path.join(WORK, "cube-art", ".env"), "X=1");
fs.writeFileSync(path.join(T, "outside.md"), "outside the project folders");
fs.symlinkSync(path.join(T, "outside.md"), path.join(WORK, "cube-art", "link.md"));
fs.writeFileSync(path.join(ROLE, "paper.pdf"), "%PDF-1.4 tiny");

const G = await import("./types.mjs");
// J412 red team #2/#3: offline, deterministic DNS: a fake getent (names not listed fail to resolve, which now refuses)
const DNS = new Map([["unpkg.com", "104.16.0.1"], ["localhost.localdomain", "127.0.0.1"], ["example.org", "93.184.215.14"], ["flip.example.com", "93.184.215.15"]]);
G.resolver.ahosts = (h) => DNS.has(h) ? { ok: true, out: `${DNS.get(h)}  STREAM ${h}\n` } : { ok: false, out: "" };
import { execFileSync } from "node:child_process";
const require_mkfifo = (p) => execFileSync("mkfifo", [p]);
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok", n, name); };
let ctxN = 0; const ctx = (extra = {}) => ({ served: { name: `world-t${++ctxN}`, cfg: {} }, cfgDir: CFG, now: Date.now(), snapshotDir: path.join(T, "snaps"), ...extra });
const ok = (type, p, c = ctx()) => { const v = G.validate(type, p, c); assert.ok(v.ok, `${type}: ${v.error}`); return v; };
const bad = (type, p, re, c = ctx()) => { const v = G.validate(type, p, c); assert.ok(!v.ok, `${type} should be refused: ${JSON.stringify(p)}`); if (re) assert.match(v.error, re); };

// --- open_for_owner is retired (J402): a request for it gets "print the link instead"
await t("J402: an old held open_for_owner, approved, opens nothing and says print the link", async () => { const r = await G.run("open_for_owner", { what: "https://example.org/", kind: "link" }, { served: { name: "w" } }); assert.equal(r.ok, false); assert.match(r.outcome, /nothing was opened.*print the full link/); });
await t("J402: open_for_owner is refused with 'print the full link instead'", () => { bad("open_for_owner", { what: "https://example.org/", why: "x" }, /print the full link/); assert.ok(!("open_for_owner" in G.TYPES)); assert.match(G.UNSUPPORTED, /print its full link/); });
// --- note_to_owner
await t("note: passes, control characters stripped; oversized refused", () => { const v = ok("note_to_owner", { text: "hello\u202e there" }); assert.equal(v.params.text, "hello there"); bad("note_to_owner", { text: "x".repeat(1501) }, /1500/); bad("note_to_owner", { text: "" }); });
// --- share_project
await t("share: a real project folder passes; others refused", () => { const v = ok("share_project", { project: "cube-art", mode: "ro", why: "need it" }); assert.equal(v.params.path, path.join(WORK, "cube-art")); bad("share_project", { project: "../etc", why: "x" }); bad("share_project", { project: "nope", why: "x" }, /no folder/); bad("share_project", { project: "cube-art", mode: "x", why: "x" }, /mode/); });
// --- send_file
await t("send: a project or role file passes with its hash and a preview", () => { const v = ok("send_file", { path: `${WORK}/cube-art/notes.md`, why: "read it" }); assert.equal(v.params.sha256.length, 64); assert.match(v.show, /First 3 of 3 lines/); ok("send_file", { path: `${ROLE}/paper.pdf`, why: "x" }); });
await t("send: secrets, wrong types, symlinks, outside files refused", () => { bad("send_file", { path: `${WORK}/cube-art/id_rsa.txt`, why: "x" }, /secret/); bad("send_file", { path: `${WORK}/cube-art/run.sh`, why: "x" }, /isn't a type/); bad("send_file", { path: `${WORK}/cube-art/link.md`, why: "x" }, /symlink/); bad("send_file", { path: `${T}/outside.md`, why: "x" }, /project or role/); bad("send_file", { path: "relative.md", why: "x" }); });
// --- allow_host
await t("allow: a public domain passes; IPs, wildcards, ports, internal hosts refused", () => { assert.equal(ok("allow_host", { host: "Unpkg.com.", why: "three.js" }).params.host, "unpkg.com"); for (const host of ["10.0.0.1", "*.x.org", "x.org:443", "build.nvidia.com", "x", "a,b.org", "localhost", "foo.local"]) bad("allow_host", { host, why: "x" }); });
await t("unknown types and non-object params are refused", () => { bad("run_command", { cmd: "ls" }, /unknown request type/); bad("note_to_owner", "text"); });
await t("rate: per sandbox and type, per hour", () => { const c = { served: { name: "world-rate", cfg: {} }, cfgDir: CFG, now: 1e12 }; for (let i = 0; i < G.LIMITS.perHour.note_to_owner; i++) ok("note_to_owner", { text: "x" }, c); bad("note_to_owner", { text: "x" }, /an hour/, c); });

// --- run (handlers, with host actions stubbed)
const calls = [];
const rctx = { ...ctx(), putInbox: (name, buf) => { calls.push(["inbox", name, buf.length]); return `/inbox/${name}`; }, policyAllow: (h) => { calls.push(["allow", h]); return { ok: true, text: "rule added" }; }, addProject: async (p, m) => { calls.push(["share", p, m]); return { ok: true, text: "listed ro" }; } };
await t("run: send delivers the snapshot Angus saw, never re-reading the folder (review #1)", async () => {
  const v = ok("send_file", { path: `${WORK}/cube-art/notes.md`, why: "x" }); const before = fs.readFileSync(v.params.snapshot);
  fs.appendFileSync(`${WORK}/cube-art/notes.md`, "changed after approval was shown");
  let got = null; const r = await G.run("send_file", v.params, { ...rctx, putInbox: (n, b) => { got = b; return "/inbox/" + n; } });
  assert.ok(r.ok); assert.deepEqual(got, before);
  fs.writeFileSync(v.params.snapshot, "tampered"); const r2 = await G.run("send_file", v.params, rctx); assert.equal(r2.ok, false); assert.match(r2.outcome, /snapshot/);
});
await t("review #1: a FIFO or a symlink swapped in is refused without blocking", () => {
  const fifo = path.join(WORK, "cube-art", "pipe.txt"); require_mkfifo(fifo);
  bad("send_file", { path: fifo, why: "x" }, /not a regular file/);
  assert.match(G.pinnedRead(path.join(WORK, "cube-art", "link.md"), 1 << 20).error, /symlink/);
});
await t("review #4: a project name in two project folders is ambiguous", () => { const W2 = path.join(T, "Work2"); fs.mkdirSync(path.join(W2, "cube-art"), { recursive: true }); const c2 = path.join(T, "cfg2"); fs.mkdirSync(c2); fs.writeFileSync(path.join(c2, "config.json"), JSON.stringify({ projectFolders: [WORK, W2] })); bad("share_project", { project: "cube-art", why: "x" }, /ambiguous/, ctx({ cfgDir: c2 })); });
await t("red team J379: hard links, key-like content, private DNS answers refused; protected shares are read-only", () => {
  fs.writeFileSync(path.join(WORK, "cube-art", "readme2.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"); bad("send_file", { path: `${WORK}/cube-art/readme2.txt`, why: "x" }, /key or token/);
  fs.writeFileSync(path.join(WORK, "cube-art", "orig.txt"), "x"); fs.linkSync(path.join(WORK, "cube-art", "orig.txt"), path.join(WORK, "cube-art", "hard.txt")); bad("send_file", { path: `${WORK}/cube-art/hard.txt`, why: "x" }, /hard-linked/);
  bad("allow_host", { host: "localhost.localdomain", why: "x" });
  fs.mkdirSync(path.join(WORK, "secretproj")); fs.writeFileSync(path.join(CFG, "config.json"), JSON.stringify({ projectFolders: [WORK], roleFolders: { downloads: ROLE }, protected: [path.join(WORK, "secretproj")] }));
  const v = ok("share_project", { project: "secretproj", mode: "rw", why: "x" }); assert.equal(v.params.mode, "ro"); assert.match(v.show, /read-only is all/);
});
await t("red team J379 #2: a share runs only for the exact folder Angus saw", async () => { const v = ok("share_project", { project: "cube-art", mode: "ro", why: "x" }); fs.renameSync(path.join(WORK, "cube-art"), path.join(WORK, "cube-art-old")); fs.mkdirSync(path.join(WORK, "cube-art")); const r = await G.run("share_project", v.params, rctx); assert.equal(r.ok, false); assert.match(r.outcome, /no longer exactly/); fs.rmSync(path.join(WORK, "cube-art"), { recursive: true }); fs.renameSync(path.join(WORK, "cube-art-old"), path.join(WORK, "cube-art")); });
await t("J412 red team #3: a lookup failure or no address refuses (fail closed)", () => {
  bad("allow_host", { host: "nothing-here.example.net", why: "x" }, /couldn't be looked up/);
  const keep = G.resolver.ahosts; G.resolver.ahosts = () => ({ ok: true, out: "" }); try { bad("allow_host", { host: "unpkg.com", why: "x" }, /no address/); } finally { G.resolver.ahosts = keep; }
  G.resolver.ahosts = () => { throw new Error("getent missing"); }; try { bad("allow_host", { host: "unpkg.com", why: "x" }, /couldn't be looked up/); } finally { G.resolver.ahosts = keep; }
});
await t("J412 red team #2: the name is resolved again right before the rule; public at admission, loopback at decide: no rule", async () => {
  const v = ok("allow_host", { host: "flip.example.com", why: "x" }); let called = 0;
  DNS.set("flip.example.com", "127.0.0.1");
  const r = await G.run("allow_host", v.params, { ...rctx, policyAllow: async () => { called++; return { ok: true }; } });
  assert.equal(r.ok, false); assert.match(r.outcome, /private or local address.*checked again/); assert.equal(called, 0, "policyAllow never called");
  DNS.delete("flip.example.com"); const r2 = await G.run("allow_host", v.params, { ...rctx, policyAllow: async () => { called++; return { ok: true }; } });
  assert.equal(r2.ok, false); assert.match(r2.outcome, /couldn't be looked up/); assert.equal(called, 0);
});
await t("review #8: why is capped in bytes", () => bad("share_project", { project: "cube-art", why: "é".repeat(1000) }, /bytes/));
await t("run: allow and share call their host functions; note runs nothing", async () => { assert.ok((await G.run("allow_host", { host: "unpkg.com" }, rctx)).ok); assert.ok((await G.run("share_project", ok("share_project", { project: "cube-art", mode: "ro", why: "x" }).params, rctx)).ok); const before = calls.length; assert.match((await G.run("note_to_owner", { text: "x" }, rctx)).outcome, /read the note/); assert.equal(calls.length, before); });
await t("run: a handler error is a failed outcome, never a throw", async () => { const r = await G.run("share_project", ok("share_project", { project: "cube-art", mode: "ro", why: "x" }).params, { ...rctx, addProject: async () => { throw new Error("boom"); } }); assert.equal(r.ok, false); assert.match(r.outcome, /boom/); });

fs.rmSync(T, { recursive: true, force: true });
console.log(`all ${n} passed`);
