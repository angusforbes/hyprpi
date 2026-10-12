#!/usr/bin/env node
// remote-client.mjs: the laptop side of a remote world's agent window (J471). Draws pi's interface HERE with pi's own components (editor,
// messages, tool rows), so typing and editing never cross the link; a finished message goes to the remote agent's pi (RPC mode
// behind omnistation/hbroker.mjs, reached over the ssh argv in the private remote config) and its events render here as they
// stream. The agent and its session stay on the remote machine: closing this window, an ssh drop or an expired login only
// disconnects; the client reconnects by itself and shows the history again.
//
//   node remote-client.mjs LETTER NAME     (`omnistation/world LETTER open NAME` runs it in a kitty window)
// Env: HYPRPI_REMOTE_DEPS = a folder whose node_modules has @earendil-works/pi-coding-agent (`world` installs it, pinned)
//      HYPRPI_REMOTE_CONF = the world's private binding (default ~/.config/hyprpi/remote/<letter>.json)
//      HYPRPI_REMOTE_WS = the world's first workspace (`world` passes it)
//
// Keys: Enter sends (while the agent works it is queued as a steer; Alt+Enter queues a follow-up), Esc interrupts the agent,
// Ctrl+C clears the editor (twice on an empty one quits) where your keybindings keep it, Ctrl+D on an empty editor or /quit closes
// the window (the agent keeps running), Ctrl+L picks the model, Ctrl+O expands tool
// output. Commands handled here: /model [filter], /quit; anything else starting with / goes to the agent as a prompt (its
// extension commands, skills and templates run there).
// keys typed while the modules load must not echo raw onto the screen: raw mode at once (the TUI takes over below)
if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const WL = String(process.argv[2] || "").toUpperCase(), wl = WL.toLowerCase();
if (!/^[A-I]$/.test(WL)) { console.error("remote-client: usage: remote-client.mjs LETTER NAME"); process.exit(2); }
const NAME = process.argv[3] || "alpha";
const WS = String(process.env.HYPRPI_REMOTE_WS || "");
if (!/^[0-9]{1,3}$/.test(WS)) { console.error("remote-client: HYPRPI_REMOTE_WS isn't set"); process.exit(2); }
if (!/^[a-z][a-z0-9-]{0,30}$/.test(NAME)) { console.error("h-client: a name is lowercase letters, digits and -"); process.exit(2); }
const CONF = process.env.HYPRPI_REMOTE_CONF || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), `hyprpi/remote/${wl}.json`);
const conf = JSON.parse(fs.readFileSync(CONF, "utf8"));
const SSH = (conf.ssh || []).filter((a) => a !== "-t" && a !== "-tt"); // a pipe, not a terminal: no -t
if (!SSH.length) { console.error(`h-client: "ssh" is empty in ${CONF}`); process.exit(2); }
// the first connect starts the agent if it isn't running; a reconnect doesn't (review: `world X stop NAME` must stay stopped)
const DEBUG = !!process.env.HYPRPI_REMOTE_DEBUG;
const remoteCmd = (first) => `HYPRPI_REMOTE_WS=${WS} bash ~/.hyprpi-${wl}/remote.sh connect ${NAME}${first ? "" : " nostart"}`;
let everConnected = false, stopped = false;

const DEPS = process.env.HYPRPI_REMOTE_DEPS || path.join(os.homedir(), ".cache/hyprpi-remote");
const PKG = path.join(DEPS, "node_modules/@earendil-works");
const imp = (p) => import(pathToFileURL(path.join(PKG, p)).href);
const tui = await imp("pi-tui/dist/index.js");
const agentDist = "pi-coding-agent/dist";
const { initTheme, getMarkdownTheme, getSelectListTheme } = await imp(`${agentDist}/index.js`);
const themeMod = await imp(`${agentDist}/modes/interactive/theme/theme.js`);
const { KeybindingsManager } = await imp(`${agentDist}/core/keybindings.js`);
const { CustomEditor } = await imp(`${agentDist}/modes/interactive/components/custom-editor.js`);
const { AssistantMessageComponent } = await imp(`${agentDist}/modes/interactive/components/assistant-message.js`);
const { UserMessageComponent } = await imp(`${agentDist}/modes/interactive/components/user-message.js`);
const { ToolExecutionComponent } = await imp(`${agentDist}/modes/interactive/components/tool-execution.js`);
const { withBuiltInRenderers } = await imp(`${agentDist}/core/tools/renderers/index.js`);
const { WorkingStatusIndicator } = await imp(`${agentDist}/modes/interactive/components/status-indicator.js`);
const { FooterComponent } = await imp(`${agentDist}/modes/interactive/components/footer.js`);
const { Container, Text, Spacer, SelectList, ProcessTerminal, TuiMainScreen, setKeybindings, matchesKey } = tui;

