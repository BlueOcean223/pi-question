/**
 * pi-question — AskUserQuestion tool for pi
 *
 * Interactive multiple-choice questions with a free-text escape hatch:
 * - Single question: option list; single-select submits on pick
 * - Multiple questions: tab bar (header chips) + Submit review page
 * - Number keys 1-9 select directly (full-width digits normalized)
 * - "Type about this" is an inline input row: focus it and just start typing
 * - Skip: leave a question unanswered and continue (partial submit allowed)
 * - multiSelect: Space/Enter toggle, explicit Next/Submit button confirms
 * - "Chat about this": ends the dialog asking the model to clarify instead;
 *   a rule sets it apart from the option and action rows above it
 * - Option previews: side-by-side layout, markdown-rendered; no free-text row
 *   there — `n` notes are the escape hatch while comparing options
 * - Answers keyed by full question text; notes/preview echoed as annotations
 * - 5-minute idle auto-submits whatever is selected so far
 * - Stable layout: every tab padded to the tallest question's height
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Input,
	Key,
	Markdown,
	matchesKey,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------- Types ----------

interface QuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

interface Question {
	header: string;
	question: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

interface Answer {
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

type Outcome = "answered" | "cancelled" | "chat" | "afk";

interface AskResult {
	questions: Question[];
	answers: Answer[];
	outcome: Outcome;
	/** Set when the dialog auto-submitted after idle. Absent on every human path. */
	afkTimeoutMs?: number;
}

type EditKind = "none" | "freetext" | "notes";

interface Row {
	kind: "option" | "freetext" | "submit" | "skip" | "chat";
	optionIndex: number;
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
		maxItems: 4,
		description:
			"2-4 distinct options with unique labels. If you recommend one, put it first and append ' (Recommended)' to its label. Do not add Other, None, or Skip — those actions are provided automatically.",
	}),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4, description: "1-4 questions to ask the user" }),
});

// ---------- Model-facing result strings ----------

/** Model-facing value when the user wrote notes but picked no option. */
const NOTES_ONLY = "(notes only)";

const CANCEL_TEXT =
	"User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.";

const AFK_TIMEOUT_MS = 5 * 60 * 1000;
const AFK_COUNTDOWN_MS = 20 * 1000;

function hasRealChoice(answer: Answer): boolean {
	return answer.labels.length > 0 && !answer.notesOnly;
}

