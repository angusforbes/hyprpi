// J653: mcp-calm.ts with a fake pi (no processes, no network): a startup network blip becomes one dim line and a
// background `/mcp reconnect`; real failures keep pi's warning. Run: node test/mcp-calm.mjs
import assert from "node:assert/strict";
import { mcpCalm, splitMcpWarning } from "../pi-extension/mcp-calm.ts";

const W = (lines) => `MCP servers need attention:\n${lines.map((l) => `  ${l}`).join("\n")}\nRun /mcp to fix.`;
const SOCK = "failed: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

assert.deepEqual(splitMcpWarning(W([`maas-slack: ${SOCK}`, "maas-outlook: failed: MCP request timed out after 30000ms"])), { transient: ["maas-slack", "maas-outlook"], rest: [] });
assert.deepEqual(splitMcpWarning(W(["a: needs sign-in", "config: x.json: bad", "b: failed: ENOENT: no such file or directory, posix_spawn '/x'", "c: failed: HTTP 401 Unauthorized"])).transient, []);
assert.equal(splitMcpWarning("something else"), null);

function harness() {
  const handlers = {}, shown = [], sent = [];
  const pi = { on: (e, h) => (handlers[e] = h), sendUserMessage: (t) => sent.push(t) };
  mcpCalm(pi, { retryMs: [5, 5] });
  const ui = { notify: (m, t) => shown.push([t, m]) };
  return { handlers, shown, sent, ui };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

{ // blip + real problem in one warning
  const h = harness(); await h.handlers.session_start({}, { ui: h.ui });
  h.ui.notify(W([`maas-slack: ${SOCK}`, "badcmd: failed: ENOENT: no such file"]), "warning");
  assert.equal(h.shown[0][0], "info"); assert.match(h.shown[0][1], /^MCP: maas-slack not reachable at startup/);
  assert.equal(h.shown[1][0], "warning"); assert.match(h.shown[1][1], /badcmd/); assert.doesNotMatch(h.shown[1][1], /maas-slack/);
  await tick(20); assert.deepEqual(h.sent, ["/mcp reconnect maas-slack"]);
  h.ui.notify(`MCP server "maas-slack" failed to connect: The socket connection was closed unexpectedly.`, "error"); // still down: quiet
  assert.equal(h.shown.length, 2);
  await tick(20); assert.equal(h.sent.length, 2);
  h.ui.notify(`Reconnected to MCP server "maas-slack" (connected · 3 tools).`, "info");
  assert.deepEqual(h.shown[2], ["info", "MCP: maas-slack connected"]);
  await h.handlers.before_agent_start(); assert.equal(h.sent.length, 2); // nothing left to retry
  await h.handlers.session_shutdown();
}
{ // retry turns into a real failure: full warning
  const h = harness(); await h.handlers.session_start({}, { ui: h.ui });
  h.ui.notify(W([`x: ${SOCK}`]), "warning"); await tick(20);
  h.ui.notify(`MCP server "x" requires sign-in. Run /mcp to sign in.`, "error");
  assert.equal(h.shown.at(-1)[0], "warning"); assert.match(h.shown.at(-1)[1], /^MCP servers need attention:\n  x: .*sign-in/);
  await h.handlers.session_shutdown();
}
{ // a prompt retries at once and waits for the answer
  const h = harness(); await h.handlers.session_start({}, { ui: h.ui });
  h.ui.notify(W([`y: ${SOCK}`]), "warning");
  const p = h.handlers.before_agent_start(); assert.deepEqual(h.sent, ["/mcp reconnect y"]);
  let done = false; p.then(() => (done = true)); await tick(1); assert.equal(done, false);
  h.ui.notify(`Reconnected to MCP server "y" (connected · 1 tool).`, "info"); await tick(1); assert.equal(done, true);
  await h.handlers.session_shutdown();
}
{ // other notifies pass through untouched; a user's own /mcp reconnect of a server we don't track is untouched
  const h = harness(); await h.handlers.session_start({}, { ui: h.ui });
  h.ui.notify("hello", "warning"); h.ui.notify(`MCP server "z" failed to connect: socket hang up`, "error");
  assert.deepEqual(h.shown, [["warning", "hello"], ["error", `MCP server "z" failed to connect: socket hang up`]]);
  await h.handlers.session_shutdown();
}
{ // F1: a server name with "token"/"config" in it is not evidence; F3: Bun's refused-connection text is transient
  const h = harness(); await h.handlers.session_start({}, { ui: h.ui });
  h.ui.notify(W(["token-api: failed: Unable to connect. Is the computer able to access the url?"]), "warning");
  assert.equal(h.shown.length, 1); assert.equal(h.shown[0][0], "info");
  await tick(20); assert.deepEqual(h.sent, ["/mcp reconnect token-api"]);
  h.ui.notify(`MCP server "token-api" failed to connect: The socket connection was closed unexpectedly.`, "error");
  assert.equal(h.shown.length, 1); // still quiet, still tracked
  await tick(20); assert.equal(h.sent.length, 2);
  await h.handlers.session_shutdown();
}
{ // F2: after our retry was answered, the user's own /mcp reconnect messages are shown as they are
  const h = harness(); await h.handlers.session_start({}, { ui: h.ui });
  h.ui.notify(W([`u: ${SOCK}`]), "warning"); await tick(8);
  h.ui.notify(`MCP server "u" failed to connect: socket hang up`, "error"); // answer to ours: quiet
  assert.equal(h.shown.length, 1);
  h.ui.notify(`MCP server "u" failed to connect: socket hang up`, "error"); // the user's own: shown
  assert.deepEqual(h.shown.at(-1), ["error", `MCP server "u" failed to connect: socket hang up`]);
  await h.handlers.session_shutdown();
}
console.log("mcp-calm: ok");
