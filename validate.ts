/**
 * Runtime validation of the tool call, and the strings the model reads when a
 * call is rejected before the person ever sees it.
 *
 * Pi validates the schema before `execute()`, so everything here is what the
 * schema deliberately does not enforce: uniqueness, and a lower bound on option
 * count that has to be steered rather than bounced (see `tooFewOptionsSteer`).
 */

import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, type RawQuestion } from "./types.ts";

/**
 * A one-option question is not a decision. A generic "add more options" error
 * is exactly what makes a model invent a filler second choice, so this says the
 * opposite: do not retry, state the single path and keep going.
 */
export function tooFewOptionsSteer(thin: RawQuestion[]): string {
	const details = thin
		.map((q) => {
			const labels = (q.options ?? []).map((o) => o.label).filter(Boolean);
			const only = labels.length > 0 ? ` (only: ${labels.join(", ")})` : "";
			return `"${q.question}"${only}`;
		})
		.join("; ");
	return (
		`This call included a question with fewer than ${MIN_OPTIONS} options, so it was rejected and the person never saw it. ` +
		`Rejected: ${details}. ` +
		`A question with a single option has no decision in it. Do not retry this call and do not invent a filler second option. ` +
		`Instead, state the one path you were going to offer as the approach you are taking, then continue with the task. ` +
		`If this call also contained questions with ${MIN_OPTIONS} to ${MAX_OPTIONS} options (each with distinct labels), you may re-ask those questions alone in a new call. ` +
		`Ask a question only when the person has at least two genuinely distinct choices.`
	);
}

/** Returns the model-facing rejection text, or undefined when the call is usable. */
export function validateQuestions(questions: RawQuestion[]): string | undefined {
	if (questions.length > MAX_QUESTIONS) {
		return `Error: Too many questions (${questions.length}). Ask at most ${MAX_QUESTIONS} per call.`;
	}
	const texts = new Set<string>();
	const thin: RawQuestion[] = [];
	let tooMany: string | undefined;
	let dupLabel: string | undefined;
	for (const q of questions) {
		if (texts.has(q.question)) {
			return `Error: Duplicate question text: "${q.question}". Question texts must be unique.`;
		}
		texts.add(q.question);
		const opts = q.options ?? [];
		if (opts.length < MIN_OPTIONS) {
			thin.push(q);
			continue;
		}
		if (opts.length > MAX_OPTIONS) {
			tooMany ??=
				`Error: Question "${q.question}" has ${opts.length} option(s). Provide at most ${MAX_OPTIONS} options (a free-text row is added automatically).`;
			continue;
		}
		const labels = new Set<string>();
		for (const opt of opts) {
			if (labels.has(opt.label)) {
				dupLabel ??=
					`Error: Duplicate option label "${opt.label}" in question "${q.question}". Option labels must be unique within a question.`;
				break;
			}
			labels.add(opt.label);
		}
	}
	// Too-few wins: reported alongside a too-many or duplicate error, the generic
	// message is the one the model would act on, and it is the wrong advice.
	if (thin.length > 0) return tooFewOptionsSteer(thin);
	return tooMany ?? dupLabel;
}
