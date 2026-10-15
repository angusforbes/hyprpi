/**
 * quiet-tools (J637 spike, pilot P10): a quiet transcript for ONE agent, without a new TUI.
 *
 * Off unless the agent was started with PI_QUIET_TOOLS=1 (per-agent switch; nothing changes for other agents
 * even if this file is loaded for them). When on, calls to the built-in tools bash / read / edit / write (and
 * grep / find / ls) are drawn as ONE dim line each: "· $ ls -la", "· read src/x.ts", "· edit README.md". A tool
 * call that succeeds shows nothing more. A tool call that FAILS (isError) shows its full output, in the theme's
 * warning colour (not red), so the agent's recoverable retries don't look like alarms but nothing is hidden.
 * Ctrl+O (expand) still shows the full output of any call. Execution is untouched: only rendering changes.
 *
 * How: pi.registerToolRenderer((toolName, next) => renderers) (pi 1.0.2, docs/extensions.md "Tool rendering"):
 * a resolver that returns its own renderers takes precedence over the registered tool's, built-ins included;
 * next() is the renderer we would otherwise get, used here to show a failure exactly as pi would.
 * Thinking blocks are NOT reachable from the extension API: they follow the hideThinkingBlock setting (see
 * README.md next to this file).
 *
 * Try:  PI_QUIET_TOOLS=1 pi -e ./quiet-tools.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

const QUIET = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

function oneLine(name: string, args: Record<string, unknown>): string {
	const a = args ?? {};
	const s = (v: unknown) => (typeof v === "string" ? v : "");
	let what = "";
	if (name === "bash") what = "$ " + s(a.command).split("\n")[0];
	else if (name === "read" || name === "edit" || name === "write") what = `${name} ${s(a.path) || s(a.file_path)}`;
	else what = `${name} ${s(a.pattern) || s(a.path)}`.trim();
	return what.length > 100 ? what.slice(0, 97) + "…" : what;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
}

// Per-agent switch: PI_QUIET_TOOLS=1 in the agent's environment, or its hyprpi agent id listed in
// ~/.config/hyprpi/quiet-tools.json ({"agents": ["hp-…"]}). Every other agent: the extension does nothing.
function quietHere(): boolean {
	if (process.env.PI_QUIET_TOOLS === "1") return true;
	if (process.env.PI_QUIET_TOOLS === "0") return false;
	try {
		const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
		const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/hyprpi/quiet-tools.json"), "utf8"));
		const mine = [process.env.HYPRPI_AGENT_ID].filter(Boolean);
		return Array.isArray(cfg.agents) && cfg.agents.some((a: string) => mine.includes(a));
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	if (!quietHere()) return;

	// Hidden thinking shows as one dim "·" instead of "Thinking..." (hiding itself is the hideThinkingBlock setting).
	pi.on("session_start", async (_e: any, ctx: any) => ctx?.ui?.setHiddenThinkingLabel?.("·"));

	pi.registerToolRenderer((toolName: string, next: () => any) => {
		if (!QUIET.has(toolName)) return next();
		const original = next(); // what pi would draw: used as-is when expanded (ctrl+o)
		return {
			renderShell: "self",
			renderCall(args: Record<string, unknown>, theme: any, context: any) {
				if (context?.expanded && original?.renderCall) return original.renderCall(args, theme, context);
				const c = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				c.setText(theme.fg("dim", "· " + oneLine(toolName, args)));
				return c;
			},
			renderResult(result: any, options: any, theme: any, context: any) {
				if (options?.expanded && original?.renderResult) return original.renderResult(result, options, theme, context);
				const c = new Container();
				if (options?.isPartial) return c;
				if (context?.isError || result?.isError) {
					// a failure stays fully visible: every line of the output, warning colour, not red
					const out = textOf(result) || "(no output)";
					c.addChild(new Text(out.split("\n").map((l) => theme.fg("warning", "  " + l)).join("\n"), 0, 0));
				}
				return c; // success: nothing beyond the call line
			},
		};
	});
}
