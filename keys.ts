/**
 * Key matching for the dialog, resolved through Pi's keybinding manager rather
 * than hardcoded to the default keys.
 *
 * Hardcoding `enter` and `escape` breaks anyone who has remapped them. The
 * sharpest case: a chat-style configuration folds `enter` into
 * `tui.input.newLine` and moves submit to `ctrl+enter`. Matching only
 * `tui.select.confirm` would leave such a user with no working confirm key
 * anywhere in the dialog, so `confirm` accepts either name.
 *
 * Whichever the configuration, `newline` must be tested before `confirm` while
 * editing, so a key bound to both inserts a line instead of submitting.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";

/** The subset of Pi's KeybindingsManager the dialog needs. */
export interface KeybindingMatcher {
	matches(data: string, id: string): boolean;
}

/** Collapse/expand the dialog to read the transcript behind it. */
export const COLLAPSE_KEY = "ctrl+]";

export interface Keymap {
	up(data: string): boolean;
	down(data: string): boolean;
	firstRow(data: string): boolean;
	lastRow(data: string): boolean;
	nextTab(data: string): boolean;
	prevTab(data: string): boolean;
	/** Only meaningful outside the inline editor; test `newline` first inside it. */
	confirm(data: string): boolean;
	newline(data: string): boolean;
	cancel(data: string): boolean;
	externalEditor(data: string): boolean;
	/** Attach a clipboard image, falling back to pasting clipboard text. */
	pasteImage(data: string): boolean;
	space(data: string): boolean;
	collapse(data: string): boolean;
}

export function createKeymap(kb: KeybindingMatcher | undefined): Keymap {
	// Pi always supplies the manager. The duck-typed check, rather than a
	// truthiness test, is what keeps a host that passes a partial object from
	// throwing on every single keystroke instead of falling back to defaults.
	const resolver = typeof kb?.matches === "function" ? kb : undefined;
	const bound = (id: string, fallback: string) => (data: string) =>
		resolver ? resolver.matches(data, id) : matchesKey(data, fallback as Parameters<typeof matchesKey>[1]);

	const selectUp = bound("tui.select.up", "up");
	const selectDown = bound("tui.select.down", "down");
	const pageUp = bound("tui.select.pageUp", "pageup");
	const pageDown = bound("tui.select.pageDown", "pagedown");
	const selectConfirm = bound("tui.select.confirm", "enter");
	const inputSubmit = bound("tui.input.submit", "enter");

	return {
		up: selectUp,
		down: selectDown,
		firstRow: (d) => matchesKey(d, Key.home) || pageUp(d),
		lastRow: (d) => matchesKey(d, Key.end) || pageDown(d),
		// Tab and the horizontal arrows switch questions. Neither has a keybinding
		// id in the select context — `tui.input.tab` is autocompletion, not this.
		nextTab: (d) => matchesKey(d, Key.tab) || matchesKey(d, Key.right),
		prevTab: (d) => matchesKey(d, Key.shift("tab")) || matchesKey(d, Key.left),
		confirm: (d) => selectConfirm(d) || inputSubmit(d),
		newline: bound("tui.input.newLine", "shift+enter"),
		cancel: bound("tui.select.cancel", "escape"),
		externalEditor: bound("app.editor.external", "ctrl+g"),
		pasteImage: bound("app.clipboard.pasteImage", "ctrl+v"),
		space: (d) => matchesKey(d, Key.space),
		collapse: (d) => matchesKey(d, COLLAPSE_KEY),
	};
}

/** Pretty-print a key spec for the hint row: `ctrl+]` -> `Ctrl+]`. */
export function formatKeySpec(spec: string): string {
	return spec
		.split("+")
		.map((part) => (part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
		.join("+");
}
