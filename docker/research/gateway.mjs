// J372 (Angus: "change the MCP to the relay to use a different web search API / model, a different model instead of GPT sol ... and different strictnesses"):
// the research gateway's settings for ONE sandbox, in one place, with what is in effect and where each value came from.
//
// The block lives in ~/.config/hyprpi/worlds/<name>.json (the file that already holds the Doorman mode, the share level, the task and the gpu setting):
//   "gateway": {
//     "search":       { "provider": "sonar",              // sonar (default) | brave
//                       "quick_model": "perplexity/perplexity/sonar",           // sonar only (a model id on Inference Hub)
//                       "deep_model":  "perplexity/perplexity/sonar-deep-research",
//                       "key_file": "~/.config/<your-secrets>/<search-api-key>" }, // providers with their own API key (brave)
//     "report_model": "azure/openai/gpt-6-sol",      // the model that writes the report from the search results
//     "doorman_model": "azure/anthropic/claude-opus-5-5", // the model for the Doorman's research checks (plan, vet); same Inference Hub account
//     "mode":  "safe",                               // strict | safe | open | yolo (the one dial: how much Angus reviews; J412)
//     (the share level now follows the mode: strict, safe, open; the old "level" key is deprecated)
//   }
// Every key is optional. Precedence for each setting: the "gateway" block, then the older key it replaces (doorman.mode, access, research.json
// shape_model / key_file), then the built-in default. Nothing here changes any host check: cleaning, the J360 link rules, the number and copy checks and
// the Doorman's vet run the same whichever provider or model is chosen. A value that isn't valid is ignored (the default is used) and the reason is listed.
// Not covered: the Doorman's CHAT session model (set when the Doorman sandbox is created: "model" in sbx-relay.json) and its window visibility
// (developer / observer / safe / strict: "visibility" in sbx-relay.json); they are shown in the summary.
import fs from "node:fs";
import { modeOf, levelOf, MODES } from "./mode.mjs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = { provider: "sonar", quick_model: "perplexity/perplexity/sonar", deep_model: "perplexity/perplexity/sonar-deep-research", report_model: "azure/openai/gpt-6-sol", mode: "doorman-safe", level: "(derived from the mode)" };
// A search provider: the hosts the reader sandbox must reach (allowed only while it is selected) and whether it needs its own API key.
export const SEARCH_PROVIDERS = {
  sonar: { label: "Perplexity Sonar via NVIDIA Inference Hub", hosts: [], ownKey: false, models: true },
  brave: { label: "Brave Search API (results only; the report model writes the report)", hosts: ["api.search.brave.com"], ownKey: true, models: false },
};
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:+-]{0,99}$/;
const tilde = (p) => String(p || "").replace(/^~(?=\/|$)/, os.homedir());

