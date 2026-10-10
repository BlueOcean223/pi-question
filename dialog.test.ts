/**
 * The dialog driven the way Pi drives it: raw key strings in, rendered lines
 * and the final AskResult out. No terminal is involved — the TUI and theme are
 * stubs, and idle timing runs on fake timers.
 */

import { afterEach, describe, expect, jest, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createDialog, type DialogComponent, type DialogDeps } from "./dialog.js";
import type { AskResult, Question } from "./types.js";

const KEY = {
	enter: "\r",
	esc: "\x1b",
	tab: "\t",
	collapse: "\x1d", // Ctrl+]
};

/** Every theme call returns its text argument unstyled. */
const plainTheme = new Proxy(
	{},
	{ get: () => (...args: unknown[]) => args[args.length - 1] },
) as unknown as Theme;

const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;

function question(text: string, header: string, labels = ["A", "B"]): Question {
	return { header, question: text, options: labels.map((label) => ({ label })), multiSelect: false };
}

const ONE = [question("Which one?", "Pick")];
const TWO = [question("Which one?", "Pick"), question("And then?", "Then")];

let open: DialogComponent | undefined;

function openDialog(questions: Question[], extra: Partial<DialogDeps> = {}) {
	let result: AskResult | undefined;
	const component = createDialog({
		questions,
		cwd: "/tmp",
		externalEditorCommand: () => undefined,
		notify() {},
		...extra,
	})(tui, plainTheme, undefined, (r) => {
		result = r;
	});
	open = component;
	return {
		press(...keys: string[]) {
			for (const key of keys) component.handleInput(key);
		},
		type(text: string) {
			for (const ch of text) component.handleInput(ch);
		},
		screen: () => component.render(100).join("\n"),
		get result() {
			return result;
		},
	};
}

afterEach(() => {
	open?.dispose();
	open = undefined;
	jest.useRealTimers();
});

describe("single question", () => {
	test("a digit picks the option and submits", () => {
		const d = openDialog(ONE);
		d.press("2");
		expect(d.result?.outcome).toBe("answered");
		expect(d.result?.answers[0]).toMatchObject({ labels: ["B"], customLabels: [] });
	});

	test("typing on the free-text row answers in the user's words", () => {
		const d = openDialog(ONE);
		d.press("3"); // options take 1-2, the free-text row is 3
		d.type("check the schema first");
		expect(d.result).toBeUndefined();
		d.press(KEY.enter);
		expect(d.result?.outcome).toBe("answered");
		expect(d.result?.answers[0]).toMatchObject({
			labels: ["check the schema first"],
			customLabels: ["check the schema first"],
		});
	});

	test("Chat about this ends the dialog as chat, not as an answer", () => {
		const d = openDialog(ONE);
		d.press("5"); // free text 3, Skip 4, Chat 5
		expect(d.result?.outcome).toBe("chat");
	});

	test("Esc cancels", () => {
		const d = openDialog(ONE);
		d.press(KEY.esc);
		expect(d.result).toEqual({ questions: ONE, answers: [], outcome: "cancelled" });
	});
});

describe("several questions", () => {
	test("a pick moves on instead of submitting, and Submit sends a partial set", () => {
		const d = openDialog(TWO);
		d.press("1");
		expect(d.result).toBeUndefined();
		d.press(KEY.tab, KEY.enter); // past the unanswered question to the Submit tab
		expect(d.result?.outcome).toBe("answered");
		expect(d.result?.answers.map((a) => a.labels)).toEqual([["A"], []]);
	});
});

describe("idle auto-submit", () => {
	test("waits indefinitely when no timeout is configured", () => {
		jest.useFakeTimers();
		const d = openDialog(TWO);
		jest.advanceTimersByTime(24 * 60 * 60 * 1000);
		expect(d.result).toBeUndefined();
		expect(d.screen()).not.toContain("auto-submit");
	});

	test("submits what is selected after the configured idle and records the duration", () => {
		jest.useFakeTimers();
		const d = openDialog(TWO, { afkTimeoutMs: 90_000 });
		d.press("1");
		jest.advanceTimersByTime(89_000);
		expect(d.result).toBeUndefined();
		jest.advanceTimersByTime(1_000);
		expect(d.result?.outcome).toBe("afk");
		expect(d.result?.afkTimeoutMs).toBe(90_000);
		expect(d.result?.answers.map((a) => a.labels)).toEqual([["A"], []]);
	});

	test("a keypress restarts the idle clock", () => {
		jest.useFakeTimers();
		const d = openDialog(TWO, { afkTimeoutMs: 60_000 });
		jest.advanceTimersByTime(50_000);
		d.press("1");
		jest.advanceTimersByTime(50_000);
		expect(d.result).toBeUndefined();
	});

	test("the last stretch counts down in the hint row", () => {
		jest.useFakeTimers();
		const d = openDialog(TWO, { afkTimeoutMs: 60_000 });
		expect(d.screen()).not.toContain("auto-submit");
		jest.advanceTimersByTime(45_000);
		expect(d.screen()).toContain("auto-submit 15s");
	});

	test("a timeout shorter than the countdown counts down from the start", () => {
		jest.useFakeTimers();
		const d = openDialog(TWO, { afkTimeoutMs: 5_000 });
		expect(d.screen()).toContain("auto-submit 5s");
	});

	test("a collapsed dialog does not run out behind the user", () => {
		jest.useFakeTimers();
		const d = openDialog(TWO, { afkTimeoutMs: 60_000 });
		d.press(KEY.collapse);
		jest.advanceTimersByTime(10 * 60_000);
		expect(d.result).toBeUndefined();
		d.press(KEY.collapse);
		jest.advanceTimersByTime(60_000);
		expect(d.result?.outcome).toBe("afk");
	});
});
