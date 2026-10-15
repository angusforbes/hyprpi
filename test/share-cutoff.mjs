#!/usr/bin/env node
// J663 (no silent success, Angus's 38a): the phone app's Share (remote-control/share.mjs loadBlob) never hands a file that arrived
// cut short to the iOS share sheet as if it were the whole file. A stand-in fetch serves a body that ends before its Content-Length
// (a dropped connection), one that errors mid-way, and a whole one. Pure module test: no server, no browser, no processes.
//   node test/run.mjs test/share-cutoff.mjs   (exit 0 = pass)
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const { loadBlob } = await import("../remote-control/share.mjs");
const body = (chunks, { error = false } = {}) => new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); if (error) c.error(new Error("network connection was lost")); else c.close(); } });
const serve = (chunks, length, opts = {}) => { globalThis.fetch = async () => new Response(body(chunks, opts), { status: 200, headers: { "content-type": "video/mp4", ...(length != null ? { "content-length": String(length) } : {}), ...(opts.enc ? { "content-encoding": opts.enc } : {}) } }); };
const seen = [];
// 1. cut short: 2 of 3 chunks, Content-Length says 3000
serve([Array(1000).fill(1), Array(1000).fill(2)], 3000);
let r = await loadBlob("/file?path=x.mp4", { onProgress: (g, t) => seen.push([g, t]) }).then((b) => ({ b }), (e) => ({ e }));
ok("a body that ends short of its Content-Length: an error, not a shorter blob", !!r.e && !r.b, r.e?.message || `blob of ${r.b?.size}`);
ok("… the error says it was cut off, with the byte counts", /cut off \(2000 of 3000 bytes\)/.test(r.e?.message || ""), r.e?.message);
// 2. an error mid-way: still an error (as before)
serve([Array(1000).fill(1)], 3000, { error: true });
r = await loadBlob("/file?path=x.mp4").then((b) => ({ b }), (e) => ({ e }));
ok("a stream that errors mid-way: an error", !!r.e, r.e?.message);
// 3. whole: the blob, its type kept
serve([Array(1000).fill(1), Array(1000).fill(2), Array(1000).fill(3)], 3000);
r = await loadBlob("/file?path=x.mp4").then((b) => ({ b }), (e) => ({ e }));
ok("a whole body: the blob, full size, its type", r.b?.size === 3000 && r.b.type === "video/mp4", r.e?.message || `${r.b?.size} ${r.b?.type}`);
// 4. no Content-Length (chunked) or a content-encoded body: no length to check against (unchanged behaviour)
serve([Array(500).fill(1)], null);
r = await loadBlob("/file?path=x.mp4").then((b) => ({ b }), (e) => ({ e }));
ok("no Content-Length: the blob as it came", r.b?.size === 500, r.e?.message);
serve([Array(500).fill(1)], 200, { enc: "gzip-test" });
r = await loadBlob("/file?path=x.mp4").then((b) => ({ b }), (e) => ({ e }));
ok("content-encoded (the length counts encoded bytes): not refused", r.b?.size === 500, r.e?.message);
// 5. over the cap: null (download instead), as before
serve([Array(10).fill(1)], 300e6);
r = await loadBlob("/file?path=x.mp4").then((b) => ({ b }), (e) => ({ e }));
ok("over MAX: null (the page downloads instead)", r.b === null && !r.e);
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
