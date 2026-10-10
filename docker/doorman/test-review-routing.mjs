// node docker/doorman/test-review-routing.mjs  (J363): static checks that held items of a sandbox with "review_in" are routed to its Doorman window.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const relay = fs.readFileSync(new URL("../sbx-relay.mjs", import.meta.url), "utf8");
assert.ok(/sb\.cfg\?\.review_in/.test(relay) && /reviewIn: ri/.test(relay), "hold() records reviewIn from the sandbox's review_in");
assert.ok(/rooms: \[\/\^\[A-I\]\$\/\.test\(String\(sb\.cfg\.review_room/.test(relay), "rooms become the sandbox's own letter, not another world's Thoughts");
assert.ok(/typeof m\.reviewIn === "string"[\s\S]{0,200}doorman\.sh[\s\S]{0,60}"raise"/.test(relay), "openReview raises the Doorman window for such items");
assert.ok(/m\.reviewIn[\s\S]{0,400}return true;\s*\}\s*const world = /.test(relay), "...and returns before takeToThoughts");
assert.ok(/panel\|room panel\|doorman window/.test(relay), "the relay accepts the 'doorman window' decision route");
execFileSync("bash", ["-n", new URL("./doorman.sh", import.meta.url).pathname]);
assert.ok(/raise\)/.test(fs.readFileSync(new URL("./doorman.sh", import.meta.url), "utf8")), "doorman.sh raise exists");
const wrapper = fs.readFileSync(new URL("./doorman-view.mjs", import.meta.url), "utf8");
assert.ok(/PI_DOORMAN_REVIEW_MODULE[\s\S]{0,120}review-provider\.mjs/.test(wrapper), "the wrapper plugs in the review provider");
console.log("review-routing: all pass");