// J471 v2 (Angus: "the agent windows look way different on H"): the laptop's own pi look: its settings, its themes (a theme
// file in ~/.pi/agent/themes, e.g. Omarchy's, is registered first, as pi's resource loader does), the same footer component
let settings = {}; try { settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/settings.json"), "utf8")); } catch {}
try {
  const dir = path.join(os.homedir(), ".pi/agent/themes"), mine = [];
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) { try { mine.push(themeMod.loadThemeFromPath(path.join(dir, f))); } catch {} }
  themeMod.setRegisteredThemes(mine);
} catch {}
try { initTheme(settings.theme, true); } catch { initTheme(undefined, false); }
const T = themeMod.theme;
const md = () => getMarkdownTheme();

const ui = new TuiMainScreen(new ProcessTerminal());
const keybindings = KeybindingsManager.create(); setKeybindings(keybindings);
const chat = new Container();
const pendingBox = new Text("", 1, 0);
const statusLine = new Text("", 1, 0);
const workingBox = new Container(); // pi's "⠼ Working" line sits above the editor, as in the other windows
const editor = new CustomEditor(ui, themeMod.getEditorTheme(), keybindings, { paddingX: settings.editorPaddingX ?? 0, autocompleteMaxVisible: settings.autocompleteMaxVisible });
const pickerBox = new Container();
// pi's own footer, fed from the remote session: cwd, tokens / cost / context, model + thinking, and the extensions' status line
// (hyprpi's "name · room H" comes from the remote agent's own extension; the link's state is one more entry there)
const fakeSession = {
  get state() { return { model: st.model, thinkingLevel: st.thinking }; },
  get model() { return st.model; }, routedModel: undefined,
  modelRuntime: { isUsingSubscription: () => false },
  getContextUsage: () => st.stats?.contextUsage,
  sessionManager: {
    getEntryCount: () => st.statsRev, getSessionId: () => st.sessionId || "", getLeafId: () => String(st.statsRev),
    getEntries: () => st.stats ? [{ type: "usage", usage: { input: st.stats.tokens?.input || 0, output: st.stats.tokens?.output || 0, cacheRead: st.stats.tokens?.cacheRead || 0, cacheWrite: st.stats.tokens?.cacheWrite || 0, totalTokens: st.stats.tokens?.total || 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number(st.stats.cost) || 0 } } }] : [],
    getCwd: () => (st.cwd.startsWith("~") ? (process.env.HOME || "") + st.cwd.slice(1) : st.cwd), getSessionName: () => st.sessionName,
  },
};
const footerData = { getGitBranch: () => null, getAvailableProviderCount: () => st.providers || 1, getExtensionStatuses: () => {
  const m = new Map(st.extStatus); m.set("zz-link", st.connected ? "" : T.fg("warning", "🛰 reconnecting…")); for (const [k, v] of m) if (!v) m.delete(k); return m; } };
const footer = new FooterComponent(fakeSession, footerData);
footer.setAutoCompactEnabled?.(true);
for (const c of [chat, pendingBox, statusLine, workingBox, pickerBox, editor, footer]) ui.addChild(c);
ui.setFocus(editor);
// the title as G's windows have it ("🐳 G: π - Beta - world-g"): the world's mark and letter, then pi's own title from the agent
const setTitle = (t) => process.stdout.write(`\x1b]2;🛰 ${WL}: ${String(t || `π - ${NAME}`).replace(/[^\p{L}\p{N}\p{P}\p{Zs}π]/gu, "").slice(0, 80)}\x07`);
setTitle();

// ---- state
const st = { connected: false, conn: null, streaming: false, model: null, thinking: "", cwd: "~", sessionName: "", pending: 0,
  lastErr: "", expanded: false, streamingComp: null, pendingTools: new Map(), quitArmed: 0, extStatus: new Map(), stats: null, statsRev: 0, providers: 1 };
