/**
 * Every string the model reads back from a dialog that actually ran.
 *
 * These are prompts, not logs: each one states what happened and what to do
 * next. The tests pin them verbatim, so changing a word here is a deliberate
 * change to the tool's contract with the model.
 */

import { basename } from "node:path";
import { formatDuration } from "./afk.js";
import type { Attachment } from "./images.js";
import type { Answer, AskResult, Question } from "./types.js";

/** Model-facing value when the user wrote notes but picked no option. */
export const NOTES_ONLY = "(notes only)";

export const CANCEL_TEXT =
	"User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.";

export function hasRealChoice(answer: Answer): boolean {
	return answer.labels.length > 0 && !answer.notesOnly;
}

/** `attached: a.png, b.png`, or nothing when the answer carries no image. */
function attachmentSuffix(answer: Answer): string[] {
	if (!answer.attachments || answer.attachments.length === 0) return [];
	return [`attached: ${answer.attachments.map((path) => basename(path)).join(", ")}`];
}

export function formatAnswerEntry(answer: Answer): string | null {
	if (answer.notesOnly) {
		const parts = [`"${answer.question}"="${NOTES_ONLY}"`];
		if (answer.notes) parts.push(`user notes: ${answer.notes}`);
		parts.push(...attachmentSuffix(answer));
		return parts.join(" ");
	}
	if (answer.labels.length === 0 && !answer.notes) return null;
	const parts = [
		answer.labels.length > 0
			? `"${answer.question}"="${answer.labels.join(", ")}"`
			: `"${answer.question}"=(no option selected)`,
	];
	// A typed answer reads exactly like a label the model wrote, so say which it
	// was. The two are not interchangeable: typed text is often an instruction,
	// not a pick from the list.
	if (answer.customLabels.length > 0) {
		parts.push(
			answer.customLabels.length === answer.labels.length
				? "(typed by the user, not one of your options)"
				: `(typed by the user, not one of your options: ${answer.customLabels.join(", ")})`,
		);
	}
	if (answer.preview) parts.push(`selected preview:\n${answer.preview}`);
	if (answer.notes) parts.push(`user notes: ${answer.notes}`);
	parts.push(...attachmentSuffix(answer));
	return parts.join(" ");
}

/**
 * Where the image blocks that follow this text came from.
 *
 * Image blocks arrive anonymous and in one flat list, so this is the only thing
 * tying image number 2 to the question it answers. The blocks are appended in
 * exactly this order.
 */
export function formatAttachments(attached: Attachment[], notes: string[], labelQuestions: boolean): string {
	const lines: string[] = [];
	if (attached.length > 0) {
		const list = attached
			.map((a, i) => `${i + 1}. ${a.name}${labelQuestions ? ` (for "${a.question}")` : ""}`)
			.join(", ");
		lines.push(
			`The user attached ${attached.length === 1 ? "an image" : `${attached.length} images`}, ` +
				`included after this text in that order: ${list}. ` +
				`This is what the user is pointing at — look at it before you answer.`,
		);
	}
	lines.push(...notes);
	return lines.join("\n");
}

export function allFullyAnswered(questions: Question[], answers: Answer[]): boolean {
	const byQuestion = new Map(answers.map((a) => [a.question, a]));
	return questions.every((q) => {
		const a = byQuestion.get(q.question);
		return !!a && hasRealChoice(a) && a.customLabels.length === 0 && !a.notes && !a.notesOnly;
	});
}

export function formatAfkTimeout(timeoutMs: number | undefined): string {
	const after = timeoutMs ? `after ${formatDuration(timeoutMs)} of idle` : "after a period of idle";
	return `The dialog auto-continued ${after} (user away from keyboard).`;
}

export function formatSubmitted(result: AskResult): string {
	const body = result.answers.map(formatAnswerEntry).filter((e): e is string => e !== null).join(", ");

	if (result.outcome === "afk") {
		const timeout = formatAfkTimeout(result.afkTimeoutMs);
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
