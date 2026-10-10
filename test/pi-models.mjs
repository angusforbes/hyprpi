#!/usr/bin/env node
// J405: docker/world/pi-models.mjs merge(): a new sandbox (only its key) gets the whole standard list and
// enabledModels; one with the 32 OpenAI models (G before J405) gets exactly the 12 Claude models; an
// up-to-date one gets nothing; existing entries, the key and other settings are kept.
import fs from "node:fs";
import path from "node:path";
import { merge } from "../docker/world/pi-models.mjs";
const T = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../docker/world/nv-inference-models.json"), "utf8"));
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const claude = T.models.filter((m) => m.id.includes("anthropic"));
ok("template has 12 Claude + 32 OpenAI, no key", claude.length === 12 && T.models.length === 44 && !JSON.stringify(T).includes("apiKey"));
ok("Claude models use openai-completions", claude.every((m) => m.api === "openai-completions"));
const fresh = merge({ providers: { "nv-inference": { apiKey: "SECRET" } } }, { theme: "x" });
ok("new sandbox gets all 44", fresh.models.providers["nv-inference"].models.length === 44, `${fresh.changes.length} changes`);
ok("new sandbox keeps its key and settings", fresh.models.providers["nv-inference"].apiKey === "SECRET" && fresh.settings.theme === "x" && JSON.stringify(fresh.settings.enabledModels) === '["nv-inference/**"]');
const old = { providers: { "nv-inference": { baseUrl: T.baseUrl, api: T.api, apiKey: "K", models: T.models.filter((m) => !m.id.includes("anthropic")) } } };
const r = merge(old, { enabledModels: ["nv-inference/**"], defaultModel: "openai/openai/gpt-6-astra" });
ok("G before J405 gets exactly the 12 Claude models", r.changes.length === 12 && r.changes.every((c) => c.includes("anthropic")));
ok("default model untouched", r.settings.defaultModel === "openai/openai/gpt-6-astra");
const again = merge(r.models, r.settings);
ok("up to date: no change", again.changes.length === 0);
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