function formatAnswerEntry(answer: Answer): string | null {
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

function allFullyAnswered(questions: Question[], answers: Answer[]): boolean {
	const byQuestion = new Map(answers.map((a) => [a.question, a]));
	return questions.every((q) => {
		const a = byQuestion.get(q.question);
		return !!a && hasRealChoice(a) && a.customLabels.length === 0 && !a.notes && !a.notesOnly;
	});
}

function formatAfkTimeout(timeoutMs: number): string {
	const minutes = Math.round(timeoutMs / 60_000);
	const unit = minutes === 1 ? "minute" : "minutes";
	return `The dialog auto-continued after ${minutes} ${unit} of idle (user away from keyboard).`;
}

function formatSubmitted(result: AskResult): string {
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

function formatChatAboutThis(questions: Question[], answers: Answer[]): string {
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

// ---------- Helpers ----------

const MAX_QUESTIONS = 4;
const PREVIEW_MAX_LINES = 12;
const SIDE_BY_SIDE_MIN_WIDTH = 64;
/** Label of the inline free-text row, phrased to parallel "Chat about this". */
const FREETEXT_LABEL = "Type about this";

function errorResult(message: string, questions: Question[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { questions, answers: [], outcome: "cancelled" } as AskResult,
	};
}

function tooFewOptionsSteer(
	thin: { question: string; options?: { label: string }[] }[],
): string {
	const details = thin
		.map((q) => {
			const labels = (q.options ?? []).map((o) => o.label).filter(Boolean);
			const only = labels.length > 0 ? ` (only: ${labels.join(", ")})` : "";
			return `"${q.question}"${only}`;
		})
		.join("; ");
	return (
		`This call included a question with fewer than 2 options, so it was rejected and the person never saw it. ` +
		`Rejected: ${details}. ` +
		`A question with a single option has no decision in it. Do not retry this call and do not invent a filler second option. ` +
		`Instead, state the one path you were going to offer as the approach you are taking, then continue with the task. ` +
		`If this call also contained questions with 2 to 4 options (each with distinct labels), you may re-ask those questions alone in a new call. ` +
		`Ask a question only when the person has at least two genuinely distinct choices.`
	);
}

function validateQuestions(questions: { question: string; options?: { label: string }[] }[]): string | undefined {
	if (questions.length > MAX_QUESTIONS) {
		return `Error: Too many questions (${questions.length}). Ask at most ${MAX_QUESTIONS} per call.`;
	}
	const texts = new Set<string>();
	const thin: { question: string; options?: { label: string }[] }[] = [];
	let tooMany: string | undefined;
	let dupLabel: string | undefined;
	for (const q of questions) {
		if (texts.has(q.question)) {
			return `Error: Duplicate question text: "${q.question}". Question texts must be unique.`;
		}
		texts.add(q.question);
		const opts = q.options ?? [];
		if (opts.length < 2) {
			thin.push(q);
			continue;
		}
		if (opts.length > 4) {
			tooMany ??=
				`Error: Question "${q.question}" has ${opts.length} option(s). Provide at most 4 options (a free-text row is added automatically).`;
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
	// Too-few wins: a generic "add more options" error is exactly what makes
	// the model invent a filler second choice.
	if (thin.length > 0) return tooFewOptionsSteer(thin);
	return tooMany ?? dupLabel;
}

/** Extract a printable character from raw input (legacy or Kitty protocol). */
function printableChar(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.length === 1 && data >= " " && data !== "\x7f") return data;
	return undefined;
}

/** Map '1'-'9' and full-width '１'-'９' to 1-9 (CJK input method friendly). */
function asDigit(ch: string): number | undefined {
	const c = ch.codePointAt(0) ?? 0;
	if (c >= 0x31 && c <= 0x39) return c - 0x30;
	if (c >= 0xff11 && c <= 0xff19) return c - 0xff10;
	return undefined;
}

function padToWidth(s: string, width: number): string {
	return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

// ---------- Extension ----------

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user one or more questions when you are blocked on a decision that is genuinely theirs to make — choosing between approaches, clarifying ambiguous requirements, or picking preferences you cannot infer. Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed. Each question shows 2-4 options plus an automatic free-text row and a Skip action — do not add Other, None, or Skip as options. Questions carrying option previews are for comparing: they drop the free-text row and offer a notes field instead. Use multiSelect for non-exclusive choices. Use option previews (code snippets, mockups) when users need to visually compare concrete artifacts. If you recommend an option, put it first and append ' (Recommended)' to its label. The user may skip questions or submit a partial answer; read skips and notes carefully — they may ask you not to proceed. The user may also chat about the questions instead of answering — treat that as a request for clarification, not a refusal.",
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (!params.questions || params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}
			const invalid = validateQuestions(params.questions);
			if (invalid) return errorResult(invalid);

			const questions: Question[] = params.questions.map((q, i) => ({
				header: (q.header || `Q${i + 1}`).slice(0, 12),
				question: q.question,
				options: q.options ?? [],
				multiSelect: q.multiSelect === true,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			// Hide the animated working spinner while the dialog is up. If the
			// dialog fills the screen the spinner row lands above the viewport,
			// and every 80ms animation frame then forces a full redraw that
			// clears the terminal scrollback — making wheel scrolling impossible.
			ctx.ui.setWorkingVisible(false);
			let result: AskResult;
			try {
				if (signal?.aborted) {
					result = { questions, answers: [], outcome: "cancelled" };
				} else {
				result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
				// ---- State ----
				let currentTab = 0;
				let editing: EditKind = "none";
				let cachedLines: string[] | undefined;
				const cursorByQ = questions.map(() => 0);
				// Sticky "which option's preview is showing" for preview-layout
				// questions: stays put when focus moves onto Skip/Chat, instead of
				// snapping to whichever option happens to sit last in the list.
				const lastOptionByQ = questions.map(() => 0);
				const picked = questions.map(() => new Set<number>());
				const freeform = questions.map(() => "");
				const freeformSelected = questions.map(() => false);
				const skipped = questions.map(() => false);
				// Preview-question "n" notes live in their own field: the free-text
				// row is absent there, so the two never share storage.
				const notesText = questions.map(() => "");

				let lastActivity = Date.now();
				let afkTimer: ReturnType<typeof setInterval> | undefined;

				const mdTheme = getMarkdownTheme();
				const mdCache = new Map<string, string[]>(); // `${qi}:${oi}:${width}` -> rendered lines
				const heightCache = new Map<number, number>(); // width -> global body height

				const input = new Input();

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				// ---- Question/row model ----

				function q(i: number = currentTab): Question {
					return questions[Math.min(i, questions.length - 1)];
				}

				function hasPreviewLayout(question: Question): boolean {
					return !question.multiSelect && question.options.some((o) => o.preview);
				}

				function rowsFor(qi: number): Row[] {
					const question = questions[qi];
					const rows: Row[] = question.options.map((_, oi) => ({ kind: "option", optionIndex: oi }));
					// Preview questions have no free-text row: they exist to compare the
					// concrete artifacts on offer, and a typed answer has none. The `n`
					// notes line is the escape hatch there instead.
					if (!hasPreviewLayout(question)) rows.push({ kind: "freetext", optionIndex: -1 });
					// multiSelect keeps an explicit confirm row so Enter can stay a pure
					// toggle: "Next" moves on to the following question, "Submit" (when this
					// question is the whole dialog) sends. Skip is the other thing entirely —
					// it settles the question without a selection.
					if (question.multiSelect) rows.push({ kind: "submit", optionIndex: -1 });
					rows.push({ kind: "skip", optionIndex: -1 });
					rows.push({ kind: "chat", optionIndex: -1 });
					return rows;
				}

				/**
				 * Digit shown next to a non-option row. Options take 1..k, then the
				 * free-text row (when present), then Skip and Chat — the Next/Submit
				 * button is unnumbered, so it does not consume a digit.
				 */
				function rowDigit(question: Question, kind: "freetext" | "skip" | "chat"): number {
					const afterOptions = question.options.length + (hasPreviewLayout(question) ? 0 : 1);
					if (kind === "freetext") return afterOptions;
					return kind === "skip" ? afterOptions + 1 : afterOptions + 2;
				}

				function cursor(): number {
					return cursorByQ[currentTab] ?? 0;
				}

				function setCursor(v: number) {
					const rows = rowsFor(currentTab);
					const clamped = Math.max(0, Math.min(v, rows.length - 1));
					cursorByQ[currentTab] = clamped;
					const row = rows[clamped];
					if (row.kind === "option") lastOptionByQ[currentTab] = row.optionIndex;
				}

				function isAnswered(qi: number): boolean {
					return picked[qi].size > 0 || (freeformSelected[qi] && freeform[qi].trim().length > 0);
				}

				function hasNotes(qi: number): boolean {
					return notesText[qi].trim().length > 0 || (freeform[qi].trim().length > 0 && !freeformSelected[qi]);
				}

				function isSettled(qi: number): boolean {
					return isAnswered(qi) || skipped[qi];
				}

				function allSettled(): boolean {
					return questions.every((_, i) => isSettled(i));
				}

				function buildAnswer(qi: number): Answer {
					const question = questions[qi];
					const labels = [...picked[qi]].sort((a, b) => a - b).map((idx) => question.options[idx].label);
					const text = freeform[qi].trim();
					const custom = freeformSelected[qi] && text ? [text] : [];
					// Typed text the user didn't end up voting with rides along as a note
					// instead of being dropped. Only one source can be set per question:
					// preview questions have `n` notes and no free-text row, and vice versa.
					const strayTyped = text && custom.length === 0 ? text : undefined;
					const noteFromN = notesText[qi].trim() || undefined;
					const notes = noteFromN ?? strayTyped;
					let preview: string | undefined;
					if (!question.multiSelect && picked[qi].size === 1) {
						preview = question.options[[...picked[qi]][0]].preview;
					}
					const chosen = [...labels, ...custom];
					const notesOnly = chosen.length === 0 && !!notes;
					return {
						header: question.header,
						question: question.question,
						labels: chosen,
						customLabels: custom,
						...(notesOnly ? { notesOnly: true } : {}),
						...(notes ? { notes } : {}),
						...(preview ? { preview } : {}),
					};
				}

				function flushEdits() {
					if (editing === "freetext") {
						freeform[currentTab] = input.getValue();
						const text = freeform[currentTab].trim();
						if (text && picked[currentTab].size === 0) freeformSelected[currentTab] = true;
						else if (!text) freeformSelected[currentTab] = false;
					} else if (editing === "notes") {
						notesText[currentTab] = input.getValue();
					}
					editing = "none";
					input.focused = false;
				}

				// ---- Submission ----

				let finished = false;
				function finish(result: AskResult) {
					if (finished) return;
					finished = true;
					signal?.removeEventListener("abort", onAbort);
					clearInterval(afkTimer);
					done(result);
				}

				function onAbort() {
					finish({ questions, answers: [], outcome: "cancelled" });
				}
				signal?.addEventListener("abort", onAbort);

				function submitAnswered() {
					flushEdits();
					finish({ questions, answers: questions.map((_, i) => buildAnswer(i)), outcome: "answered" });
				}

				function submitCancel() {
					finish({ questions, answers: [], outcome: "cancelled" });
				}

				function submitChat() {
					flushEdits();
					const answers = questions
						.map((_, i) => i)
						.filter((i) => isAnswered(i) || hasNotes(i))
						.map((i) => buildAnswer(i));
					finish({ questions, answers, outcome: "chat" });
				}

				function submitAfk() {
					flushEdits();
					finish({
						questions,
						answers: questions.map((_, i) => buildAnswer(i)),
						outcome: "afk",
						afkTimeoutMs: AFK_TIMEOUT_MS,
					});
				}

				function skipQuestion() {
					const i = currentTab;
					picked[i].clear();
					freeformSelected[i] = false;
					skipped[i] = true;
					if (!isMulti) {
						submitAnswered();
						return;
					}
					advanceAfterAnswer();
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submitAnswered();
						return;
					}
					let next = questions.length;
					for (let step = 1; step <= questions.length; step++) {
						const cand = (currentTab + step) % questions.length;
						if (!isSettled(cand)) {
							next = cand;
							break;
						}
					}
					currentTab = next;
					refresh();
				}

				// ---- Actions ----

				function commitOption(oi: number) {
					const i = currentTab;
					picked[i].clear();
					picked[i].add(oi);
					freeformSelected[i] = false;
					skipped[i] = false;
					advanceAfterAnswer();
				}

				function toggleOption(oi: number) {
					const i = currentTab;
					if (picked[i].has(oi)) picked[i].delete(oi);
					else picked[i].add(oi);
					if (picked[i].size > 0) skipped[i] = false;
					refresh();
				}

				function commitCustom() {
					const i = currentTab;
					picked[i].clear();
					freeformSelected[i] = true;
					skipped[i] = false;
					advanceAfterAnswer();
				}

				function startFreetextEdit(seedData?: string) {
					editing = "freetext";
					input.setValue(freeform[currentTab]);
					input.focused = true;
					if (seedData) input.handleInput(seedData);
					refresh();
				}

				function startNotesEdit() {
					editing = "notes";
					input.setValue(notesText[currentTab]);
					input.focused = true;
					refresh();
				}

				/** Save the inline typed text without committing it as the answer. */
				function saveFreetextEdit() {
					const i = currentTab;
					freeform[i] = input.getValue();
					const text = freeform[i].trim();
					if (text) {
						// Tentatively selected unless an option is already picked
						// (then the text rides along as a note instead).
						if (picked[i].size === 0) {
							freeformSelected[i] = true;
							skipped[i] = false;
						}
					} else {
						freeformSelected[i] = false;
					}
					editing = "none";
					input.focused = false;
					refresh();
				}

				function saveNotesEdit() {
					notesText[currentTab] = input.getValue();
					editing = "none";
					input.focused = false;
					refresh();
				}

				input.onEscape = () => {
					if (editing === "freetext") saveFreetextEdit();
					else if (editing === "notes") saveNotesEdit();
				};

				input.onSubmit = (value) => {
					const i = currentTab;
					if (editing === "notes") {
						saveNotesEdit();
						return;
					}
					freeform[i] = value;
					editing = "none";
					input.focused = false;
					const text = value.trim();
					if (!text) {
						freeformSelected[i] = false;
						refresh();
						return;
					}
					if (q().multiSelect) {
						freeformSelected[i] = true; // included in the selection set; keep toggling
						skipped[i] = false;
						refresh();
					} else {
						commitCustom();
					}
				};

				function switchTab(delta: number) {
					currentTab = (currentTab + delta + totalTabs) % totalTabs;
					refresh();
				}

				function pressSubmitRow() {
					const i = currentTab;
					if (!isMulti) {
						submitAnswered();
						return;
					}
					if (isSettled(i)) {
						advanceAfterAnswer();
					} else {
						currentTab = Math.min(currentTab + 1, questions.length);
						refresh();
					}
				}

				function digitAction(n: number) {
					const question = q();
					const k = question.options.length;
					if (hasPreviewLayout(question)) {
						// Previews are for comparing: digits only move focus (across every
						// row, Skip and Chat included), Enter is what decides. Row indices
						// and displayed digits line up here — no free-text row to skip over.
						const rows = rowsFor(currentTab);
						if (n - 1 < rows.length) {
							setCursor(n - 1);
							refresh();
						}
						return;
					}
					if (n - 1 < k) {
						setCursor(n - 1);
						if (question.multiSelect) toggleOption(n - 1);
						else commitOption(n - 1);
						return;
					}
					if (n === k + 1) {
						// Free-text row: pre-filled text submits directly, empty focuses the input
						const rows = rowsFor(currentTab);
						setCursor(rows.findIndex((r) => r.kind === "freetext"));
						if (!question.multiSelect && freeform[currentTab].trim()) commitCustom();
						else startFreetextEdit();
						return;
					}
					if (n === k + 2) {
						const rows = rowsFor(currentTab);
						setCursor(rows.findIndex((r) => r.kind === "skip"));
						skipQuestion();
						return;
					}
					if (n === k + 3) {
						submitChat();
					}
				}

				// ---- Input handling ----

				function bumpActivity() {
					lastActivity = Date.now();
				}

				function handleEditingInput(data: string) {
					bumpActivity();
					if (editing === "freetext") {
						if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
							const delta = matchesKey(data, Key.tab) ? 1 : -1;
							saveFreetextEdit();
							switchTab(delta);
							return;
						}
						if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
							const delta = matchesKey(data, Key.up) ? -1 : 1;
							saveFreetextEdit();
							const rows = rowsFor(currentTab);
							setCursor((cursor() + delta + rows.length) % rows.length);
							refresh();
							return;
						}
					}
					input.handleInput(data); // Esc/Enter handled via onEscape/onSubmit
					refresh();
				}

				function handleInput(data: string) {
					if (editing !== "none") {
						handleEditingInput(data);
						return;
					}

					bumpActivity();

					// Tab navigation
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							switchTab(1);
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							switchTab(-1);
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter)) {
							submitAnswered();
						} else if (matchesKey(data, Key.escape)) {
							submitCancel();
						}
						return;
					}

					const rows = rowsFor(currentTab);
					const question = q();

					if (matchesKey(data, Key.up)) {
						setCursor((cursor() - 1 + rows.length) % rows.length);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						setCursor((cursor() + 1) % rows.length);
						refresh();
						return;
					}
					if (matchesKey(data, Key.home) || matchesKey(data, Key.pageUp)) {
						setCursor(0);
						refresh();
						return;
					}
					if (matchesKey(data, Key.end) || matchesKey(data, Key.pageDown)) {
						setCursor(rows.length - 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submitCancel();
						return;
					}

					const row = rows[cursor()];
					const ch = printableChar(data);

					// Space: toggle (multiSelect), or activate the free-text input.
					// matchesKey handles legacy " " and Kitty CSI; full-width space normalized too.
					if (matchesKey(data, Key.space) || ch === "　") {
						if (row.kind === "option" && question.multiSelect) {
							toggleOption(row.optionIndex);
						} else if (row.kind === "freetext") {
							if (question.multiSelect && freeform[currentTab].trim()) {
								freeformSelected[currentTab] = !freeformSelected[currentTab];
								refresh();
							} else {
								startFreetextEdit();
							}
						}
						return;
					}

					if (matchesKey(data, Key.enter)) {
						switch (row.kind) {
							case "option":
								if (question.multiSelect) toggleOption(row.optionIndex);
								else commitOption(row.optionIndex);
								return;
							case "freetext":
								startFreetextEdit();
								return;
							case "submit":
								pressSubmitRow();
								return;
							case "skip":
								skipQuestion();
								return;
							case "chat":
								submitChat();
								return;
						}
					}

					if (ch) {
						// Typing on the free-text row starts editing with that character
						if (row.kind === "freetext") {
							startFreetextEdit(data);
							return;
						}
						if (ch === "n" && hasPreviewLayout(question)) {
							startNotesEdit();
							return;
						}
						const digit = asDigit(ch);
						if (digit !== undefined) {
							digitAction(digit);
							return;
						}
					}
				}

				// ---- Rendering ----

				function previewBoxLines(qi: number, oi: number, width: number): string[] {
					const opt = questions[qi].options[oi];
					if (!opt?.preview) return [];
					const innerW = Math.max(1, width - 4);
					const key = `${qi}:${oi}:${innerW}`;
					let md = mdCache.get(key);
					if (!md) {
						md = new Markdown(opt.preview, 0, 0, mdTheme).render(innerW)
							// The markdown renderer keeps ``` fence markers as visible text
							// (they are a border in a chat transcript). Inside a box of our
							// own they are just noise, so drop those rows.
							.filter((line) => !/^`{3,}[\w+-]*$/.test(stripTerminalSequences(line).trim()));
						while (md.length > 0 && visibleWidth(md[md.length - 1].trim()) === 0) md.pop();
						mdCache.set(key, md);
					}
					const shown = md.slice(0, PREVIEW_MAX_LINES);
					const hidden = md.length - shown.length;
					const bar = theme.fg("dim", "│");
					// Closed box: the right edge tells you where a truncated preview line ends.
					const row = (content: string) => `${bar} ${truncateToWidth(content, innerW, "…", true)} ${bar}`;
					const out: string[] = [];
					out.push(theme.fg("dim", `┌ preview ${"─".repeat(Math.max(0, width - 11))}┐`));
					for (const line of shown) out.push(row(line));
					if (hidden > 0) out.push(row(theme.fg("dim", `… +${hidden} more lines`)));
					out.push(theme.fg("dim", `└${"─".repeat(Math.max(0, width - 2))}┘`));
					return out;
				}

				/**
				 * The typed text as its own field. Input.render() hardcodes a "> " prompt,
				 * which reads as a second cursor next to the reverse-video one it draws —
				 * strip it and let the text stand alone. The +2 keeps the field width right.
				 */
				function inputLine(width: number): string {
					const line = input.render(Math.max(4, width) + 2)[0] ?? "";
					return line.startsWith("> ") ? line.slice(2) : line;
				}

				function notesLine(qi: number, width: number, editingNotes: boolean): string {
					const label = theme.fg("accent", "Notes: ");
					if (editingNotes) {
						return label + inputLine(width - visibleWidth("Notes: "));
					}
					const text = notesText[qi].trim();
					const body = text
						? theme.italic(theme.fg("muted", truncateToWidth(text, Math.max(4, width - 7))))
						: theme.fg("dim", "press n to add notes");
					return label + body;
				}

				function optionRowLines(
					question: Question,
					oi: number,
					focused: boolean,
					width: number,
					opts: { showMarker: boolean; showCheck: boolean; withDescription: boolean },
				): string[] {
					const lines: string[] = [];
					const opt = question.options[oi];
					const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
					const num = theme.fg("dim", `${oi + 1}. `);
					let marker = "";
					if (opts.showMarker) {
						marker = picked[currentTabForRender].has(oi)
							? theme.fg("success", "[x] ")
							: theme.fg("muted", "[ ] ");
					}
					const isPicked = picked[currentTabForRender].has(oi);
					const check = opts.showCheck && isPicked ? theme.fg("success", " ✓") : "";
					const labelColor = focused ? "accent" : isPicked && opts.showCheck ? "success" : "text";
					const prefix = pointer + num + marker;
					const prefixW = visibleWidth(prefix);
					const wrapped = wrapTextWithAnsi(theme.fg(labelColor, opt.label) + check, Math.max(1, width - prefixW));
					const cont = " ".repeat(prefixW);
					wrapped.forEach((line, idx) => lines.push((idx === 0 ? prefix : cont) + line));
					if (opts.withDescription && opt.description) {
						const dPrefix = " ".repeat(prefixW);
						for (const line of wrapTextWithAnsi(theme.fg("muted", opt.description), Math.max(1, width - prefixW))) {
							lines.push(dPrefix + line);
						}
					}
					return lines;
				}

				function freetextRowLine(question: Question, focused: boolean, isEditing: boolean, width: number): string {
					const qi = currentTabForRender;
					const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
					const num = theme.fg("dim", `${rowDigit(question, "freetext")}. `);
					let marker = "";
					if (question.multiSelect) {
						marker = freeformSelected[qi] && freeform[qi].trim()
							? theme.fg("success", "[x] ")
							: theme.fg("muted", "[ ] ");
					}
					const prefix = pointer + num + marker;
					const prefixW = visibleWidth(prefix);
					const avail = Math.max(4, width - prefixW);
					// No label in front of the input or the saved text: what the person
					// typed is the answer, and a "Type:" prefix only eats width.
					if (isEditing) {
						return prefix + inputLine(avail);
					}
					const text = freeform[qi].trim();
					if (!text) {
						// Dim: the row is an invitation, not one of the answers on offer.
						return prefix + truncateToWidth(theme.fg(focused ? "accent" : "dim", FREETEXT_LABEL), avail);
					}
					const body = freeformSelected[qi]
						? theme.fg("text", text) + theme.fg("success", " ✓")
						: theme.fg("muted", text) + theme.fg("dim", " (kept as note)");
					return prefix + truncateToWidth(body, avail);
				}

				/** Rule that sets "Chat about this" apart from the rows above it. */
				function separatorLine(width: number): string {
					return theme.fg("dim", "─".repeat(Math.max(1, width)));
				}

				// The row-rendering helpers need the question index being rendered
				// (measurement renders non-active questions too).
				let currentTabForRender = 0;

				function questionBodyLines(
					qi: number,
					width: number,
					view: { focusRow: number; editingKind: EditKind },
				): string[] {
					const prevTab = currentTabForRender;
					currentTabForRender = qi;
					try {
						const question = questions[qi];
						const rows = rowsFor(qi);
						const lines: string[] = [];

						const addWrapped = (text: string, indent = " ") => {
							const w = Math.max(1, width - indent.length);
							for (const line of wrapTextWithAnsi(text, w)) lines.push(indent + line);
						};

						// Question text is markdown (models send tables, headings, bold)
						const qKey = `q${qi}:${width}`;
						let qLines = mdCache.get(qKey);
						if (!qLines) {
							qLines = new Markdown(question.question, 0, 0, mdTheme).render(Math.max(1, width - 1));
							while (qLines.length > 0 && visibleWidth(qLines[qLines.length - 1].trim()) === 0) qLines.pop();
							mdCache.set(qKey, qLines);
						}
						for (const line of qLines) lines.push(" " + line);
						if (question.multiSelect) {
							addWrapped(theme.fg("dim", "(multiple choice — pick any that apply)"));
						}
						lines.push("");

						const preview = hasPreviewLayout(question);
						const sideBySide = preview && width >= SIDE_BY_SIDE_MIN_WIDTH;

						if (sideBySide) {
							const leftW = Math.min(30, Math.floor((width - 3) / 2));
							const rightW = Math.max(10, width - leftW - 3);
							const left: string[] = [];
							for (let oi = 0; oi < question.options.length; oi++) {
								left.push(
									...optionRowLines(question, oi, view.focusRow === oi, leftW, {
										showMarker: false,
										showCheck: true,
										withDescription: false,
									}),
								);
							}
							// Once focus moves past the option list (onto Skip/Chat), keep
							// showing the last option actually looked at (lastOptionByQ) rather
							// than snapping to whichever option is last in the array.
							const focusedOption = view.focusRow < question.options.length ? view.focusRow : lastOptionByQ[qi];
							const right = previewBoxLines(qi, focusedOption, rightW);
							const rowCount = Math.max(left.length, right.length);
							for (let t = 0; t < rowCount; t++) {
								lines.push(padToWidth(left[t] ?? "", leftW) + "   " + (right[t] ?? ""));
							}
							// The focused option's description and the Notes line both belong to
							// the option whose preview is showing, so they stay in the preview
							// column, under the box, instead of drifting to the far left.
							const gutter = " ".repeat(leftW + 3);
							const desc = question.options[focusedOption]?.description;
							if (desc) {
								for (const line of wrapTextWithAnsi(theme.fg("muted", desc), rightW)) lines.push(gutter + line);
							}
							lines.push("");
							lines.push(gutter + notesLine(qi, rightW, view.editingKind === "notes"));
							lines.push("");
							// No leading space on the action rows: their own pointer ("❯ "/"  ")
							// is the indent, same as the option rows above — an extra space would
							// shift the pointer one column out of line.
							const skipFocused = rows[view.focusRow]?.kind === "skip";
							const skipPointer = skipFocused ? theme.fg("accent", "❯ ") : "  ";
							const skipNum = theme.fg("dim", `${rowDigit(question, "skip")}. `);
							const skipLabel = skipped[qi] ? "Skip ✓" : "Skip";
							lines.push(skipPointer + skipNum + theme.fg(skipFocused ? "accent" : "muted", skipLabel));
							lines.push("");
							lines.push(separatorLine(width));
							const chatFocused = rows[view.focusRow]?.kind === "chat";
							const chatPointer = chatFocused ? theme.fg("accent", "❯ ") : "  ";
							const chatNum = theme.fg("dim", `${rowDigit(question, "chat")}. `);
							lines.push(chatPointer + chatNum + theme.fg(chatFocused ? "accent" : "muted", "Chat about this"));
							return lines;
						}

						for (let r = 0; r < rows.length; r++) {
							const row = rows[r];
							const focused = view.focusRow === r;
							// Stacked preview (narrow terminal): the box and the notes line sit
							// between the option rows and the action rows. Notes render even when
							// the focused option has no preview, matching the side-by-side layout.
							if (preview && r === question.options.length) {
								const focusedOption = view.focusRow < question.options.length ? view.focusRow : lastOptionByQ[qi];
								const box = previewBoxLines(qi, focusedOption, Math.max(10, width - 2));
								lines.push("");
								for (const line of box) lines.push(" " + line);
								lines.push("");
								lines.push(" " + notesLine(qi, width - 1, view.editingKind === "notes"));
								lines.push("");
							}
							switch (row.kind) {
								case "option":
									lines.push(
										...optionRowLines(question, row.optionIndex, focused, width, {
											showMarker: question.multiSelect,
											showCheck: !question.multiSelect,
											withDescription: true,
										}),
									);
									break;
								case "freetext":
									lines.push(
										freetextRowLine(question, focused, focused && view.editingKind === "freetext", width),
									);
									break;
								case "submit": {
									const label = isMulti ? "Next" : "Submit";
									const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
									lines.push("");
									lines.push(pointer + "    " + theme.bold(theme.fg(focused ? "accent" : "muted", label)));
									break;
								}
								case "skip": {
									const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
									const num = theme.fg("dim", `${rowDigit(question, "skip")}. `);
									const label = skipped[qi] ? "Skip ✓" : "Skip";
									lines.push(pointer + num + theme.fg(focused ? "accent" : "muted", label));
									break;
								}
								case "chat": {
									const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
									const num = theme.fg("dim", `${rowDigit(question, "chat")}. `);
									lines.push("");
									lines.push(separatorLine(width));
									lines.push(pointer + num + theme.fg(focused ? "accent" : "muted", "Chat about this"));
									break;
								}
							}
						}

						return lines;
					} finally {
						currentTabForRender = prevTab;
					}
				}

				function submitBodyLines(width: number): string[] {
					const lines: string[] = [];
					const addWrapped = (text: string) => {
						for (const line of wrapTextWithAnsi(text, Math.max(1, width - 1))) lines.push(" " + line);
					};
					addWrapped(theme.fg("accent", theme.bold("Ready to submit")));
					lines.push("");
					for (let i = 0; i < questions.length; i++) {
						const a = buildAnswer(i);
						const note = a.notes ? theme.fg("dim", " ✎") : "";
						if (isAnswered(i)) {
							addWrapped(
								theme.fg("muted", `${a.header}: `) + theme.fg("text", a.labels.join(", ")) + note,
							);
						} else if (a.notesOnly || a.notes) {
							addWrapped(theme.fg("muted", `${a.header}: `) + theme.fg("dim", "(notes only)") + note);
						} else if (skipped[i]) {
							addWrapped(theme.fg("muted", `${a.header}: `) + theme.fg("dim", "(skipped)"));
						}
					}
					lines.push("");
					if (allSettled()) {
						addWrapped(theme.fg("success", "Press Enter to submit"));
					} else {
						const missing = questions
							.filter((_, i) => !isSettled(i))
							.map((qq) => qq.header)
							.join(", ");
						addWrapped(theme.fg("warning", `Unanswered: ${missing} — Enter submits anyway`));
					}
					return lines;
				}

				/** Max body height across all questions at this width (layout stability). */
				function globalBodyHeight(width: number): number {
					const cached = heightCache.get(width);
					if (cached !== undefined) return cached;
					let max = 0;
					for (let i = 0; i < questions.length; i++) {
						if (hasPreviewLayout(questions[i])) {
							for (let oi = 0; oi < questions[i].options.length; oi++) {
								max = Math.max(max, questionBodyLines(i, width, { focusRow: oi, editingKind: "none" }).length);
							}
						} else {
							max = Math.max(max, questionBodyLines(i, width, { focusRow: 0, editingKind: "none" }).length);
						}
					}
					heightCache.set(width, max);
					return max;
				}

				function tabBarLines(width: number): string[] {
					const tabs: string[] = ["← "];
					for (let i = 0; i < questions.length; i++) {
						const isActive = i === currentTab;
						const box = isAnswered(i) ? "■" : hasNotes(i) ? "✎" : skipped[i] ? "–" : "□";
						const text = ` ${box} ${questions[i].header} `;
						const styled = isActive
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg(isAnswered(i) ? "success" : "muted", text);
						tabs.push(`${styled} `);
					}
					const isSubmitTab = currentTab === questions.length;
					const submitText = " ✓ Submit ";
					tabs.push(
						isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(allSettled() ? "success" : "dim", submitText),
					);
					tabs.push(" →");
					const out: string[] = [];
					for (const line of wrapTextWithAnsi(tabs.join(""), Math.max(1, width - 1))) out.push(" " + line);
					out.push("");
					return out;
				}

				function remainingAfkMs(): number {
					return Math.max(0, AFK_TIMEOUT_MS - (Date.now() - lastActivity));
				}

				function hintLine(width: number): string[] {
					let parts: string[];
					if (editing === "freetext") {
						parts = ["Enter save", "Esc back", "↑↓ move away"];
					} else if (editing === "notes") {
						parts = ["Enter/Esc save note"];
					} else if (currentTab === questions.length) {
						parts = ["Tab/←→ questions", "Enter submit", "Esc cancel"];
					} else {
						parts = [];
						if (isMulti) parts.push("Tab/←→ questions");
						parts.push("↑↓ move");
						const question = q();
						if (hasPreviewLayout(question)) {
							parts.push("1-9 focus", "Enter select", "n note");
						} else if (question.multiSelect) {
							parts.push("1-9/Space toggle", "Enter confirm");
						} else {
							parts.push("1-9/Enter select");
						}
						parts.push("Skip unanswered", "Esc cancel");
					}
					const remaining = remainingAfkMs();
					if (remaining <= AFK_COUNTDOWN_MS) {
						parts.push(`auto-submit ${Math.ceil(remaining / 1000)}s`);
					}
					const color = remaining <= AFK_COUNTDOWN_MS ? "warning" : "dim";
					const out: string[] = [];
					for (const line of wrapTextWithAnsi(theme.fg(color, parts.join(" · ")), Math.max(1, width - 1))) {
						out.push(" " + line);
					}
					return out;
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const renderWidth = Math.max(1, width);
					const lines: string[] = [];

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					if (isMulti) lines.push(...tabBarLines(renderWidth));

					let body: string[];
					if (currentTab === questions.length) {
						body = submitBodyLines(renderWidth);
					} else {
						body = questionBodyLines(currentTab, renderWidth, { focusRow: cursor(), editingKind: editing });
					}
					const target = globalBodyHeight(renderWidth);
					while (body.length < target) body.push("");
					lines.push(...body);

					lines.push("");
					lines.push(...hintLine(renderWidth));
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedLines = lines;
					return lines;
				}

				afkTimer = setInterval(() => {
					if (finished) return;
					const remaining = remainingAfkMs();
					if (remaining <= 0) {
						submitAfk();
						return;
					}
					if (remaining <= AFK_COUNTDOWN_MS) refresh();
				}, 1000);
				(afkTimer as { unref?: () => void }).unref?.();

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
					dispose: () => {
						signal?.removeEventListener("abort", onAbort);
						if (afkTimer !== undefined) clearInterval(afkTimer);
					},
				};
			});
				}
			} finally {
				ctx.ui.setWorkingVisible(true);
			}

			if (result.outcome === "cancelled") {
				return {
					content: [{ type: "text", text: CANCEL_TEXT }],
					details: result,
				};
			}

			if (result.outcome === "chat") {
				return {
					content: [{ type: "text", text: formatChatAboutThis(result.questions, result.answers) }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: formatSubmitted(result) }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			let text = theme.fg("toolTitle", theme.bold("ask "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			const headers = qs.map((q, i) => q.header || `Q${i + 1}`).join(", ");
			if (headers) text += theme.fg("dim", ` (${headers})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.outcome === "cancelled") {
				if (details.questions.length === 0) {
					// Validation error, not a user cancel — surface the error text
					const text = result.content[0];
					return new Text(theme.fg("warning", text?.type === "text" ? text.text : "Invalid input"), 0, 0);
				}
				return new Text(theme.fg("warning", "Declined to answer"), 0, 0);
			}
			const lines: string[] = [];
			if (details.outcome === "afk") {
				lines.push(theme.fg("warning", "Auto-continued after 5 minutes idle"));
			}
			for (const a of details.answers) {
				if (a.notesOnly) {
					lines.push(
						`${theme.fg("muted", "✎ ")}${theme.fg("accent", a.header)}: ${theme.fg("dim", NOTES_ONLY)}` +
							(a.notes ? theme.fg("dim", ` (note: ${a.notes})`) : ""),
					);
				} else if (a.labels.length > 0) {
					const parts = a.labels.map((l) =>
						a.customLabels.includes(l) ? `${theme.fg("muted", "(wrote) ")}${l}` : l,
					);
					let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${parts.join(", ")}`;
					if (a.notes) line += theme.fg("dim", ` (note: ${a.notes})`);
					lines.push(line);
				} else {
					lines.push(`${theme.fg("dim", "– ")}${theme.fg("accent", a.header)}: ${theme.fg("dim", "(skipped)")}`);
				}
			}
			if (details.outcome === "chat") {
				lines.push(theme.fg("accent", "→ User wants to chat about this instead"));
			}
			if (lines.length === 0) {
				return new Text(theme.fg("dim", "No options selected"), 0, 0);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