let reqN = 0; const waiting = new Map(); const outbox = [];
const sendRaw = (obj) => { if (!st.conn) return false; st.conn.stdin.write(JSON.stringify(obj) + "\n"); return true; };
const rpc = (obj, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = `r${++reqN}`;
  if (!sendRaw({ ...obj, id })) return reject(new Error("not connected"));
  const unknown = (m) => Object.assign(new Error(m), { unknown: true }); // no answer: it may or may not have arrived
  const t = setTimeout(() => { waiting.delete(id); reject(unknown(`${obj.type}: no answer`)); }, timeoutMs);
  waiting.set(id, (r) => { clearTimeout(t); r.success === false ? reject(r.error === "connection lost" ? unknown(r.error) : new Error(r.error || "failed")) : resolve(r.data); });
});

const modelLabel = () => st.model ? `${st.model.provider}/${st.model.id}` : "no model";
function paintChrome() {
  footer.invalidate?.();
  editor.borderColor = T.getThinkingBorderColor(st.thinking || "off");
  statusLine.setText(st.lastErr ? T.fg("warning", clean(st.lastErr).replace(/\x1b\[[0-9;:]*m/g, "")) : "");
  pendingBox.setText([st.pending ? `${st.pending} message(s) queued` : "", outbox.length ? `${outbox.length} message(s) waiting for the connection: ${outbox.map((o) => o.text.slice(0, 40)).join(" | ")}` : ""].filter(Boolean).map((t) => T.fg("dim", t)).join("\n"));
  ui.requestRender();
}

// ---- rendering (mirrors pi's interactive mode)
let working = null;
function setWorking(on) {
  if (on && !working) { working = new WorkingStatusIndicator(ui, "Working...", undefined); workingBox.clear(); workingBox.addChild(working); }
  if (!on && working) { working.dispose?.(); working = null; workingBox.clear(); }
  ui.requestRender();
}
const userText = (m) => typeof m.content === "string" ? m.content : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
function toolComp(name, id, args) {
  const c = new ToolExecutionComponent(name, id, args, { showImages: true }, withBuiltInRenderers(name, undefined), ui, st.cwd);
  c.setExpanded(st.expanded); chat.addChild(c); return c;
}
function addUser(m) {
  const t = userText(m); if (!t) return;
  if (chat.children.length) chat.addChild(new Spacer(1));
  chat.addChild(new UserMessageComponent(t, md()));
}
function renderHistory(messages) {
  chat.clear(); st.pendingTools.clear(); st.streamingComp = null; st.streamMsg = null; st.argBuf = new Map();
  const tools = new Map();
  for (const m of messages) {
    if (m.role === "user") addUser(m);
    else if (m.role === "assistant") {
      chat.addChild(new AssistantMessageComponent(m, settings.hideThinkingBlock ?? false, md()));
      for (const c of m.content || []) if (c.type === "toolCall") {
        const comp = toolComp(c.name, c.id, c.arguments);
        if (m.stopReason === "aborted" || m.stopReason === "error") comp.updateResult({ content: [{ type: "text", text: m.errorMessage || "Operation aborted" }], isError: true });
        else tools.set(c.id, comp);
      }
    } else if (m.role === "toolResult") {
      const comp = tools.get(m.toolCallId); if (comp) { comp.updateResult({ ...m, isError: m.isError }); tools.delete(m.toolCallId); }
    } else if (m.role === "custom" && m.display) {
      const t = typeof m.content === "string" ? m.content : userText(m);
      if (t) { chat.addChild(new Spacer(1)); chat.addChild(new Text(T.fg("dim", t), 1, 0)); }
    } else if (m.role === "bashExecution") {
      chat.addChild(new Spacer(1)); chat.addChild(new Text(T.fg("dim", `$ ${m.command}\n${(m.output || "").split("\n").slice(-20).join("\n")}`), 1, 0));
    }
  }
  for (const [id, c] of tools) st.pendingTools.set(id, c); // still running when we connected
  ui.requestRender();
}
function onEvent(e) {
  if (DEBUG && !["message_update", "tool_execution_update"].includes(e.type)) process.stderr.write(`event ${e.type} ${e.type === "extension_ui_request" ? e.method : ""} ${e.type === "queue_update" ? JSON.stringify(e).slice(0, 200) : ""}\n`);
  try { onEvent1(e); } catch (err) { st.lastErr = `couldn't show a ${e?.type} event: ${err.message}`; paintChrome(); }
}
function onEvent1(e) {
  switch (e.type) {
    case "agent_start": st.streaming = true; st.pendingTools.clear(); setWorking(true); break;
    case "turn_start": setWorking(true); break;
    case "queue_update": st.pending = (e.steering?.length || 0) + (e.followUp?.length || 0); paintChrome(); break;
    case "message_start":
      if (e.message.role === "user") addUser(e.message);
      else if (e.message.role === "custom" && e.message.display) { const t = userText(e.message); if (t) { chat.addChild(new Spacer(1)); chat.addChild(new Text(T.fg("dim", t), 1, 0)); } }
      else if (e.message.role === "assistant") {
        st.streamMsg = { ...e.message, content: [...(e.message.content || [])] }; st.argBuf = new Map();
        st.streamingComp = new AssistantMessageComponent(undefined, settings.hideThinkingBlock ?? false, md());
        chat.addChild(st.streamingComp); st.streamingComp.updateContent(st.streamMsg, true);
      }
      ui.requestRender(); break;
    case "message_update": {
      // on the wire message_update is delta-only (pi's RPC): rebuild the message here (docs/json.md "Reconstruct streaming messages")
      const ev = e.assistantMessageEvent; if (!ev) break;
      if (!st.streamMsg) { st.streamMsg = { role: "assistant", content: [] }; st.argBuf = new Map(); }
      if (!st.streamingComp) { st.streamingComp = new AssistantMessageComponent(undefined, settings.hideThinkingBlock ?? false, md()); chat.addChild(st.streamingComp); }
      const m = st.streamMsg, k = ev.contentIndex;
      switch (ev.type) {
        case "text_start": m.content[k] = { type: "text", text: "" }; break;
        case "text_delta": m.content[k] = { type: "text", text: (m.content[k]?.text || "") + ev.delta }; break;
        case "text_end": m.content[k] = typeof ev.content === "string" ? { type: "text", text: ev.content } : (ev.content || m.content[k]); break;
        case "thinking_start": m.content[k] = { type: "thinking", thinking: "" }; break;
        case "thinking_delta": m.content[k] = { type: "thinking", thinking: (m.content[k]?.thinking || "") + ev.delta }; break;
        case "thinking_end": m.content[k] = typeof ev.content === "string" ? { type: "thinking", thinking: ev.content } : (ev.content || m.content[k]); break;
        case "toolcall_start": m.content[k] = { type: "toolCall", id: ev.id, name: ev.toolName, arguments: {} }; st.argBuf.set(k, ""); break;
        case "toolcall_delta": { const b = (st.argBuf.get(k) || "") + ev.delta; st.argBuf.set(k, b); try { m.content[k] = { ...m.content[k], arguments: JSON.parse(b) }; } catch {} break; }
        case "toolcall_end": if (ev.toolCall) m.content[k] = ev.toolCall; break;
      }
      for (let i = 0; i < m.content.length; i++) if (!m.content[i]) m.content[i] = { type: "text", text: "" };
      st.streamingComp.updateContent(m, true);
      for (const c of m.content) if (c.type === "toolCall" && c.id) {
        const comp = st.pendingTools.get(c.id);
        if (comp) comp.updateArgs(c.arguments); else st.pendingTools.set(c.id, toolComp(c.name, c.id, c.arguments));
      }
      ui.requestRender(); break;
    }
    case "message_end":
      if (e.message.role !== "assistant") break;
      if (!st.streamingComp) { // (review) connected mid-message: get_messages had no in-flight message, so show it whole now
        st.streamingComp = new AssistantMessageComponent(undefined, settings.hideThinkingBlock ?? false, md()); chat.addChild(st.streamingComp);
        for (const c of e.message.content || []) if (c.type === "toolCall" && !st.pendingTools.has(c.id)) st.pendingTools.set(c.id, toolComp(c.name, c.id, c.arguments));
      }
      if (e.message.stopReason === "aborted" && !e.message.errorMessage) e.message.errorMessage = "Operation aborted";
      st.streamingComp.updateContent(e.message, false);
      if (e.message.stopReason === "aborted" || e.message.stopReason === "error") {
        for (const c of st.pendingTools.values()) c.updateResult({ content: [{ type: "text", text: e.message.errorMessage || "Error" }], isError: true });
        st.pendingTools.clear();
      } else for (const c of st.pendingTools.values()) c.setArgsComplete();
      st.streamingComp = null; st.streamMsg = null; ui.requestRender(); break;
    case "tool_execution_start": {
      if (e.parentToolCallId) break;
      let c = st.pendingTools.get(e.toolCallId);
      if (!c) { c = toolComp(e.toolName, e.toolCallId, e.args); st.pendingTools.set(e.toolCallId, c); }
      c.markExecutionStarted(); ui.requestRender(); break;
    }
    case "tool_execution_update": { const c = st.pendingTools.get(e.toolCallId); if (c) { c.updateResult({ ...e.partialResult, isError: false }, true); ui.requestRender(); } break; }
    case "tool_execution_end": { const c = st.pendingTools.get(e.toolCallId); if (c) { c.updateResult({ ...e.result, isError: e.isError }); st.pendingTools.delete(e.toolCallId); ui.requestRender(); } break; }
    case "agent_end":
      st.streaming = false; setWorking(false);
      if (st.streamingComp) { chat.removeChild(st.streamingComp); st.streamingComp = null; }
      st.pendingTools.clear(); refreshState(); break;
    case "auto_retry_start": st.lastErr = `retrying (${e.attempt}/${e.maxAttempts})…`; paintChrome(); break;
    case "auto_retry_end": st.lastErr = ""; paintChrome(); break;
    case "compaction_start": st.lastErr = "compacting…"; paintChrome(); break;
    case "compaction_end": st.lastErr = ""; reloadHistory(); break;
    case "session_info_changed": case "thinking_level_changed": case "model_changed": refreshState(); break;
    case "extension_ui_request": onUiRequest(e); break;
    case "extension_ui_closed": { const i = dialogQueue.findIndex((q) => q.id === e.id); if (i >= 0) dialogQueue.splice(i, 1); if (dialog?.id === e.id) closeDialog(); break; }
    case "broker_error": st.lastErr = e.error; paintChrome(); break;
    case "extension_error": st.lastErr = `extension: ${e.error}`; paintChrome(); break;
  }
}

// ---- extension UI from the remote (status, notify, simple dialogs)
let dialog = null; const dialogQueue = []; // (review) one dialog at a time; later ones wait their turn
function closeDialogSilently() { pickerBox.clear(); dialog = null; ui.setFocus(editor); ui.requestRender(); }
function closeDialog() { pickerBox.clear(); dialog = null; ui.setFocus(editor); ui.requestRender(); const next = dialogQueue.shift(); if (next) onUiRequest(next); }
function onUiRequest(r) {
  if (["select", "confirm", "input", "editor"].includes(r.method) && dialog) { if (dialog.id !== r.id && !dialogQueue.some((q) => q.id === r.id)) dialogQueue.push(r); return; }
  if (r.method === "setStatus") { st.extStatus.set(r.statusKey, r.statusText || ""); paintChrome(); return; }
  if (r.method === "notify") { chat.addChild(new Spacer(1)); chat.addChild(new Text(T.fg(r.notifyType === "error" ? "error" : r.notifyType === "warning" ? "warning" : "dim", r.message || ""), 1, 0)); ui.requestRender(); return; }
  if (r.method === "setTitle") return setTitle(r.title);
  if (r.method === "set_editor_text") { editor.setText(r.text || ""); ui.requestRender(); return; }
  if (r.method === "select" || r.method === "confirm") {
    const items = r.method === "confirm" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : (r.options || []).map((o) => ({ value: o, label: o }));
    showPicker(`${r.title || ""}${r.message ? "\n" + r.message : ""}`, items, (v) => {
      sendRaw(r.method === "confirm" ? { type: "extension_ui_response", id: r.id, confirmed: v === "yes" } : v == null ? { type: "extension_ui_response", id: r.id, cancelled: true } : { type: "extension_ui_response", id: r.id, value: v });
    }, r.id);
    return;
  }
  if (r.method === "input" || r.method === "editor") { // answered from the editor: the next Enter is the answer
    dialog = { id: r.id, kind: "text" };
    pickerBox.clear(); pickerBox.addChild(new Text(T.fg("accent", `${r.title || "Input"} (Enter answers, Esc cancels)`), 1, 0));
    if (r.prefill) editor.setText(r.prefill);
    ui.requestRender();
  }
}
function showPicker(title, items, done, id = null, filterable = false) {
  if (dialog && !id) { st.lastErr = "answer the open question first"; return paintChrome(); } // a model picker never covers an agent's question
  dialog = { id, kind: "list", filter: filterable ? "" : undefined, all: items, title, done };
  drawPicker();
}
function drawPicker() { // (SelectList's own filter is a prefix match on the value: we filter the labels by substring instead)
  const d = dialog; pickerBox.clear();
  const f = (d.filter || "").toLowerCase();
  const items = f ? d.all.filter((i) => i.label.toLowerCase().includes(f)) : d.all;
  if (d.title) pickerBox.addChild(new Text(T.fg("accent", d.title) + (d.filter !== undefined ? T.fg("dim", `  filter: ${d.filter || "(type)"}  ${items.length}/${d.all.length}`) : ""), 1, 0));
  const list = new SelectList(items.length ? items : [{ value: "", label: "(nothing matches)" }], 12, getSelectListTheme());
  list.onSelect = (it) => { if (!it.value) return; closeDialog(); d.done(it.value); };
  list.onCancel = () => { closeDialog(); d.done(null); };
  pickerBox.addChild(list); d.list = list;
  ui.setFocus(list); ui.requestRender();
}

// ---- commands
async function refreshState() {
  try { const s = await rpc({ type: "get_state" }); st.model = s.model || null; st.thinking = s.thinkingLevel || ""; st.sessionName = s.sessionName || "";
    st.streaming = !!s.isStreaming; st.pending = s.pendingMessageCount || 0; st.sessionId = s.sessionId || ""; setWorking(st.streaming);
  } catch {}
  try { st.stats = await rpc({ type: "get_session_stats" }); st.statsRev++; } catch {}
  if (!st.providersAt) { st.providersAt = 1; rpc({ type: "get_available_models" }).then((d) => { st.providers = new Set((d.models || []).map((m) => m.provider)).size || 1; paintChrome(); }, () => {}); }
  paintChrome();
}
// history is rendered synchronously from inside the read loop (see connect): events after its response line are newer than it,
// events before it are already in it. (review: rendering it a microtask later let it wipe newer live events)
let histId = null, booting = false;
async function reloadHistory() { // (review) overlapping loads: only the latest one owns the load state
  let mine = null;
  try { const p = rpc({ type: "get_messages" }, 60000); mine = histId = `r${reqN}`; booting = true; await p; } catch (e) { st.lastErr = `history: ${e.message}`; }
  finally { if (histId === mine || histId === null) { booting = false; histId = null; } }
  paintChrome();
}
async function pickModel(filter = "") {
  let models; try { models = (await rpc({ type: "get_available_models" })).models || []; } catch (e) { st.lastErr = `models: ${e.message}`; return paintChrome(); }
  const items = models.map((m) => ({ value: `${m.provider}\u0000${m.id}`, label: `${m.provider}/${m.id}`, description: m.name || "" }));
  const hits = items.filter((i) => !filter || i.label.toLowerCase().includes(filter.toLowerCase()));
  if (filter && hits.length === 1) return setModel(hits[0].value);
  if (dialog) { st.lastErr = "answer the open question first"; return paintChrome(); } // (review) one may have arrived meanwhile
  showPicker(`Model (now ${modelLabel()}): ↑↓ Enter, Esc cancels; type to filter`, items, (v) => v && setModel(v), null, true);
  if (filter && dialog?.all) { dialog.filter = filter; drawPicker(); }
}
async function setModel(v) {
  const [provider, modelId] = v.split("\u0000");
  try { st.model = await rpc({ type: "set_model", provider, modelId }); st.lastErr = ""; } catch (e) { st.lastErr = `model: ${e.message}`; }
  refreshState();
}
async function submit(text) {
  if (dialog?.kind === "text") { sendRaw({ type: "extension_ui_response", id: dialog.id, value: text }); closeDialog(); return; } // (review) before the empty check: "" is an answer
  const t = text.trim(); if (!t) return;
  if (t === "/quit" || t === "/exit") return quit();
  const m = t.match(/^\/model(?:\s+(.*))?$/); if (m) return pickModel((m[1] || "").trim());
  editor.addToHistory?.(t);
  if (!st.connected) { outbox.push({ text, mode: "steer" }); paintChrome(); return; } // sent as soon as the link is up (the first connect takes seconds)
  await send(text);
}
// one prompt to the remote pi; "steer" is harmless when it is idle (it just starts) and needed when it is busy, so a prompt
// is never refused because our idea of "busy" lags behind (review: queued offline prompts went out together)
async function send(text, mode = "steer") {
  try {
    const r = await rpc({ type: "prompt", message: text, streamingBehavior: mode });
    if (r?.disposition === "queued") { st.pending++; paintChrome(); }
  } catch (e) {
    // (review) a dropped link after pi accepted it but before the answer came back: it may have been sent; never call it "not sent"
    st.lastErr = e.unknown ? "the connection dropped while sending: it may have arrived (the history shows it after the reconnect); it's also back in the editor, don't resend blindly"
      : `not sent (${e.message}); it's back in the editor`;
    editor.setText([editor.getText(), text].filter(Boolean).join("\n\n")); paintChrome(); // appended: several failures don't overwrite each other
  }
}
editor.onSubmit = (text) => { if (DEBUG) process.stderr.write(`submit ${JSON.stringify(text)}\n`); editor.setText(""); submit(text).catch((e) => { st.lastErr = e.message; paintChrome(); }); };
editor.onEscape = () => {
  if (dialog?.kind === "text") { sendRaw({ type: "extension_ui_response", id: dialog.id, cancelled: true }); return closeDialog(); }
  if (st.streaming) {
    // as pi does: take the queued messages back into the editor first, so the abort doesn't run them next (review)
    rpc({ type: "clear_queue" }).then((q) => { const back = [...(q?.steering || []), ...(q?.followUp || [])]; if (back.length) editor.setText([...back, editor.getText()].filter(Boolean).join("\n\n")); st.pending = 0; paintChrome(); }, () => {})
      .finally(() => rpc({ type: "abort" }).catch(() => {})); st.lastErr = "interrupting…"; paintChrome(); setTimeout(() => { if (st.lastErr === "interrupting…") { st.lastErr = ""; paintChrome(); } }, 3000); }
};
editor.onAction("app.model.select", () => { pickModel().catch((e) => { st.lastErr = e.message; paintChrome(); }); });
editor.onAction("app.tools.expand", () => { st.expanded = !st.expanded; for (const c of chat.children) c.setExpanded?.(st.expanded); ui.requestRender(); });
editor.onAction("app.thinking.cycle", () => rpc({ type: "cycle_thinking_level" }).then(refreshState, () => {}));
editor.onAction("app.message.followUp", () => { const t = editor.getText(); if (dialog?.kind === "text") { editor.setText(""); return submit(t); } if (!t.trim()) return; editor.setText(""); if (!st.connected) { outbox.push({ text: t, mode: "followUp" }); return paintChrome(); } send(t, "followUp"); });
editor.onAction("app.clear", () => {
  if (editor.getText()) { editor.setText(""); st.quitArmed = 0; ui.requestRender(); return; }
  if (Date.now() - st.quitArmed < 1500) return quit();
  st.quitArmed = Date.now(); st.lastErr = "Ctrl+C again to close this window (the agent keeps running there)"; paintChrome();
});
editor.onCtrlD = () => quit();
// a picker (model / dialog) takes the keys while open; typing filters it
ui.addInputListener((data) => {
  if (DEBUG) process.stderr.write(`key ${JSON.stringify(data)} focus=${dialog?.kind || "editor"}\n`);
  if (dialog?.kind !== "list") return undefined;
  if (dialog.filter !== undefined && data.length === 1 && data >= " " && data !== "\x7f") { dialog.filter += data; drawPicker(); return { consume: true }; }
  if (dialog.filter !== undefined && (data === "\x7f" || matchesKey(data, "backspace"))) { dialog.filter = dialog.filter.slice(0, -1); drawPicker(); return { consume: true }; }
  return undefined;
});

// ---- the remote machine's text is untrusted: keep colour (SGR) only; drop every other escape / control sequence (OSC 52
// clipboard writes, title changes, hyperlinks, cursor moves, C1 controls), so an agent's output can't drive this terminal
const SGR = /^\x1b\[[0-9;:]*m/;
function clean(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i], c = ch.charCodeAt(0);
    if (ch === "\x1b") {
      const m = str.slice(i).match(SGR);
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
      const nx = str[i + 1];
      if (nx === "[") { const r = str.slice(i + 2).match(/^[0-9;:?<>=!]*[ -\/]*[@-~]/); i += 1 + (r ? r[0].length : 0); continue; }
      if (nx === "]" || nx === "P" || nx === "_" || nx === "^" || nx === "X") { // string sequences up to BEL or ST
        const rest = str.slice(i + 2); const j = rest.search(/\x07|\x1b\\/); i += 1 + (j < 0 ? rest.length : j + (rest[j] === "\x07" ? 1 : 2)); continue; }
      i += 1; continue; // ESC + one char
    }
    if ((c < 0x20 && ch !== "\n" && ch !== "\t") || c === 0x7f || (c >= 0x80 && c < 0xa0)) continue;
    out += ch;
  }
  return out;
}
const scrub = (v) => typeof v === "string" ? clean(v) : Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;

