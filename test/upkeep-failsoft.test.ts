// J563: pi-extension/upkeep.ts's context hook (pruning). (1) It loads and prunes without the "statePath is not a function"
// error. (2) Fail soft (Angus: "pretty ugly"): when the hook throws, the turn goes on (the hook returns, it doesn't throw), the
// window gets ONE short warning line (not a stack trace), the trace goes to the log, and Thoughts gets ONE alert, however many
// turns fail. Run: bun test test/upkeep-failsoft.test.ts
import { expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
mock.module("typebox", () => ({ Type: new Proxy({}, { get: () => (...a: any[]) => ({ schema: a }) }) }));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "upk-")); process.env.HYPRPI_STATE = T; process.env.HYPRPI_WORKSPACE = "14";
const { upkeepAgent, UPKEEP_ERROR_LOG } = await import("../pi-extension/upkeep.ts");
const hooks: Record<string, any> = {}, calls: any[] = [], notes: any[] = [];
const pi: any = { on: (n: string, h: any) => { hooks[n] = h; }, registerTool: () => {}, sendMessage: () => {} };
upkeepAgent(pi, { call: async (m: string, p: any) => { calls.push([m, p]); return {}; }, agentId: "hp-test", idle: () => true });
const ctx = { ui: { notify: (m: string, t: string) => notes.push([m, t]) } };

test("the pruning hook runs (no 'statePath is not a function') on a request with big outputs", async () => {
  const big = "x".repeat(400000);
  const msgs = [{ role: "user", content: [{ type: "text", text: "go" }] }, ...Array.from({ length: 6 }, (_, i) => ({ role: "toolResult", toolCallId: `t${i}`, toolName: "bash", content: [{ type: "text", text: big }] })), { role: "user", content: [{ type: "text", text: "now" }] }];
  const r = await hooks.context({ messages: msgs }, ctx);
  expect(notes.length).toBe(0); // no warning: it worked
  expect(r === undefined || Array.isArray(r.messages)).toBe(true);
});

test("a throwing hook: the turn goes on, one short line, the trace logged, one Thoughts alert for many turns", async () => {
  const boom = { get messages() { throw new Error("forced failure for the test\n    at a stack line"); } };
  for (let i = 0; i < 4; i++) expect(await hooks.context(boom, ctx)).toBeUndefined(); // returns: the turn carries on
  expect(notes.length).toBe(1);
  expect(notes[0][0]).toBe("⚠ upkeep: pruning skipped (forced failure for the test); reported");
  expect(notes[0][0]).not.toContain("at ");
  const log = fs.readFileSync(UPKEEP_ERROR_LOG, "utf8");
  expect(UPKEEP_ERROR_LOG.startsWith(T)).toBe(true);
  expect(log.split("\n").filter((l) => l.includes("hp-test pruning:")).length).toBe(4); // every failure logged, with its trace
  expect(log).toContain("at ");
  const alerts = calls.filter(([m]) => m === "thoughts.alert");
  expect(alerts.length).toBe(1);
  expect(alerts[0][1].room).toBe("B"); // workspace 14 = world B
  // a /reload re-runs the extension: the same failure isn't announced again in this process (UpkeepCheck)
  const hooks2: Record<string, any> = {};
  upkeepAgent({ on: (n: string, h: any) => { hooks2[n] = h; }, registerTool: () => {}, sendMessage: () => {} } as any, { call: async (m: string, p: any) => { calls.push([m, p]); return {}; }, agentId: "hp-test", idle: () => true });
  await hooks2.context(boom, ctx);
  expect(notes.length).toBe(1); expect(calls.filter(([m]) => m === "thoughts.alert").length).toBe(1);
});

test("Thoughts' failures alert its own room (it has no HYPRPI_WORKSPACE)", async () => {
  const { failSoft } = await import("../pi-extension/upkeep.ts");
  const got: any[] = [];
  failSoft("pruning", new Error("x"), { call: async (m: string, p: any) => { got.push(p); }, agentId: "Thoughts-E", room: "E" });
  expect(got[0].room).toBe("E");
});
