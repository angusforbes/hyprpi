// J125 upkeep settings: since J125 v2 they live in the master policy file ~/.config/hyprpi/hyprpi.jsonc
// (lib/policy.mjs, section "upkeep", plus thoughts.selfRefresh). This module keeps the shape the upkeep code
// uses: { prune, compactContinue, refresh, thoughts, paused, error }.
import { loadPolicy, policyFile, parseJsonc, expandHome, statePath } from "./policy.mjs";

export { parseJsonc, expandHome, statePath };
export const UPKEEP_FILE = policyFile();

export function loadUpkeep() {
  const P = loadPolicy();
  // J437: the folders become absolute and follow HYPRPI_STATE (statePath), so an isolated daemon's handoffs and
  // pruned outputs stay in its own state folder.
  const prune = { ...P.upkeep.prune, saveDir: statePath(P.upkeep.prune?.saveDir || "~/.local/state/hyprpi/pruned") };
  const refresh = { ...P.upkeep.refresh, handoffDir: statePath(P.upkeep.refresh?.handoffDir || "~/.local/state/hyprpi/handoffs") };
  return { prune, compactContinue: P.upkeep.compactContinue, refresh, paused: P.upkeep.paused || [], thoughts: P.thoughts.selfRefresh, error: P.error || "" };
}
