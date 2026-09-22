/**
 * Structural checks on the three prompt surfaces.
 *
 * Prose is not pinned verbatim — it is meant to be rewritten. What is pinned is
 * the set of properties that make each surface work in the slot Pi renders it
 * into, and the pieces of guidance that were once missing and should not go
 * missing again.
 */

import { describe, expect, test } from "bun:test";
import { PROMPT_GUIDELINES, PROMPT_SNIPPET, TOOL_DESCRIPTION } from "./prompt.js";
import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./types.js";
import { TOOL_NAME } from "./reconcile.js";

describe("PROMPT_SNIPPET", () => {
	test("is present — a tool without one is dropped from the system prompt's tool list", () => {
		expect(PROMPT_SNIPPET.length).toBeGreaterThan(0);
	});

	test("is a single line: Pi collapses newlines, so they only mislead the author", () => {
		expect(PROMPT_SNIPPET).not.toContain("\n");
	});

	test("has no trailing period — it renders as the tail of `- name: <snippet>`", () => {
		expect(PROMPT_SNIPPET.trimEnd().endsWith(".")).toBe(false);
	});
});

describe("PROMPT_GUIDELINES", () => {
	test("stays short — the guidelines list is shared with Pi's own rules", () => {
		expect(PROMPT_GUIDELINES.length).toBeGreaterThan(0);
		expect(PROMPT_GUIDELINES.length).toBeLessThanOrEqual(5);
	});

	test("every line names the tool: the rendered list is flat and unattributed", () => {
		for (const guideline of PROMPT_GUIDELINES) {
			expect(guideline).toContain(TOOL_NAME);
		}
	});

	test("no duplicates — Pi dedupes by exact string, so a repeat is silently dropped", () => {
		expect(new Set(PROMPT_GUIDELINES).size).toBe(PROMPT_GUIDELINES.length);
	});

	test("carries the anti-trigger, not just the trigger", () => {
		const joined = PROMPT_GUIDELINES.join("\n");
		expect(joined).toMatch(/verify (it |the answer )?yourself|obvious default/i);
	});

	test("tells the model a partial answer is not approval", () => {
		expect(PROMPT_GUIDELINES.join("\n")).toMatch(/not approval/i);
	});

	test("says when to ask, not only whether — the unblocked work comes first", () => {
		expect(PROMPT_GUIDELINES.join("\n")).toMatch(/does not depend on the answer/i);
	});

	test("tells the model to bring its own recommendation, not merely how to format one", () => {
		// Both surfaces once said only "if you recommend an option, put it first",
		// which never asks the model to have a view in the first place.
		expect(PROMPT_GUIDELINES.join("\n")).toContain("(Recommended)");
		expect(PROMPT_GUIDELINES.join("\n")).toMatch(/the option you would pick/i);
	});
});

describe("TOOL_DESCRIPTION", () => {
	test("says when NOT to use the tool, not only when to use it", () => {
		expect(TOOL_DESCRIPTION).toContain("WHEN NOT TO USE");
	});

	test("asks for a recommendation by default, with an explicit way out", () => {
		expect(TOOL_DESCRIPTION).toContain("Default to recommending");
		expect(TOOL_DESCRIPTION).toMatch(/do not manufacture a recommendation/i);
	});

	test("forbids authoring the rows the dialog appends itself", () => {
		for (const reserved of ["Other", "None", "Skip", "Chat"]) {
			expect(TOOL_DESCRIPTION).toContain(`"${reserved}"`);
		}
	});

	test("explains every outcome — misreading one of these is the expensive failure", () => {
		for (const outcome of ["Fully answered", "Typed, not chosen", "Partial", "Declined", "Chat", "Idle auto-continue"]) {
			expect(TOOL_DESCRIPTION).toContain(outcome);
		}
	});

	test("says attached images arrive as blocks after the text, in a stated order", () => {
		// Image blocks come through anonymous; without this the model has no way
		// to tell which question the second screenshot belongs to.
		expect(TOOL_DESCRIPTION).toContain("ATTACHED IMAGES");
		expect(TOOL_DESCRIPTION).toMatch(/image blocks after the text/i);
		expect(TOOL_DESCRIPTION).toMatch(/in the order they appear/i);
	});

	test("quotes the same limits the schema and validator enforce", () => {
		expect(TOOL_DESCRIPTION).toContain(`up to ${MAX_QUESTIONS} multiple-choice questions`);
		expect(TOOL_DESCRIPTION).toContain(`${MIN_OPTIONS}-${MAX_OPTIONS} options per question`);
	});

	test("restates the trigger, which the guidelines cannot be relied on to carry", () => {
		// A user-supplied custom system prompt makes Pi skip toolSnippets and
		// promptGuidelines entirely; the description is then all the model has.
		expect(TOOL_DESCRIPTION).toContain("WHEN TO USE");
	});
});
