/**
 * Every string the model reads back from a dialog that actually ran.
 *
 * These are prompts, not logs: each one states what happened and what to do
 * next. The tests pin them verbatim, so changing a word here is a deliberate
 * change to the tool's contract with the model.
 */

import type { Answer, AskResult, Question } from "./types.js";

/** Idle window before the dialog submits whatever is selected. */
export const AFK_TIMEOUT_MS = 5 * 60 * 1000;
/** Tail of the idle window during which the hint row shows a countdown. */
export const AFK_COUNTDOWN_MS = 20 * 1000;

/** Model-facing value when the user wrote notes but picked no option. */
export const NOTES_ONLY = "(notes only)";

export const CANCEL_TEXT =
	"User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.";

export function hasRealChoice(answer: Answer): boolean {
	return answer.labels.length > 0 && !answer.notesOnly;
}

export function formatAnswerEntry(answer: Answer): string | null {
	if (answer.notesOnly) {
		const parts = [`"${answer.question}"="${NOTES_ONLY}"`];
		if (answer.notes) parts.push(`user notes: ${answer.notes}`);
		return parts.join(" ");
	}
	if (answer.labels.length === 0 && !answer.notes) return null;
	const parts = [
		answer.labels.length > 0
			? `"${answer.question}"="${answer.labels.join(", ")}"`
			: `"${answer.question}"=(no option selected)`,
	];
	if (answer.preview) parts.push(`selected preview:\n${answer.preview}`);
	if (answer.notes) parts.push(`user notes: ${answer.notes}`);
	return parts.join(" ");
}

export function allFullyAnswered(questions: Question[], answers: Answer[]): boolean {
	const byQuestion = new Map(answers.map((a) => [a.question, a]));
	return questions.every((q) => {
		const a = byQuestion.get(q.question);
		return !!a && hasRealChoice(a) && a.customLabels.length === 0 && !a.notes && !a.notesOnly;
	});
}

export function formatAfkTimeout(timeoutMs: number): string {
	const minutes = Math.round(timeoutMs / 60_000);
	const unit = minutes === 1 ? "minute" : "minutes";
	return `The dialog auto-continued after ${minutes} ${unit} of idle (user away from keyboard).`;
}

export function formatSubmitted(result: AskResult): string {
	const body = result.answers.map(formatAnswerEntry).filter((e): e is string => e !== null).join(", ");

	if (result.outcome === "afk") {
		const timeout = formatAfkTimeout(result.afkTimeoutMs ?? AFK_TIMEOUT_MS);
		return body ? `${timeout}\n\nBefore going idle the user had selected: ${body}.` : timeout;
	}

	if (!body) {
		return "The user did not answer the questions.";
	}

	if (allFullyAnswered(result.questions, result.answers)) {
		return `Your questions have been answered: ${body}. You can now continue with these answers in mind.`;
	}

	return (
		`The user answered: ${body}. Read the answers carefully — they may request clarification, ` +
		`changes, or that you not proceed — and follow what they actually say.`
	);
}

export function formatChatAboutThis(questions: Question[], answers: Answer[]): string {
	const byQuestion = new Map(answers.map((a) => [a.question, a]));
	const lines = questions.map((q) => {
		const a = byQuestion.get(q.question);
		if (!a) return `- "${q.question}"\n  (No answer provided)`;
		const bits = [`- "${q.question}"`];
		if (a.notesOnly) bits.push(`  Answer: ${NOTES_ONLY}`);
		else if (a.labels.length > 0) bits.push(`  Answer: ${a.labels.join(", ")}`);
		else bits.push("  (No answer provided)");
		if (a.notes) bits.push(`  Notes: ${a.notes}`);
		return bits.join("\n");
	});
	return (
		"The user wants to clarify these questions.\n" +
		"    This means they may have additional information, context or questions for you.\n" +
		"    Take their response into account and then reformulate the questions if appropriate.\n" +
		"    Start by asking them what they would like to clarify.\n" +
		"\n" +
		`    Questions asked:\n${lines.join("\n")}`
	);
}
