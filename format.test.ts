/**
 * These tests pin the exact text the model reads back. They are the
 * specification, not a smoke test — if a change here needs the expectation
 * updated, that is the signal to check the new wording still says what happened
 * and what to do next.
 */

import { describe, expect, test } from "bun:test";
import {
	allFullyAnswered,
	CANCEL_TEXT,
	formatAfkTimeout,
	formatAnswerEntry,
	formatAttachments,
	formatChatAboutThis,
	formatSubmitted,
	NOTES_ONLY,
} from "./format.js";
import type { Answer, AskResult, Question } from "./types.js";

function question(text: string, header = "Q"): Question {
	return { header, question: text, options: [{ label: "A" }, { label: "B" }], multiSelect: false };
}

function answer(text: string, over: Partial<Answer> = {}): Answer {
	return { header: "Q", question: text, labels: [], customLabels: [], ...over };
}

describe("formatAnswerEntry", () => {
	test("a plain choice is quoted question = quoted label", () => {
		expect(formatAnswerEntry(answer("Which one?", { labels: ["A"] }))).toBe('"Which one?"="A"');
	});

	test("multiple labels join with a comma", () => {
		expect(formatAnswerEntry(answer("Which?", { labels: ["A", "B"] }))).toBe('"Which?"="A, B"');
	});

	test("the selected preview is echoed so the model knows what was on screen", () => {
		expect(formatAnswerEntry(answer("Which?", { labels: ["A"], preview: "const x = 1" }))).toBe(
			'"Which?"="A" selected preview:\nconst x = 1',
		);
	});

	test("a typed answer says it was typed — it is not a label the model wrote", () => {
		expect(formatAnswerEntry(answer("Which?", { labels: ["hold on"], customLabels: ["hold on"] }))).toBe(
			'"Which?"="hold on" (typed by the user, not one of your options)',
		);
	});

	test("a typed answer alongside picked options names which one was typed", () => {
		expect(formatAnswerEntry(answer("Which?", { labels: ["A", "and Redis"], customLabels: ["and Redis"] }))).toBe(
			'"Which?"="A, and Redis" (typed by the user, not one of your options: and Redis)',
		);
	});

	test("notes ride along as an annotation, not as the answer", () => {
		expect(formatAnswerEntry(answer("Which?", { labels: ["A"], notes: "but check perf" }))).toBe(
			'"Which?"="A" user notes: but check perf',
		);
	});

	test("notes with no choice are reported as notes-only, never as a vote", () => {
		expect(formatAnswerEntry(answer("Which?", { notesOnly: true, notes: "neither" }))).toBe(
			`"Which?"="${NOTES_ONLY}" user notes: neither`,
		);
	});

	test("an attachment is named by file, next to the answer it came with", () => {
		expect(formatAnswerEntry(answer("Which?", { labels: ["A"], attachments: ["/tmp/shot.png"] }))).toBe(
			'"Which?"="A" attached: shot.png',
		);
	});

	test("an attachment on a notes-only answer is reported too", () => {
		expect(formatAnswerEntry(answer("Which?", { notesOnly: true, notes: "like this", attachments: ["/tmp/a.png"] }))).toBe(
			`"Which?"="${NOTES_ONLY}" user notes: like this attached: a.png`,
		);
	});

	test("an untouched question contributes nothing", () => {
		expect(formatAnswerEntry(answer("Which?"))).toBeNull();
	});
});

describe("formatAttachments", () => {
	const attachment = (name: string, q = "Which?") => ({ question: q, path: `/tmp/${name}`, name });

	test("numbers the images so the model can match a block to a question", () => {
		expect(formatAttachments([attachment("a.png"), attachment("b.png", "Where?")], [], true)).toBe(
			'The user attached 2 images, included after this text in that order: 1. a.png (for "Which?"), ' +
				'2. b.png (for "Where?"). This is what the user is pointing at — look at it before you answer.',
		);
	});

	test("a single-question dialog does not repeat the question it obviously belongs to", () => {
		expect(formatAttachments([attachment("a.png")], [], false)).toBe(
			"The user attached an image, included after this text in that order: 1. a.png. " +
				"This is what the user is pointing at — look at it before you answer.",
		);
	});

	test("notes about dropped or rescaled images follow the list", () => {
		expect(formatAttachments([attachment("a.png")], ["[b.png was not sent: the file is empty.]"], false)).toContain(
			"\n[b.png was not sent: the file is empty.]",
		);
	});

	test("notes alone are still reported — nothing sent is the case the model must be told about", () => {
		expect(formatAttachments([], ["the current model cannot read images"], false)).toBe(
			"the current model cannot read images",
		);
	});

	test("nothing attached and nothing to report is empty, not a stray line", () => {
		expect(formatAttachments([], [], false)).toBe("");
	});
});

