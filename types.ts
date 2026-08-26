/**
 * Shared types, tool parameter schema, and the limits the schema and the
 * runtime validator both quote.
 */

import { Type } from "typebox";

// ---------- Limits ----------

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

// ---------- Domain ----------

export interface QuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface Question {
	header: string;
	question: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

export interface Answer {
	header: string;
	question: string;
	/** Selected option labels; a custom-typed answer is included as-is */
	labels: string[];
	/** Which labels the user typed on the free-text row */
	customLabels: string[];
	/** Free text kept as an annotation (not part of the answer) */
	notes?: string;
	/** Preview content of the selected option (single-select only) */
	preview?: string;
	/** Notes present, no option or typed answer picked. Not a vote. */
	notesOnly?: boolean;
}

export type Outcome = "answered" | "cancelled" | "chat" | "afk";

export interface AskResult {
	questions: Question[];
	answers: Answer[];
	outcome: Outcome;
	/** Set when the dialog auto-submitted after idle. Absent on every human path. */
	afkTimeoutMs?: number;
}

/** Shape the validator accepts — the raw params before defaults are filled in. */
export interface RawQuestion {
	header?: string;
	question: string;
	options?: { label: string; description?: string; preview?: string }[];
	multiSelect?: boolean;
}

// ---------- Schema ----------

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display text for this option, concise (1-5 words)" }),
	description: Type.Optional(Type.String({ description: "Explanation shown below the label" })),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional multi-line preview (code snippet, mockup, config example) rendered as markdown beside the option list while it is focused. Only for single-select questions.",
		}),
	),
});

const QuestionSchema = Type.Object({
	header: Type.String({ description: "Very short chip label for the tab bar (max 12 chars), e.g. 'Auth method'" }),
	question: Type.String({
		description: "The complete question to ask, ending with a question mark. Must be unique across questions.",
	}),
	options: Type.Array(OptionSchema, {
		// No minItems: Pi validates the schema before execute(). A min of 2
		// would bounce as a generic "array length" error and the model would
		// invent a filler option. Too-few is steered in validateQuestions.
		maxItems: MAX_OPTIONS,
		description:
			"2-4 distinct options with unique labels. Put the option you recommend first and append ' (Recommended)' to its label. Do not add Other, None, or Skip — those actions are provided automatically.",
	}),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
});

export const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "1-4 questions to ask the user",
	}),
});
