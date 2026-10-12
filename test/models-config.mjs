#!/usr/bin/env node
// J499/J500: the model config files (brev/models.jsonc, omnistation/models.jsonc, docker/world/models.jsonc), the shared resolver
// (lib/models-resolve.mjs) and the applier (lib/nv-models.mjs). Scratch HOMEs only; a fake key; never the network.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { resolveModels, jsonc } from "../lib/models-resolve.mjs";
import { applyModels } from "../lib/nv-models.mjs";
const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fails = 0; const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? ": " + x : ""}`); };
const T = JSON.parse(fs.readFileSync(path.join(R, "docker/world/nv-inference-models.json"), "utf8"));
const lapDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-lap-")); // an empty "laptop" pi dir: the presets mustn't depend on the real one
const res = (f) => resolveModels(path.join(R, f), { piDir: lapDir });

// the three config files
const b = await res("brev/models.jsonc"), h = await res("omnistation/models.jsonc"), g = await res("docker/world/models.jsonc");
ok("brev: claude3gpt3, 6 models, Opus 5.5 default", b.preset === "claude3gpt3" && b.models.length === 6 && b.default === "azure/anthropic/claude-opus-5-5" && !b.thoughts);
ok("H: claude3gpt3 + 2 Sonar = 8, Opus default, Thoughts Opus", h.models.length === 8 && h.default === "azure/anthropic/claude-opus-5-5" && h.thoughts === "azure/anthropic/claude-opus-5-5" && h.models.slice(-2).every((m) => m.id.includes("sonar")));
ok("G: claude3gpt3, Opus 5.5 default", g.preset === "claude3gpt3" && g.models.length === 6 && g.default === "azure/anthropic/claude-opus-5-5");
{ const f = path.join(lapDir, "cat.jsonc"); fs.writeFileSync(f, '{"preset":"catalog","default":"openai/openai/gpt-6-astra"}'); const c = await resolveModels(f, { piDir: lapDir });
  ok("catalog: the whole standard list in its order, entries passed on whole (api made explicit)", JSON.stringify(c.models.map((m) => m.id)) === JSON.stringify(T.models.map((m) => m.id)) && JSON.stringify({ ...T.models[0], api: "openai-responses" }) === JSON.stringify(c.models[0])); }

// JSONC, presets, deny
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-"));
const cfg = (o) => { const f = path.join(tmp, `c${Math.random()}.jsonc`); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); return f; };
ok("JSONC: comments, block comments, trailing commas, strings kept", JSON.stringify(jsonc('{ "a": "x, ] // y", /* c */ "b": [1, 2,], // z\n}')) === '{"a":"x, ] // y","b":[1,2]}');
const k = await resolveModels(cfg({ preset: "mine", mine: ["openai/openai/gpt-6-sol"], default: "openai/openai/gpt-6-astra", add: ["nvidia/moonshotai/kimi-k3"], deny: [{ pattern: "*kimi*", why: "garbled" }] }), { piDir: lapDir });
ok("any named list is a preset; default included; Kimi denied with its reason", k.models.map((m) => m.id).join() === "openai/openai/gpt-6-astra,openai/openai/gpt-6-sol" && k.denied[0]?.why === "garbled");
let e = ""; try { await resolveModels(cfg({ preset: "x", x: ["no/such"] }), { piDir: lapDir }); } catch (x) { e = x.message; }
ok("unknown model without details: a clear error", /no details for no\/such/.test(e));
e = ""; try { await resolveModels(cfg({ preset: "catalog", default: "openai/openai/gpt-6-sol", exclude: ["openai/openai/gpt-6-sol"] }), { piDir: lapDir }); } catch (x) { e = x.message; }
ok("an excluded default: a clear error", /excluded or denied/.test(e));

// applyModels
const before = { models: { providers: { other: { x: 1 }, "nv-inference": { apiKey: "!keep-me", models: [] } } }, settings: { theme: "t", enabledModels: ["other/a", "nv-inference/old/one", "nv-inference/openai/**"] }, config: { pi: "p" } };
const a1 = applyModels(before, h, { keyCmd: "!new" });
const nv = a1.models.providers["nv-inference"];
ok("other providers, an existing apiKey and other settings are kept", a1.models.providers.other.x === 1 && nv.apiKey === "!keep-me" && a1.settings.theme === "t");
ok("per-model api only where it differs from the provider's", nv.models.every((m) => (m.id.includes("openai/") ? !("api" in m) : m.api === "openai-completions")));
ok("enabledModels: explicit nv-inference entries replaced, globs and other providers kept", a1.settings.enabledModels[0] === "other/a" && a1.settings.enabledModels[1] === "nv-inference/openai/**" && !a1.settings.enabledModels.includes("nv-inference/old/one") && a1.settings.enabledModels.length === 2 + h.models.length);
ok("enabledModels with nv-inference/**: nothing added", applyModels({ ...before, settings: { enabledModels: ["nv-inference/**"] } }, h).settings.enabledModels.length === 1);
ok("defaults: pi's default and the list's Thoughts", a1.settings.defaultModel === h.default && a1.config.thoughtsModel === h.thoughts);
ok("Thoughts: nv-inference/<default> without a list Thoughts; an override leaves it alone", applyModels({ models: {}, settings: {}, config: {} }, b).config.thoughtsModel === "nv-inference/" + b.default && applyModels({ models: {}, settings: {}, config: { thoughtsModel: "z" } }, b, { thoughtsOverride: "y" }).config.thoughtsModel === "z");
ok("no apiKey and none given: none set; given: set", !("apiKey" in applyModels({ models: {}, settings: {} }, g).models.providers["nv-inference"]) && applyModels({ models: {}, settings: {} }, g, { keyCmd: "!k" }).models.providers["nv-inference"].apiKey === "!k");
const a2 = applyModels({ models: a1.models, settings: a1.settings, config: a1.config }, h, { keyCmd: "!new" });
ok("idempotent", JSON.stringify(a2.models) === JSON.stringify(a1.models) && JSON.stringify(a2.settings) === JSON.stringify(a1.settings));

// the CLI in a scratch HOME (no network: no --check)
const H = fs.mkdtempSync(path.join(os.tmpdir(), "mc-home-")), list = path.join(tmp, "nv.json"); fs.writeFileSync(list, JSON.stringify(b));
const run = (extra = [], env = {}) => { try { return execFileSync("node", [path.join(R, "lib/nv-models.mjs"), "--models", list, ...extra], { encoding: "utf8", env: { ...process.env, HOME: H, XDG_CONFIG_HOME: path.join(H, ".config"), ...env } }); } catch (x) { return (x.stdout || "") + `exit ${x.status}`; } };
ok("no key file: says so, writes nothing", /no key at/.test(run()) && !fs.existsSync(path.join(H, ".pi/agent/models.json")));
fs.mkdirSync(path.join(H, "workspace/.secrets"), { recursive: true, mode: 0o700 }); const KF = path.join(H, "workspace/.secrets/nv_inference_key");
fs.writeFileSync(KF, "nvapi-FAKE\n", { mode: 0o600 }); ok("nvapi key refused", /build\.nvidia\.com key/.test(run()));
fs.writeFileSync(KF, "sk-FAKE-J500\n"); fs.chmodSync(KF, 0o644); ok("loose key permissions refused", /must be 600/.test(run()));
fs.chmodSync(KF, 0o600);
fs.mkdirSync(path.join(H, ".config/hyprpi"), { recursive: true }); fs.writeFileSync(path.join(H, ".config/hyprpi/config.json"), '{"pi":"x"}\n');
const o1 = run(), o2 = run();
ok("first run writes, second changes nothing", /updated models\.json, settings\.json, thoughtsModel/.test(o1) && /unchanged/.test(o2), o2.trim());
const all = execFileSync("sh", ["-c", `grep -rl sk-FAKE-J500 ${H} || true`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
ok("the key is only in its own file", all.length === 1 && all[0] === KF && !/sk-FAKE/.test(o1 + o2));
fs.writeFileSync(path.join(H, ".pi/agent/settings.json"), "{bad");
const m0 = fs.readFileSync(path.join(H, ".pi/agent/models.json"), "utf8");
ok("a broken settings.json stops it before anything is written", /isn't a JSON object/.test(run()) && fs.readFileSync(path.join(H, ".pi/agent/models.json"), "utf8") === m0);
ok("--key-file none with --check is refused", /needs a key file/.test(run(["--key-file", "none", "--check"])));
for (const d of [tmp, H, lapDir]) fs.rmSync(d, { recursive: true, force: true });
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
