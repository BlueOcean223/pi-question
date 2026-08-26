/**
 * Keep `ask_user_question` out of the model's tool list wherever the dialog
 * cannot render.
 *
 * Without this the tool is always advertised, and in a `pi -p` run the model
 * spends a tool call to be told "UI not available" — an interruption it cannot
 * act on, in a session with nobody to interrupt. Stripping the name from the
 * active set means it never has the option.
 *
 * The gate is `ctx.mode === "tui"` rather than `ctx.hasUI`: RPC and ACP hosts
 * report `hasUI: true` because their native select/input dialogs work, but the
 * `ui.custom()` surface this dialog is built on does not render there. `hasUI`
 * would be the honest signal only once a dialog-primitive fallback exists.
 *
 * The in-handler guard in the tool stays as a one-turn backstop, for the case
 * where a Pi change snapshots the tool list before `before_agent_start` runs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "ask_user_question";

/**
 * Strip or restore the tool to match the current mode. Idempotent: when the
 * tool is already in the right state the active set is left untouched, so
 * sibling extensions' edits to the list survive.
 */
export function reconcileTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools();
	const listed = active.includes(TOOL_NAME);
	const renderable = ctx.mode === "tui";
	if (!renderable && listed) {
		pi.setActiveTools(active.filter((n) => n !== TOOL_NAME));
	} else if (renderable && !listed) {
		pi.setActiveTools([...active, TOOL_NAME]);
	}
}

/** Run the reconciler before each turn's tool-list snapshot is taken. */
export function registerReconciler(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => reconcileTool(pi, ctx));
}
