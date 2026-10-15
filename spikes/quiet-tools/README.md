# quiet-tools: a quiet transcript for one agent (J637 spike, pilot P10)

`quiet-tools.ts` draws calls to the built-in tools (bash, read, edit, write, grep, find, ls) as one dim line each. A success shows nothing more; a failure (`isError`) shows its full output in the warning colour (amber, not red). Ctrl+O still expands any call to pi's normal rendering. Hidden thinking shows as a dim `·`. Execution is unchanged.

Switch (per agent; inert for everyone else): `PI_QUIET_TOOLS=1` in the agent's environment, or its hyprpi agent id in `~/.config/hyprpi/quiet-tools.json` (`{"agents": ["hp-…"]}`); `PI_QUIET_TOOLS=0` forces it off.

What pi 1.0.2 allows:
- Tool rendering: yes, for built-ins too. `pi.registerToolRenderer((toolName, next) => renderers)` (docs/extensions.md, "Tool rendering", lines 188-190; CHANGELOG 1.0.x "Added `pi.registerToolRenderer()`") picks renderers for any tool name; a resolver that returns its own wins over the registered tool's, and `next()` gives pi's own (used here for ctrl+o and as a fallback). The older way, re-registering a built-in with `pi.registerTool({...createBashToolDefinition(cwd), renderCall, renderResult})` (examples/extensions/built-in-tool-renderer.ts), also works but replaces the tool.
- Thinking: no supported way per agent. Hiding thinking blocks is the `hideThinkingBlock` setting (docs/settings.md line 17; Ctrl+T toggles it and writes it to the user settings, i.e. for every agent). The documented extension API only changes the label shown in place of hidden thinking (`ctx.ui.setHiddenThinkingLabel`, docs/rpc-extension-ui.md line 18). An unsupported hack exists (QuietCheck637: walking the TUI's component tree from `ctx.ui.custom()` and calling `setHideThinkingBlock` on each message component), but it misses components created later and could break with any pi update, so it is not used. Per agent, thinking can only be hidden through settings that only that agent reads: its own `PI_CODING_AGENT_DIR`, or a project `.pi/settings.json` in a working directory only it uses.

Demo: `demo-open.sh normal|quiet` opens `fixture.jsonl` (5 tool calls, the last a failing bash) in a pi window on a private headless sway (scratch agent dir).
