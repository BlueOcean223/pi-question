/**
 * pi-question — AskUserQuestion tool for pi
 *
 * Interactive multiple-choice questions with a free-text escape hatch:
 * - Single question: option list; single-select submits on pick
 * - Multiple questions: tab bar (header chips) + Submit review page
 * - Number keys 1-9 select directly (full-width digits normalized)
 * - "Other" is an inline input row: focus it and just start typing
 * - multiSelect: Space/Enter toggle, explicit Next/Submit button confirms
 * - "Chat about this": ends the dialog asking the model to clarify instead
 * - Option previews: side-by-side layout, markdown-rendered, `n` adds notes
 * - Answers keyed by full question text; notes/preview echoed as annotations
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
	/** Which labels were custom-typed via "Other" */
	customLabels: string[];
	/** Free text kept as an annotation (not part of the answer) */
	notes?: string;
	/** Preview content of the selected option (single-select only) */
	preview?: string;
}

type Outcome = "answered" | "cancelled" | "chat";

interface AskResult {
	questions: Question[];
	answers: Answer[];
	outcome: Outcome;
}

type EditKind = "none" | "other" | "notes";

interface Row {
	kind: "option" | "other" | "submit" | "chat";
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
		minItems: 2,
		maxItems: 4,
		description:
			"2-4 distinct options with unique labels. If you recommend one, put it first and append ' (Recommended)' to its label. Do not add an 'Other' option — it is provided automatically.",
	}),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4, description: "1-4 questions to ask the user" }),
});

// ---------- Model-facing result strings ----------

const CANCEL_TEXT =
	"User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.";

function formatAccepted(answers: Answer[]): string {
	const entries = answers.map((a) => {
		const parts = [`"${a.question}"="${a.labels.join(", ")}"`];
		if (a.preview) parts.push(`selected preview:\n${a.preview}`);
		if (a.notes) parts.push(`user notes: ${a.notes}`);
		return parts.join(" ");
	});
	return `User has answered your questions: ${entries.join(", ")}. You can now continue with the user's answers in mind.`;
}

