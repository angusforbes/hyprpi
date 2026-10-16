// J704: send-claim.ts with a fake pi (no processes, no network, nothing sent). Run: node test/run.mjs test/send-claim.mjs
import assert from "node:assert/strict";
import { sendClaim, findClaims, isSendCall, assess } from "../pi-extension/send-claim.ts";

function harness() {
  const h = {}, shown = [], msgs = [];
  const pi = { on: (e, f) => (h[e] = f), sendMessage: (m, o) => msgs.push([m, o]) };
  sendClaim(pi, {});
  return { h, shown, msgs, ctx: { ui: { notify: (m, t) => shown.push([t, m]) } } };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const A = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });

// W1: claims with no send tool are flagged (visible line + one correction turn)
for (const t of ["I sent the email to Jessica.", "Done. Emailed it to Jessica Yin.", "I've posted the comment on the PR.", "The message was sent to #general.", "Sent. Now the next step.", "I messaged Blink and also posted it in the room."]) {
  const x = harness(); await x.h.agent_start({});
  await x.h.agent_end({ messages: [A(t)] }, x.ctx);
  assert.equal(x.shown.length, 1, t); assert.match(x.shown[0][1], /not sent/); assert.equal(x.shown[0][0], "warning");
  await tick(80); assert.equal(x.msgs.length, 1, t); assert.equal(x.msgs[0][1].triggerTurn, true);
  // the correction run that still claims: warned again, but no second nudge (no loop)
  await x.h.agent_start({}); await x.h.agent_end({ messages: [A(t)] }, x.ctx); await tick(80);
  assert.equal(x.msgs.length, 1, "no loop");
}
// W2: a real send tool in the run is not flagged
for (const [tool, input] of [["talk", {}], ["talk_reply", {}], ["room_post", {}], ["mail_send", {}], ["mcp__maas_slack_mcp_server__slack_post_message", {}], ["mcp__maas_slack_mcp_server__slack_reply_to_thread", {}], ["mcp__maas_outlook_mcp_server__send_email", {}], ["bash", { command: "gh pr comment 12 --body hi" }], ["bash", { command: "curl -d 'hi' ntfy.sh/topic" }]]) {
  const x = harness(); await x.h.agent_start({});
  await x.h.tool_call({ toolCallId: "1", toolName: tool, input }); await x.h.tool_execution_end({ toolCallId: "1", isError: false });
  await x.h.agent_end({ messages: [A("I sent it to Jessica and posted the comment.")] }, x.ctx);
  assert.equal(x.shown.length, 0, tool); await tick(80); assert.equal(x.msgs.length, 0);
}
{ // a FAILED send tool does not count; a read tool does not count; a draft tool does not count
  for (const [tool, err] of [["talk", true], ["mcp__maas_slack_mcp_server__slack_get_thread_replies", false], ["mcp__maas_outlook_mcp_server__create_draft", false], ["mcp__maas_slack_mcp_server__slack_search_messages", false], ["bash", false]]) {
    const x = harness(); await x.h.agent_start({});
    await x.h.tool_call({ toolCallId: "1", toolName: tool, input: { command: "ls" } }); await x.h.tool_execution_end({ toolCallId: "1", isError: err });
    await x.h.agent_end({ messages: [A("I emailed Jessica.")] }, x.ctx);
    assert.equal(x.shown.length, 1, tool);
  }
}
{ // earlier-session send allows "already sent"; a new run's tool state resets
  const x = harness(); await x.h.agent_start({});
  await x.h.tool_call({ toolCallId: "1", toolName: "talk", input: {} }); await x.h.tool_execution_end({ toolCallId: "1", isError: false });
  await x.h.agent_end({ messages: [A("ok")] }, x.ctx);
  await x.h.agent_start({}); await x.h.agent_end({ messages: [A("I already sent that earlier.")] }, x.ctx); assert.equal(x.shown.length, 0);
  await x.h.agent_start({}); await x.h.agent_end({ messages: [A("I sent the email to Jessica.")] }, x.ctx); assert.equal(x.shown.length, 1);
}
// false positives that must NOT be flagged
for (const t of ["Pocket sent me a screenshot of the error.", "I drafted the email; nothing was sent.", "It was not sent yet.", "I haven't sent anything.", "Shall I send it? Once sent, Jessica sees it.", "The log says `sent` for each row.", "Angus: \"I sent it\" was his reply.", "It will be sent after your OK.", "The sent folder has 12 items.", "Blink posted the diff in the room.", "I'll send it when you say.", "Here is the draft to be sent to Jessica:"]) {
  assert.equal(findClaims(t).length, 0, t);
}
assert.ok(isSendCall("report_to_parent", {}) && !isSendCall("read", {}) && !isSendCall("bash", { command: "git status" }));
assert.equal(assess(["I sent it"], false, false).flagged, true);
console.log("send-claim: ok");