// w = the worlds/<name>.json object (or null); research = the sandbox's entry in research.json; relay = the sbx-relay.json sandbox entries.
export function resolveGateway({ w, research = {}, relay = [], sandbox = "", levelOf = null, ambiguous = false } = {}) {
  const g = w && typeof w === "object" && w.gateway && typeof w.gateway === "object" && !Array.isArray(w.gateway) ? w.gateway : {};
  const notes = [], src = {};
  const pick = (name, vals, fallback) => { for (const [v, from] of vals) if (v !== undefined && v !== null && v !== "") { src[name] = from; return v; } src[name] = "default"; return fallback; };
  const model = (name, vals, fallback) => { const v = pick(name, vals, fallback); if (typeof v === "string" && MODEL_RE.test(v)) return v; notes.push(`${name} ${JSON.stringify(v).slice(0, 40)} isn't a model id: using ${fallback}`); src[name] = "default"; return fallback; };
  const s = g.search && typeof g.search === "object" ? g.search : {};
  let provider = pick("search.provider", [[s.provider, 'gateway.search.provider']], DEFAULTS.provider);
  if (!Object.hasOwn(SEARCH_PROVIDERS, provider)) { notes.push(`search provider ${JSON.stringify(provider).slice(0, 30)} isn't one of ${Object.keys(SEARCH_PROVIDERS).join(", ")}: using ${DEFAULTS.provider}`); provider = DEFAULTS.provider; src["search.provider"] = "default"; }
  const quick = model("search.quick_model", [[s.quick_model, "gateway.search.quick_model"]], DEFAULTS.quick_model);
  const deep = model("search.deep_model", [[s.deep_model, "gateway.search.deep_model"]], DEFAULTS.deep_model);
  const report = model("report_model", [[g.report_model, "gateway.report_model"], [research.shape_model, "research.json shape_model"]], DEFAULTS.report_model);
  const dm = relay.find((x) => x && x.doorman_for === sandbox) || {};
  const doormanChat = String(dm.model || "").replace(/^nv-claude\//, "");
  const doorman = g.doorman_model !== undefined ? model("doorman_model", [[g.doorman_model, "gateway.doorman_model"]], "") : (src.doorman_model = "the Doorman sandbox's own model", "");
  // The mode is whatever the runner resolves (mode.mjs modeOf: gateway.mode, else doorman.mode, else the deprecated research.strict), so the display can never differ from what is enforced.
  let mo = modeOf(w, relay, sandbox), mode = mo.mode, valid = (x) => MODES.includes(x);
  let modeFrom = g.mode !== undefined ? (valid(g.mode) ? "gateway.mode" : "strict (gateway.mode is invalid)") : w?.doorman?.mode !== undefined ? "doorman.mode (legacy)" : w?.research?.strict === true ? "research.strict (deprecated)" : mo.note.startsWith("legacy: Doorman") ? "developer visibility (legacy)" : "default";
  if (mo.note) notes.push(mo.note);
  src.mode = modeFrom;
  const searchKeyFile = s.key_file ? tilde(s.key_file) : "";
  if (SEARCH_PROVIDERS[provider].ownKey && !searchKeyFile) notes.push(`search provider ${provider} needs gateway.search.key_file (an API key file); research with it will fail until it is set`);
  if (ambiguous) { mode = "strict"; notes.push("several worlds files name this sandbox: the runner and the card use strict until only one does"); src.mode = "ambiguous worlds files (fail closed)"; }
  return {
    search: { provider, label: SEARCH_PROVIDERS[provider].label, quick_model: quick, deep_model: deep, key_file: searchKeyFile, hosts: SEARCH_PROVIDERS[provider].hosts.slice() },
    report_model: report, doorman_model: doorman, doorman_chat_model: doormanChat, doorman_visibility: dm.visibility || "",
    mode, ...(() => { const l = effectiveLevel({ w, relay, sandbox, mode }); return { level: l.level, levelWhy: l.why }; })(), sources: { ...src, level: null }, notes,
  };
}
// The share level in effect (J412: the mode decides; the old gateway.level / access still win, deprecated). → { level, why }
export function effectiveLevel({ w, mode = "safe" }) { return levelOf(w, mode); }
export const levelFromGateway = (w) => { const l = w?.gateway?.level; return ["open", "safe", "strict"].includes(l) ? l : null; };

// One line for a window header or a log: what is in effect.
export function summaryLine(e) {
  const short = (m) => String(m || "").split("/").pop();
  const srch = e.search.provider === "sonar" ? `search ${e.search.provider} (${short(e.search.quick_model)} / ${short(e.search.deep_model)})` : `search ${e.search.provider}`;
  return `${srch} · report ${short(e.report_model)} · Doorman ${short(e.doorman_model || e.doorman_chat_model) || "?"}${e.doorman_model ? " (checks)" : ""} · mode ${e.mode}${e.level ? ` · level ${e.level}` : ""}`;
}
export function summaryText(e, sandbox) {
  const row = (k, v, from) => `  ${k.padEnd(22)} ${String(v).padEnd(48)} ${from ? `(${from})` : ""}`;
  return [`Research gateway for ${sandbox}:`,
    row("search provider", e.search.provider, e.sources["search.provider"]), `    ${e.search.label}`,
    ...(SEARCH_PROVIDERS[e.search.provider].models ? [row("quick search model", e.search.quick_model, e.sources["search.quick_model"]), row("deep search model", e.search.deep_model, e.sources["search.deep_model"])] : [row("search API key file", e.search.key_file || "(not set)", "gateway.search.key_file"), row("reader may reach", e.search.hosts.join(", ") || "(only the inference API)", "only while selected")]),
    row("report model", e.report_model, e.sources.report_model),
    row("Doorman checks model", e.doorman_model || "(the Doorman sandbox's own)", e.sources.doorman_model), row("Doorman chat model", e.doorman_chat_model || "?", "sbx-relay.json model"),
    row("Doorman mode", e.mode, e.sources.mode), row("share level", e.level || "?", e.levelWhy),
    row("window visibility", e.doorman_visibility || "?", "sbx-relay.json visibility"),
    ...(e.notes.length ? ["  Notes:", ...e.notes.map((n) => `    - ${n}`)] : [])].join("\n");
}