function formatChatAboutThis(questions: Question[], answers: Answer[]): string {
	const byQuestion = new Map(answers.map((a) => [a.question, a]));
	const lines = questions.map((q) => {
		const a = byQuestion.get(q.question);
		return a && a.labels.length > 0
			? `- "${q.question}"\n  Answer: ${a.labels.join(", ")}`
			: `- "${q.question}"\n  (No answer provided)`;
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

function errorResult(message: string, questions: Question[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { questions, answers: [], outcome: "cancelled" } as AskResult,
	};
}

function validateQuestions(questions: { question: string; options: { label: string }[] }[]): string | undefined {
	if (questions.length > MAX_QUESTIONS) {
		return `Error: Too many questions (${questions.length}). Ask at most ${MAX_QUESTIONS} per call.`;
	}
	const texts = new Set<string>();
	for (const q of questions) {
		if (texts.has(q.question)) {
			return `Error: Duplicate question text: "${q.question}". Question texts must be unique.`;
		}
		texts.add(q.question);
		if (q.options.length < 2 || q.options.length > 4) {
			return `Error: Question "${q.question}" has ${q.options.length} option(s). Provide 2-4 options (an "Other" free-text option is added automatically).`;
		}
		const labels = new Set<string>();
		for (const opt of q.options) {
			if (labels.has(opt.label)) {
				return `Error: Duplicate option label "${opt.label}" in question "${q.question}". Option labels must be unique within a question.`;
			}
			labels.add(opt.label);
		}
	}
	return undefined;
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
			"Ask the user one or more questions when you are blocked on a decision that is genuinely theirs to make — choosing between approaches, clarifying ambiguous requirements, or picking preferences you cannot infer. Each question shows 2-4 options plus an automatic free-text 'Other'. Use multiSelect for non-exclusive choices. Use option previews (code snippets, mockups) when users need to visually compare concrete artifacts. If you recommend an option, put it first and append ' (Recommended)' to its label. The user may also choose to chat about the questions instead of answering — treat that as a request for clarification, not a refusal. Do not use this for decisions with an obvious conventional default.",
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

			const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
				// ---- State ----
				let currentTab = 0;
				let editing: EditKind = "none";
				let cachedLines: string[] | undefined;
				const cursorByQ = questions.map(() => 0);
				const picked = questions.map(() => new Set<number>());
				const freeform = questions.map(() => "");
				const freeformSelected = questions.map(() => false);

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
					if (hasPreviewLayout(question)) {
						rows.push({ kind: "chat", optionIndex: -1 });
						return rows;
					}
					rows.push({ kind: "other", optionIndex: -1 });
					if (question.multiSelect) rows.push({ kind: "submit", optionIndex: -1 });
					rows.push({ kind: "chat", optionIndex: -1 });
					return rows;
				}

				function cursor(): number {
					return cursorByQ[currentTab] ?? 0;
				}

				function setCursor(v: number) {
					const max = rowsFor(currentTab).length - 1;
					cursorByQ[currentTab] = Math.max(0, Math.min(v, max));
				}

				function isAnswered(qi: number): boolean {
					return picked[qi].size > 0 || (freeformSelected[qi] && freeform[qi].trim().length > 0);
				}

				function allAnswered(): boolean {
					return questions.every((_, i) => isAnswered(i));
				}

				function buildAnswer(qi: number): Answer {
					const question = questions[qi];
					const labels = [...picked[qi]].sort((a, b) => a - b).map((idx) => question.options[idx].label);
					const text = freeform[qi].trim();
					const custom = freeformSelected[qi] && text ? [text] : [];
					const notes = text && custom.length === 0 ? text : undefined;
					let preview: string | undefined;
					if (!question.multiSelect && picked[qi].size === 1) {
						preview = question.options[[...picked[qi]][0]].preview;
					}
					return {
						header: question.header,
						question: question.question,
						labels: [...labels, ...custom],
						customLabels: custom,
						...(notes ? { notes } : {}),
						...(preview ? { preview } : {}),
					};
				}

				// ---- Submission ----

				function submitAnswered() {
					done({ questions, answers: questions.map((_, i) => buildAnswer(i)), outcome: "answered" });
				}

				function submitCancel() {
					done({ questions, answers: [], outcome: "cancelled" });
				}

				function submitChat() {
					const answers = questions.map((_, i) => i).filter((i) => isAnswered(i)).map((i) => buildAnswer(i));
					done({ questions, answers, outcome: "chat" });
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submitAnswered();
						return;
					}
					// Jump to next unanswered question, else Submit tab
					let next = questions.length;
					for (let step = 1; step <= questions.length; step++) {
						const cand = (currentTab + step) % questions.length;
						if (!isAnswered(cand)) {
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
					advanceAfterAnswer();
				}

				function toggleOption(oi: number) {
					const i = currentTab;
					if (picked[i].has(oi)) picked[i].delete(oi);
					else picked[i].add(oi);
					refresh();
				}

				function commitCustom() {
					const i = currentTab;
					picked[i].clear();
					freeformSelected[i] = true;
					advanceAfterAnswer();
				}

				function startOtherEdit(seedData?: string) {
					editing = "other";
					input.setValue(freeform[currentTab]);
					input.focused = true;
					if (seedData) input.handleInput(seedData);
					refresh();
				}

				function startNotesEdit() {
					editing = "notes";
					input.setValue(freeform[currentTab]);
					input.focused = true;
					refresh();
				}

				/** Save inline "Other" text without committing it as the answer. */
				function saveOtherEdit() {
					const i = currentTab;
					freeform[i] = input.getValue();
					const text = freeform[i].trim();
					if (text) {
						// Tentatively selected unless an option is already picked
						// (then the text rides along as a note instead).
						if (picked[i].size === 0) freeformSelected[i] = true;
					} else {
						freeformSelected[i] = false;
					}
					editing = "none";
					input.focused = false;
					refresh();
				}

				function saveNotesEdit() {
					freeform[currentTab] = input.getValue();
					editing = "none";
					input.focused = false;
					refresh();
				}

				input.onEscape = () => {
					if (editing === "other") saveOtherEdit();
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
						if (isAnswered(i)) submitAnswered();
						return;
					}
					if (isAnswered(i)) {
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
						// Previews are for comparing: digits focus, Enter decides.
						if (n - 1 < k) {
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
						// "Other": pre-filled text submits directly, empty focuses the input
						const rows = rowsFor(currentTab);
						setCursor(rows.findIndex((r) => r.kind === "other"));
						if (!question.multiSelect && freeform[currentTab].trim()) commitCustom();
						else startOtherEdit();
						return;
					}
					if (n === k + 2) {
						submitChat();
					}
				}

				// ---- Input handling ----

				function handleEditingInput(data: string) {
					if (editing === "other") {
						if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
							const delta = matchesKey(data, Key.tab) ? 1 : -1;
							saveOtherEdit();
							switchTab(delta);
							return;
						}
						if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
							const delta = matchesKey(data, Key.up) ? -1 : 1;
							saveOtherEdit();
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
						if (matchesKey(data, Key.enter) && allAnswered()) {
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

					// Space: toggle (multiSelect), or activate the Other input.
					// matchesKey handles legacy " " and Kitty CSI; full-width space normalized too.
					if (matchesKey(data, Key.space) || ch === "　") {
						if (row.kind === "option" && question.multiSelect) {
							toggleOption(row.optionIndex);
						} else if (row.kind === "other") {
							if (question.multiSelect && freeform[currentTab].trim()) {
								freeformSelected[currentTab] = !freeformSelected[currentTab];
								refresh();
							} else {
								startOtherEdit();
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
							case "other":
								startOtherEdit();
								return;
							case "submit":
								pressSubmitRow();
								return;
							case "chat":
								submitChat();
								return;
						}
					}

					if (ch) {
						// Typing on the Other row starts editing with that character
						if (row.kind === "other") {
							startOtherEdit(data);
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
					const innerW = Math.max(1, width - 2);
					const key = `${qi}:${oi}:${innerW}`;
					let md = mdCache.get(key);
					if (!md) {
						md = new Markdown(opt.preview, 0, 0, mdTheme).render(innerW);
						mdCache.set(key, md);
					}
					const shown = md.slice(0, PREVIEW_MAX_LINES);
					const hidden = md.length - shown.length;
					const out: string[] = [];
					out.push(theme.fg("dim", `┌ preview ${"─".repeat(Math.max(0, width - 10))}`));
					for (const line of shown) {
						out.push(theme.fg("dim", "│ ") + truncateToWidth(line, innerW));
					}
					if (hidden > 0) {
						out.push(theme.fg("dim", `│ … +${hidden} more lines`));
					}
					out.push(theme.fg("dim", `└${"─".repeat(Math.max(0, width - 1))}`));
					return out;
				}

				function notesLine(qi: number, width: number, editingNotes: boolean): string {
					const label = theme.fg("accent", "Notes: ");
					if (editingNotes) {
						const inputLine = input.render(Math.max(4, width - visibleWidth("Notes: ")))[0] ?? "";
						return label + inputLine;
					}
					const text = freeform[qi].trim();
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

				function otherRowLine(question: Question, focused: boolean, isEditing: boolean, width: number): string {
					const qi = currentTabForRender;
					const k = question.options.length;
					const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
					const num = theme.fg("dim", `${k + 1}. `);
					let marker = "";
					if (question.multiSelect) {
						marker = freeformSelected[qi] && freeform[qi].trim()
							? theme.fg("success", "[x] ")
							: theme.fg("muted", "[ ] ");
					}
					const prefix = pointer + num + marker;
					const prefixW = visibleWidth(prefix);
					const avail = Math.max(4, width - prefixW);
					if (isEditing) {
						const label = theme.fg("accent", "Other: ");
						const inputLine = input.render(Math.max(4, avail - visibleWidth("Other: ")))[0] ?? "";
						return prefix + label + inputLine;
					}
					const text = freeform[qi].trim();
					if (!text) {
						const label = theme.fg(focused ? "accent" : "text", "Other");
						const hint = theme.fg("dim", " — type your own answer");
						return prefix + truncateToWidth(label + hint, avail);
					}
					const label = theme.fg(focused ? "accent" : "text", "Other: ");
					let body: string;
					if (freeformSelected[qi]) {
						body = theme.fg("text", text) + theme.fg("success", " ✓");
					} else {
						body = theme.fg("muted", text) + theme.fg("dim", " (kept as note)");
					}
					return prefix + truncateToWidth(label + body, avail);
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
							const focusedOption = Math.min(view.focusRow, question.options.length - 1);
							const right = previewBoxLines(qi, focusedOption, rightW);
							const rowCount = Math.max(left.length, right.length);
							for (let t = 0; t < rowCount; t++) {
								lines.push(padToWidth(left[t] ?? "", leftW) + "   " + (right[t] ?? ""));
							}
							lines.push("");
							lines.push(" " + notesLine(qi, width - 1, view.editingKind === "notes"));
							// Focused option's description below the panel (full width)
							const desc = question.options[focusedOption]?.description;
							if (desc) addWrapped(theme.fg("muted", desc), "   ");
							lines.push("");
							const chatFocused = rows[view.focusRow]?.kind === "chat";
							const chatPointer = chatFocused ? theme.fg("accent", "❯ ") : "  ";
							lines.push(chatPointer + theme.fg(chatFocused ? "accent" : "muted", "Chat about this"));
							return lines;
						}

						for (let r = 0; r < rows.length; r++) {
							const row = rows[r];
							const focused = view.focusRow === r;
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
								case "other":
									lines.push(otherRowLine(question, focused, focused && view.editingKind === "other", width));
									break;
								case "submit": {
									const label = isMulti ? "Next" : "Submit";
									const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
									lines.push("");
									lines.push(pointer + "    " + theme.bold(theme.fg(focused ? "accent" : "muted", label)));
									break;
								}
								case "chat": {
									// Stacked preview (narrow terminal): box + notes sit above the chat row
									if (preview) {
										const focusedOption = Math.min(view.focusRow, question.options.length - 1);
										const box = previewBoxLines(qi, focusedOption, Math.max(10, width - 2));
										if (box.length > 0) {
											lines.push("");
											for (const line of box) lines.push(" " + line);
											lines.push(" " + notesLine(qi, width - 1, view.editingKind === "notes"));
											lines.push("");
										}
									}
									const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
									// Digits map to the chat row only in non-preview layouts
									const num = preview ? "" : theme.fg("dim", `${question.options.length + 2}. `);
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
						if (!isAnswered(i)) continue;
						const a = buildAnswer(i);
						const note = a.notes ? theme.fg("dim", " ✎") : "";
						addWrapped(theme.fg("muted", `${a.header}: `) + theme.fg("text", a.labels.join(", ")) + note);
					}
					lines.push("");
					if (allAnswered()) {
						addWrapped(theme.fg("success", "Press Enter to submit"));
					} else {
						const missing = questions
							.filter((_, i) => !isAnswered(i))
							.map((qq) => qq.header)
							.join(", ");
						addWrapped(theme.fg("warning", `Unanswered: ${missing}`));
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
						const box = isAnswered(i) ? "■" : "□";
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
							: theme.fg(allAnswered() ? "success" : "dim", submitText),
					);
					tabs.push(" →");
					const out: string[] = [];
					for (const line of wrapTextWithAnsi(tabs.join(""), Math.max(1, width - 1))) out.push(" " + line);
					out.push("");
					return out;
				}

				function hintLine(width: number): string[] {
					let parts: string[];
					if (editing === "other") {
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
						parts.push("Esc cancel");
					}
					const out: string[] = [];
					for (const line of wrapTextWithAnsi(theme.fg("dim", parts.join(" · ")), Math.max(1, width - 1))) {
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

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			ctx.ui.setWorkingVisible(true);

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
				content: [{ type: "text", text: formatAccepted(result.answers) }],
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
			const lines = details.answers.map((a) => {
				const parts = a.labels.map((l) =>
					a.customLabels.includes(l) ? `${theme.fg("muted", "(wrote) ")}${l}` : l,
				);
				let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${parts.join(", ")}`;
				if (a.notes) line += theme.fg("dim", ` (note: ${a.notes})`);
				return line;
			});
			if (details.outcome === "chat") {
				lines.push(theme.fg("accent", "→ User wants to chat about this instead"));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
