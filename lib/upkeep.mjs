// J125 upkeep settings: since J125 v2 they live in the master policy file ~/.config/hyprpi/hyprpi.jsonc
// (lib/policy.mjs, section "upkeep", plus thoughts.selfRefresh). This module keeps the shape the upkeep code
// uses: { prune, compactContinue, refresh, thoughts, paused, error }.
import { loadPolicy, policyFile, parseJsonc, expandHome } from "./policy.mjs";

export { parseJsonc, expandHome };
export const UPKEEP_FILE = policyFile();

export function loadUpkeep() {
  const P = loadPolicy();
  return { prune: P.upkeep.prune, compactContinue: P.upkeep.compactContinue, refresh: P.upkeep.refresh, paused: P.upkeep.paused || [], thoughts: P.thoughts.selfRefresh, error: P.error || "" };
}
