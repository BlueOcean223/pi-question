import { describe, expect, test } from "bun:test";
import { hasPreviewLayout, rowDigit, rowsFor, sentinelsFor } from "./rows.ts";
import type { Question } from "./types.ts";

function q(over: Partial<Question> = {}): Question {
	return {
		header: "Q",
		question: "Which?",
		options: [{ label: "A" }, { label: "B" }],
		multiSelect: false,
		...over,
	};
}

const withPreview = q({ options: [{ label: "A", preview: "x" }, { label: "B" }] });

describe("hasPreviewLayout", () => {
	test("single-select with any preview", () => {
		expect(hasPreviewLayout(withPreview)).toBe(true);
	});

	test("multiSelect never gets the preview layout", () => {
		expect(hasPreviewLayout(q({ ...withPreview, multiSelect: true }))).toBe(false);
	});

	test("no previews, no preview layout", () => {
		expect(hasPreviewLayout(q())).toBe(false);
	});
});

describe("sentinelsFor", () => {
	test("plain single-select gets a free-text row, skip, and chat", () => {
		expect(sentinelsFor(q())).toEqual(["freetext", "skip", "chat"]);
	});

	test("multiSelect adds the explicit confirm row", () => {
		expect(sentinelsFor(q({ multiSelect: true }))).toEqual(["freetext", "submit", "skip", "chat"]);
	});

	test("a preview question drops the free-text row — nothing to compare a typed answer against", () => {
		expect(sentinelsFor(withPreview)).toEqual(["skip", "chat"]);
	});
});

describe("rowsFor", () => {
	test("options come first, in order, then the appended rows", () => {
		expect(rowsFor(q()).map((r) => r.kind)).toEqual(["option", "option", "freetext", "skip", "chat"]);
		expect(rowsFor(q()).map((r) => r.optionIndex)).toEqual([0, 1, -1, -1, -1]);
	});
});

describe("rowDigit", () => {
	test("appended rows continue the option numbering", () => {
		const question = q();
		expect(rowDigit(question, "freetext")).toBe(3);
		expect(rowDigit(question, "skip")).toBe(4);
		expect(rowDigit(question, "chat")).toBe(5);
	});

	test("the confirm row is unnumbered, so it does not consume a digit", () => {
		const question = q({ multiSelect: true });
		expect(rowDigit(question, "submit")).toBe(0);
		expect(rowDigit(question, "skip")).toBe(4);
		expect(rowDigit(question, "chat")).toBe(5);
	});

	test("an absent row has no digit, and the rows after it move up", () => {
		expect(rowDigit(withPreview, "freetext")).toBe(0);
		expect(rowDigit(withPreview, "skip")).toBe(3);
		expect(rowDigit(withPreview, "chat")).toBe(4);
	});

	test("in preview layout every row is numbered, so digits equal row indices", () => {
		const rows = rowsFor(withPreview);
		expect(rows.length).toBe(4);
		expect(rowDigit(withPreview, "skip")).toBe(rows.findIndex((r) => r.kind === "skip") + 1);
		expect(rowDigit(withPreview, "chat")).toBe(rows.findIndex((r) => r.kind === "chat") + 1);
	});
});
