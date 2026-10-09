// J333: exit 0 and print the reason when this environment is an isolated hyprpi (lib/paths.mjs
// isolatedReason), else exit 1. For shell launchers (lib/isolated-guard.sh).
import { isolatedReason } from "./paths.mjs";
const why = isolatedReason(process.env);
if (why) { console.log(why); process.exit(0); }
process.exit(1);
