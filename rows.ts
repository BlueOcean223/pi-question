/**
 * The row model of one question tab: the author's options followed by the rows
 * the dialog appends itself.
 *
 * `ROW_INTENT` is the single source of truth for which appended rows exist on a
 * given question, which of them take a `1`-`9` shortcut, and what chrome sits
 * above them. Presence, digit assignment, and the render walk all read this one
 * table, so adding a row means adding one entry instead of keeping three
 * switches in sync. `Record<RowKind, RowIntent>` makes the compiler ask for it.
 */

import type { Question } from "./types.ts";

export type RowKind = "option" | "freetext" | "submit" | "skip" | "chat";

/** Every kind except `option`, whose presence follows the author's options array. */
export type SentinelKind = Exclude<RowKind, "option">;

/** Render order of the appended rows. */
export const SENTINEL_KINDS: readonly SentinelKind[] = ["freetext", "submit", "skip", "chat"];

export interface RowIntent {
	/** Static label, or `""` when the dialog computes it (Next/Submit, Skip ✓). */
	label: string;
	/** Takes the next digit in the `1`-`9` sequence. The confirm button does not. */
	numbered: boolean;
	/**
	 * Kept on questions whose options carry a preview. The free-text row is the
	 * only false: a preview question exists to compare the artifacts on offer,
	 * and a typed fifth answer has none — `n` notes are the escape hatch there.
	 */
	presentInPreviewLayout: boolean;
	/** Only appended to multiSelect questions. */
	requiresMultiSelect: boolean;
	/** A full-width rule is drawn above the row. */
	ruleAbove: boolean;
	/** A blank line is drawn above the row. */
	blankAbove: boolean;
}

export const ROW_INTENT: Record<RowKind, RowIntent> = {
	option: {
		label: "",
		numbered: true,
		presentInPreviewLayout: true,
		requiresMultiSelect: false,
		ruleAbove: false,
		blankAbove: false,
	},
	freetext: {
		// Phrased as an action to parallel "Chat about this". "Other" reads like
		// a fifth option; this row is an invitation to write, not an answer.
		label: "Type about this",
		numbered: true,
		presentInPreviewLayout: false,
		requiresMultiSelect: false,
		ruleAbove: false,
		blankAbove: false,
	},
	submit: {
		// multiSelect keeps an explicit confirm row so Enter can stay a pure
		// toggle: "Next" moves on, "Submit" sends when this question is the whole
		// dialog. Unnumbered so it does not consume a digit.
		label: "",
		numbered: false,
		presentInPreviewLayout: true,
		requiresMultiSelect: true,
		ruleAbove: false,
		blankAbove: true,
	},
	skip: {
		// The other half of the confirm pair: settles the question *without* a
		// selection, where Next/Submit carries the selection forward.
		label: "Skip",
		numbered: true,
		presentInPreviewLayout: true,
		requiresMultiSelect: false,
		ruleAbove: false,
		blankAbove: false,
	},
	chat: {
		// Not an answer — it ends the dialog and asks the model to clarify. The
		// rule keeps it from reading as one more option below the numbered rows.
		label: "Chat about this",
		numbered: true,
		presentInPreviewLayout: true,
		requiresMultiSelect: false,
		ruleAbove: true,
		blankAbove: true,
	},
};

export interface Row {
	kind: RowKind;
	optionIndex: number;
}

/** Side-by-side/stacked preview layout: single-select with at least one preview. */
export function hasPreviewLayout(question: Question): boolean {
	return !question.multiSelect && question.options.some((o) => o.preview);
}

function isPresent(kind: SentinelKind, question: Question, previewLayout: boolean): boolean {
	const intent = ROW_INTENT[kind];
	if (previewLayout && !intent.presentInPreviewLayout) return false;
	if (intent.requiresMultiSelect && !question.multiSelect) return false;
	return true;
}

/** Appended rows for one question, in render order. */
export function sentinelsFor(question: Question): SentinelKind[] {
	const previewLayout = hasPreviewLayout(question);
	return SENTINEL_KINDS.filter((k) => isPresent(k, question, previewLayout));
}

/** Full row list for one question: options first, then the appended rows. */
export function rowsFor(question: Question): Row[] {
	const rows: Row[] = question.options.map((_, oi) => ({ kind: "option", optionIndex: oi }));
	for (const kind of sentinelsFor(question)) rows.push({ kind, optionIndex: -1 });
	return rows;
}

/**
 * Digit shown next to an appended row. Options take `1..k`, then each present
 * numbered row in order. Returns 0 for a row that is absent or unnumbered.
 */
export function rowDigit(question: Question, kind: SentinelKind): number {
	let digit = question.options.length;
	for (const k of sentinelsFor(question)) {
		if (!ROW_INTENT[k].numbered) continue;
		digit++;
		if (k === kind) return digit;
	}
	return 0;
}