describe("allFullyAnswered", () => {
	const q = question("Which?");

	test("true only when every question has a clean choice", () => {
		expect(allFullyAnswered([q], [answer("Which?", { labels: ["A"] })])).toBe(true);
	});

	test("a note means the answer is not clean", () => {
		expect(allFullyAnswered([q], [answer("Which?", { labels: ["A"], notes: "hmm" })])).toBe(false);
	});

	test("a typed answer means the answer is not clean", () => {
		expect(allFullyAnswered([q], [answer("Which?", { labels: ["C"], customLabels: ["C"] })])).toBe(false);
	});

	test("a missing question means not fully answered", () => {
		expect(allFullyAnswered([q, question("Other?", "O")], [answer("Which?", { labels: ["A"] })])).toBe(false);
	});
});

describe("formatSubmitted", () => {
	const base = (over: Partial<AskResult>): AskResult => ({
		questions: [question("Which?")],
		answers: [],
		outcome: "answered",
		...over,
	});

	test("a clean sweep gets the proceed wording", () => {
		expect(formatSubmitted(base({ answers: [answer("Which?", { labels: ["A"] })] }))).toBe(
			'Your questions have been answered: "Which?"="A". You can now continue with these answers in mind.',
		);
	});

	test("anything less gets the read-carefully wording", () => {
		expect(formatSubmitted(base({ answers: [answer("Which?", { labels: ["A"], notes: "do not ship" })] }))).toBe(
			'The user answered: "Which?"="A" user notes: do not ship. Read the answers carefully — they may request ' +
				"clarification, changes, or that you not proceed — and follow what they actually say.",
		);
	});

	test("an empty submit says so instead of pretending to be an answer", () => {
		expect(formatSubmitted(base({ answers: [answer("Which?")] }))).toBe("The user did not answer the questions.");
	});

	test("idle names itself and does not read as consent", () => {
		expect(formatSubmitted(base({ outcome: "afk", answers: [], afkTimeoutMs: 300_000 }))).toBe(
			"The dialog auto-continued after 5 minutes of idle (user away from keyboard).",
		);
	});

	test("idle with a partial selection reports it as what was selected before", () => {
		const text = formatSubmitted(
			base({ outcome: "afk", answers: [answer("Which?", { labels: ["A"] })], afkTimeoutMs: 300_000 }),
		);
		expect(text).toBe(
			"The dialog auto-continued after 5 minutes of idle (user away from keyboard).\n\n" +
				'Before going idle the user had selected: "Which?"="A".',
		);
	});
});

describe("formatAfkTimeout", () => {
	test("singular minute", () => {
		expect(formatAfkTimeout(60_000)).toBe("The dialog auto-continued after 1 minute of idle (user away from keyboard).");
	});

	test("a timeout under a minute is not rounded to zero minutes", () => {
		expect(formatAfkTimeout(30_000)).toBe("The dialog auto-continued after 30 seconds of idle (user away from keyboard).");
	});

	test("a missing duration still names the idle", () => {
		expect(formatAfkTimeout(undefined)).toBe("The dialog auto-continued after a period of idle (user away from keyboard).");
	});
});

describe("formatChatAboutThis", () => {
	test("carries the answers already given, so the choices are not lost", () => {
		const text = formatChatAboutThis(
			[question("Which?"), question("And?", "A")],
			[answer("Which?", { labels: ["A"], notes: "leaning this way" })],
		);
		expect(text).toBe(
			"The user wants to clarify these questions.\n" +
				"    This means they may have additional information, context or questions for you.\n" +
				"    Take their response into account and then reformulate the questions if appropriate.\n" +
				"    Start by asking them what they would like to clarify.\n" +
				"\n" +
				"    Questions asked:\n" +
				'- "Which?"\n' +
				"  Answer: A\n" +
				"  Notes: leaning this way\n" +
				'- "And?"\n' +
				"  (No answer provided)",
		);
	});
});

describe("CANCEL_TEXT", () => {
	test("states the fact and gives two ways forward", () => {
		expect(CANCEL_TEXT).toBe(
			"User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.",
		);
	});
});
