/**
 * Pure geometry for the dialog: how wide the option column gets next to a
 * preview, and how tall the body is allowed to grow before it has to scroll.
 *
 * Kept free of theme and state so the arithmetic can be tested directly — these
 * are the two calculations that go wrong silently, as a cramped preview or as a
 * dialog that runs off the top of the screen.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

// ---------- Preview columns ----------

/** Below this the preview stacks under the options instead of sitting beside them. */
export const SIDE_BY_SIDE_MIN_WIDTH = 64;
/** Columns between the option column and the preview box. */
export const PREVIEW_COLUMN_GAP = 3;
/** Floor for the option column, so short labels still leave a readable column. */
export const MIN_LEFT_WIDTH = 16;
/** The option column never takes more than this share of the pane. */
export const MAX_LEFT_RATIO = 0.5;
/** Floor for the preview box, so a long label cannot squeeze it to nothing. */
export const MIN_PREVIEW_WIDTH = 28;
/** Width of the " ✓" a confirmed option carries, reserved on every measurement. */
const CONFIRMED_MARK_WIDTH = 2;

/**
 * Width of the option column beside a preview, measured from the labels rather
 * than fixed. A fixed column is wrong in both directions: it wastes half the
 * pane on one-word labels and truncates longer ones.
 *
 * Measure the longest label plus its row prefix, then clamp: never below
 * `MIN_LEFT_WIDTH`, never past half the pane, and never so wide that the
 * preview box drops under `MIN_PREVIEW_WIDTH`.
 */
export function adaptiveLeftWidth(labels: readonly string[], optionCount: number, paneWidth: number): number {
	// "❯ " plus the digit and ". " that precede every label.
	const prefixWidth = 2 + String(Math.max(1, optionCount)).length + 2;
	let longest = 0;
	for (const label of labels) {
		const w = visibleWidth(label);
		if (w > longest) longest = w;
	}
	const desired = longest + prefixWidth + CONFIRMED_MARK_WIDTH;
	const ratioCapped = Math.min(desired, Math.floor(paneWidth * MAX_LEFT_RATIO));
	const available = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
	return Math.max(MIN_LEFT_WIDTH, Math.min(ratioCapped, Math.max(1, available)));
}

/**
 * The widest column any tab needs, so switching tabs never shifts the split.
 */
export function globalLeftWidth(labelsByTab: readonly (readonly string[])[], paneWidth: number): number {
	let max = MIN_LEFT_WIDTH;
	for (const labels of labelsByTab) {
		const w = adaptiveLeftWidth(labels, labels.length, paneWidth);
		if (w > max) max = w;
	}
	return max;
}

// ---------- Body height ----------

/**
 * Rows the surrounding Pi UI needs below the dialog — the prompt editor, the
 * footer, and a line of breathing room. The dialog renders inline above them,
 * so anything it draws past this budget pushes the top of itself off-screen.
 */
export const RESERVED_HOST_ROWS = 8;
/** Never squeeze the body below this, even on a very short terminal. */
export const MIN_BODY_HEIGHT = 6;

/**
 * Tallest body the dialog may render at this terminal height. `chromeRows` is
 * what the dialog itself spends on rules, the tab bar, and the hint row.
 */
export function bodyHeightCap(terminalRows: number, chromeRows: number): number {
	return Math.max(MIN_BODY_HEIGHT, terminalRows - RESERVED_HOST_ROWS - chromeRows);
}

export interface Window {
	start: number;
	/** Exclusive. */
	end: number;
}

/**
 * Slice of a too-tall body to show, centered on the focused line and clamped to
 * the ends. The window is exactly `cap` lines, so the caller can spend its first
 * and last line on "N more" markers without the dialog changing height.
 */
export function focusWindow(total: number, focusLine: number, cap: number): Window {
	if (cap <= 0 || total <= cap) return { start: 0, end: total };
	const centered = focusLine - Math.floor(cap / 2);
	const start = Math.max(0, Math.min(centered, total - cap));
	return { start, end: start + cap };
}
