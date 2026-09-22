import { describe, expect, test } from "bun:test";
import { createKeymap, formatKeySpec, type KeybindingMatcher } from "./keys.js";

/** Stands in for Pi's keybinding manager: an id -> key-data table. */
function manager(bindings: Record<string, string[]>): KeybindingMatcher {
	return { matches: (data, id) => (bindings[id] ?? []).includes(data) };
}

const ENTER = "\r";
const CTRL_ENTER = "\x1b[13;5u";

describe("createKeymap", () => {
	test("confirm follows the select binding", () => {
		const keys = createKeymap(manager({ "tui.select.confirm": [ENTER] }));
		expect(keys.confirm(ENTER)).toBe(true);
	});

	test("confirm also follows the input submit binding", () => {
		// A chat-style configuration folds enter into newLine and moves submit
		// elsewhere. Matching only tui.select.confirm would leave no confirm key.
		const keys = createKeymap(
			manager({ "tui.input.newLine": [ENTER], "tui.input.submit": [CTRL_ENTER], "tui.select.confirm": [] }),
		);
		expect(keys.confirm(CTRL_ENTER)).toBe(true);
		expect(keys.newline(ENTER)).toBe(true);
	});

	test("a key bound to both is reported by both — the caller tests newline first", () => {
		const keys = createKeymap(manager({ "tui.select.confirm": [ENTER], "tui.input.newLine": [ENTER] }));
		expect(keys.newline(ENTER)).toBe(true);
		expect(keys.confirm(ENTER)).toBe(true);
	});

	test("a remapped cancel is honored and the default is not", () => {
		const keys = createKeymap(manager({ "tui.select.cancel": ["\x11"] }));
		expect(keys.cancel("\x11")).toBe(true);
		expect(keys.cancel("\x1b")).toBe(false);
	});

	test("up and down follow the select bindings", () => {
		const keys = createKeymap(manager({ "tui.select.up": ["k"], "tui.select.down": ["j"] }));
		expect(keys.up("k")).toBe(true);
		expect(keys.down("j")).toBe(true);
		expect(keys.up("j")).toBe(false);
	});

	test("falls back to the default keys when no manager is supplied", () => {
		const keys = createKeymap(undefined);
		expect(keys.confirm(ENTER)).toBe(true);
		expect(keys.cancel("\x1b")).toBe(true);
	});

	test("tab navigation is matched directly — it has no keybinding id", () => {
		const keys = createKeymap(manager({}));
		expect(keys.nextTab("\t")).toBe(true);
		expect(keys.prevTab("\x1b[Z")).toBe(true);
	});

	test("the paste key follows Pi's own image-paste binding", () => {
		const keys = createKeymap(manager({ "app.clipboard.pasteImage": ["\x16"] }));
		expect(keys.pasteImage("\x16")).toBe(true);
		expect(keys.pasteImage("\x07")).toBe(false);
	});

	test("collapse is the fixed shortcut, regardless of the manager", () => {
		const keys = createKeymap(manager({}));
		expect(keys.collapse("\x1d")).toBe(true);
		expect(keys.collapse("\t")).toBe(false);
	});
});

describe("formatKeySpec", () => {
	test("capitalizes each part for the hint row", () => {
		expect(formatKeySpec("ctrl+]")).toBe("Ctrl+]");
		expect(formatKeySpec("alt+o")).toBe("Alt+O");
	});
});