// ---- connection: one ssh per connect; reconnect with backoff after a drop or an expired login
let backoff = 1000, closing = false;
function connect() {
  if (closing) return;
  const child = spawn(SSH[0], [...SSH.slice(1), remoteCmd(!everConnected)], { stdio: ["pipe", "pipe", "pipe"], detached: true }); // detached: no controlling terminal, so a login tool can't prompt on (and garble) this window; it fails and we retry
  st.conn = child; let buf = "", errTail = "", hello = false, lastData = Date.now();
  // keepalive: a ping every 15 s; nothing heard for 45 s = a dead link (e.g. the laptop slept), so drop it and reconnect
  const ka = setInterval(() => {
    if (Date.now() - lastData > 45000) { errTail += "\nno answer for 45 s"; killGroup(child); return; }
    if (hello) sendRaw({ type: "broker_ping", t: Date.now() });
  }, 15000);
  child.stdout.setEncoding("utf8"); // (review) whole characters, even when a chunk ends mid-character
  child.stdout.on("data", (chunk) => {
    lastData = Date.now();
    buf += chunk; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); if (!l) continue;
      let r; try { r = scrub(JSON.parse(l)); } catch { continue; }
      if (r.type === "broker_hello") { hello = true; everConnected = true; if (r.cwd) st.cwd = r.home && r.cwd.startsWith(r.home) ? "~" + r.cwd.slice(r.home.length) : r.cwd; st.connected = true; st.lastErr = ""; backoff = 1000; paintChrome(); refreshState().then(reloadHistory).then(async () => { for (const o of outbox.splice(0)) await send(o.text, o.mode); paintChrome(); }); continue; }
      if (r.type === "broker_pong") continue;
      if (r.type === "response" && r.id && r.id === histId) { histId = null; booting = false; if (r.success !== false) renderHistory(r.data?.messages || []); }
      else if (booting && /^(message_|tool_execution_|turn_|bash_execution)/.test(r.type || "")) continue; // already in the coming snapshot (state events still apply)
      if (r.type === "broker_error" && /isn't running/.test(r.error || "") && everConnected) { stopped = true; }
      if (r.type === "response" && r.id && waiting.has(r.id)) { const f = waiting.get(r.id); waiting.delete(r.id); f(r); continue; }
      onEvent(r);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { errTail = clean(errTail + d).slice(-400); }); // (review) stderr is remote-derived too: scrubbed
  child.stdin.on("error", () => {});
  child.on("error", (e) => { errTail += `\n${e.message}`; }); // (review) a missing ssh tool: shown, then retried; "exit" may not follow
  child.on("error", () => setTimeout(() => { if (st.conn === child) child.emit("exit", null, null); }, 100));
  child.on("exit", () => {
    if (child.hDone) return; child.hDone = true;
    clearInterval(ka);
    if (st.conn === child) st.conn = null;
    st.connected = false; setWorking(false);
    for (const [id, f] of waiting) { waiting.delete(id); f({ success: false, error: "connection lost" }); }
    if (closing) return;
    booting = false; histId = null;
    if (dialog?.id) closeDialogSilently(); dialogQueue.length = 0; // the broker cancels them when no client is left; a new connect replays live ones
    if (stopped) { st.lastErr = `agent ${NAME} was stopped on the remote machine; close this window, or reopen it with: world ${WL} open ${NAME}`; paintChrome(); return; }
    const why = errTail.trim().split("\n").filter(Boolean).pop() || "";
    const expired = /expired|login|certificate|not logged in|tsh login|permission denied/i.test(errTail);
    st.lastErr = expired ? `the login to the remote machine has run out: run tsh login (or your ssh login), I'll reconnect by myself (${why.slice(0, 120)})`
      : `disconnected${why ? ": " + why.slice(0, 140) : ""}; reconnecting in ${Math.round(backoff / 1000)} s`;
    paintChrome();
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, expired ? 15000 : 30000);
    if (!hello) return;
  });
}
// the ssh runs in its own process group (detached): end the whole group, so wrappers and proxies go too (review)
function killGroup(c) { try { process.kill(-c.pid, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch {} }, 2000).unref(); }
function quit() { // the group gets SIGTERM now and SIGKILL in 1 s; we leave after that
  closing = true; const c = st.conn; try { c?.stdin.end(); if (c) process.kill(-c.pid, "SIGTERM"); } catch {}
  ui.stop(); setTimeout(() => { try { if (c) process.kill(-c.pid, "SIGKILL"); } catch {} process.exit(0); }, 1000);
}
process.on("SIGTERM", quit); process.on("SIGHUP", quit);
paintChrome();
ui.start();
connect();
