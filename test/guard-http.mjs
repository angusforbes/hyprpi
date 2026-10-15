#!/usr/bin/env node
// J663 (NssSync's finding): under the test guard, node's http.request() crashed ("TypeError: Cannot convert object to primitive
// value"): the guard's connect hook called String() on http's null-prototype connect options. A local http round trip must work.
//   node test/run.mjs guard-http   (exit 0 = pass)
import http from "node:http";
const got = await new Promise((resolve) => {
  const s = http.createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1", () => {
    http.get({ host: "127.0.0.1", port: s.address().port, path: "/" }, (res) => { let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => { s.close(); resolve(b); }); })
      .on("error", (e) => { s.close(); resolve("ERR " + e.message); });
  });
});
console.log(got === "ok" ? "ok   http.get to a test's own local server works under the guard" : `FAIL http.get under the guard: ${got}`);
process.exit(got === "ok" ? 0 : 1);
