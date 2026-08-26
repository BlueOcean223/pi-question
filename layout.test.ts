import { describe, expect, test } from "bun:test";
import {
	adaptiveLeftWidth,
	bodyHeightCap,
	focusWindow,
	globalLeftWidth,
	MIN_BODY_HEIGHT,
	MIN_LEFT_WIDTH,
	MIN_PREVIEW_WIDTH,
	PREVIEW_COLUMN_GAP,
	RESERVED_HOST_ROWS,
} from "./layout.js";

describe("adaptiveLeftWidth", () => {
	test("short labels collapse to the floor instead of hogging the pane", () => {
		expect(adaptiveLeftWidth(["Yes", "No"], 2, 100)).toBe(MIN_LEFT_WIDTH);
	});

	test("longer labels widen the column to fit", () => {
		const width = adaptiveLeftWidth(["Server-side rendering"], 1, 120);
		expect(width).toBeGreaterThan(MIN_LEFT_WIDTH);
		expect(width).toBe("Server-side rendering".length + 5 + 2);
	});

	test("never takes more than half the pane", () => {
		const long = "x".repeat(200);
		expect(adaptiveLeftWidth([long], 1, 100)).toBeLessThanOrEqual(50);
	});

	test("never squeezes the preview below its floor", () => {
		const long = "x".repeat(200);
		const paneWidth = 64;
		const left = adaptiveLeftWidth([long], 1, paneWidth);
		expect(paneWidth - left - PREVIEW_COLUMN_GAP).toBeGreaterThanOrEqual(MIN_PREVIEW_WIDTH);
	});

	test("CJK labels are measured by display width, not code points", () => {
		const ascii = adaptiveLeftWidth(["aaaaaaaaaaaaaaaa"], 1, 120);
		const cjk = adaptiveLeftWidth(["中".repeat(16)], 1, 120);
		expect(cjk).toBeGreaterThan(ascii);
	});
});

describe("globalLeftWidth", () => {
	test("takes the widest tab so the split does not shift on tab switch", () => {
		const tabs = [["Yes", "No"], ["Server-side rendering", "Static"]];
		expect(globalLeftWidth(tabs, 120)).toBe(adaptiveLeftWidth(tabs[1], 2, 120));
	});

	test("no preview tabs at all still yields a sane floor", () => {
		expect(globalLeftWidth([], 120)).toBe(MIN_LEFT_WIDTH);
	});
});

describe("bodyHeightCap", () => {
	test("leaves room for the host UI and the dialog's own chrome", () => {
		expect(bodyHeightCap(50, 6)).toBe(50 - RESERVED_HOST_ROWS - 6);
	});

	test("a tiny terminal falls back to the floor rather than to zero", () => {
		expect(bodyHeightCap(10, 6)).toBe(MIN_BODY_HEIGHT);
	});
});

describe("focusWindow", () => {
	test("a body that fits is not windowed", () => {
		expect(focusWindow(10, 3, 20)).toEqual({ start: 0, end: 10 });
	});

	test("the window is exactly cap lines tall", () => {
		const w = focusWindow(100, 50, 20);
		expect(w.end - w.start).toBe(20);
	});

	test("centers on the focused line", () => {
		expect(focusWindow(100, 50, 20)).toEqual({ start: 40, end: 60 });
	});

	test("clamps at the top instead of scrolling past it", () => {
		expect(focusWindow(100, 2, 20)).toEqual({ start: 0, end: 20 });
	});

	test("clamps at the bottom instead of scrolling past it", () => {
		expect(focusWindow(100, 98, 20)).toEqual({ start: 80, end: 100 });
	});
});
