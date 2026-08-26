import { describe, expect, test } from "bun:test";
import type { RawQuestion } from "./types.js";
import { validateQuestions } from "./validate.js";

const ok: RawQuestion = { question: "Which?", options: [{ label: "A" }, { label: "B" }] };

describe("validateQuestions", () => {
	test("a well-formed call passes", () => {
		expect(validateQuestions([ok])).toBeUndefined();
	});

	test("more than four questions is rejected", () => {
		const many = Array.from({ length: 5 }, (_, i) => ({ ...ok, question: `Q${i}?` }));
		expect(validateQuestions(many)).toBe("Error: Too many questions (5). Ask at most 4 per call.");
	});

	test("duplicate question text is rejected — answers are keyed by it", () => {
		expect(validateQuestions([ok, ok])).toBe(
			'Error: Duplicate question text: "Which?". Question texts must be unique.',
		);
	});

	test("duplicate option labels within a question are rejected", () => {
		expect(validateQuestions([{ question: "Which?", options: [{ label: "A" }, { label: "A" }] }])).toBe(
			'Error: Duplicate option label "A" in question "Which?". Option labels must be unique within a question.',
		);
	});

	test("more than four options is rejected", () => {
		const opts = ["A", "B", "C", "D", "E"].map((label) => ({ label }));
		expect(validateQuestions([{ question: "Which?", options: opts }])).toContain("has 5 option(s)");
	});

	test("a one-option question is steered, not bounced", () => {
		const message = validateQuestions([{ question: "Ship it?", options: [{ label: "Yes" }] }]);
		expect(message).toContain("Do not retry this call and do not invent a filler second option");
		expect(message).toContain('Rejected: "Ship it?" (only: Yes)');
	});

	test("too-few wins over a co-occurring generic error", () => {
		// Reported together, "add more options" is the advice the model would act
		// on — and it is the advice that produces a filler option.
		const message = validateQuestions([
			{ question: "Ship it?", options: [{ label: "Yes" }] },
			{ question: "Which?", options: ["A", "B", "C", "D", "E"].map((label) => ({ label })) },
		]);
		expect(message).toContain("do not invent a filler second option");
		expect(message).not.toContain("has 5 option(s)");
	});

	test("a question with no options at all is still steered by name", () => {
		expect(validateQuestions([{ question: "Ship it?" }])).toContain('Rejected: "Ship it?"');
	});
});
