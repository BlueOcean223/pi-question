/**
 * pi-question — AskUserQuestion tool for pi
 *
 * Claude Code / grok-build style interactive questions:
 * - Single question: simple option list
 * - Multiple questions: tab bar navigation (header chips) + Submit page
 * - multiSelect: Space toggles, Enter confirms
 * - Every question gets an automatic "Type something." (Other) option with inline editor
 * - Optional per-option preview rendered below the list while focused
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
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

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	header: string;
	question: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

interface Answer {
	header: string;
	/** Selected option labels; custom text entries are included as-is */
	labels: string[];
	/** Which labels were custom-typed via "Other" */
	customLabels: string[];
}

interface AskResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// ---------- Schema ----------

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display text for this option, concise (1-5 words)" }),
	description: Type.Optional(Type.String({ description: "Explanation shown below the label" })),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional multi-line preview (code snippet, mockup, config example) rendered while this option is focused. Only for single-select questions.",
		}),
	),
});

const QuestionSchema = Type.Object({
	header: Type.String({ description: "Very short chip label for the tab bar (max 12 chars), e.g. 'Auth method'" }),
	question: Type.String({ description: "The complete question to ask, ending with a question mark" }),
	options: Type.Array(OptionSchema, {
		description:
			"2-4 distinct options. If you recommend one, put it first and append ' (Recommended)' to its label. Do not add an 'Other' option — it is provided automatically.",
	}),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "1-4 questions to ask the user" }),
});

// ---------- Helpers ----------

function errorResult(message: string, questions: Question[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { questions, answers: [], cancelled: true } as AskResult,
	};
}

const OTHER_LABEL = "Type something.";

// ---------- Extension ----------

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user one or more questions when you are blocked on a decision that is genuinely theirs to make — choosing between approaches, clarifying ambiguous requirements, or picking preferences you cannot infer. Each question shows 2-4 options plus an automatic free-text 'Other'. Use multiSelect for non-exclusive choices. Use option previews (code snippets, mockups) when users need to visually compare concrete artifacts. Do not use this for decisions with an obvious conventional default.",
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (!params.questions || params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			const questions: Question[] = params.questions.map((q, i) => ({
				header: (q.header || `Q${i + 1}`).slice(0, 16),
				question: q.question,
				options: q.options ?? [],
				multiSelect: q.multiSelect === true,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let cachedLines: string[] | undefined;
				// Per-question: toggled option indexes (multiSelect) or committed answer
				const picked = new Map<number, Set<number>>(); // qIndex -> option indexes toggled on
				const customTexts = new Map<number, string[]>(); // qIndex -> custom entries
				const answered = new Set<number>(); // questions confirmed (single: on select; multi: on Enter)

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function q(): Question {
					return questions[Math.min(currentTab, questions.length - 1)];
				}

				function currentOptions(): RenderOption[] {
					return [...q().options, { label: OTHER_LABEL, isOther: true }];
				}

				function pickedSet(i: number): Set<number> {
					let s = picked.get(i);
					if (!s) {
						s = new Set();
						picked.set(i, s);
					}
					return s;
				}

				function buildAnswer(i: number): Answer {
					const question = questions[i];
					const labels = [...pickedSet(i)].sort((a, b) => a - b).map((idx) => question.options[idx].label);
					const custom = customTexts.get(i) ?? [];
					return { header: question.header, labels: [...labels, ...custom], customLabels: custom };
				}

				function allAnswered(): boolean {
					return questions.every((_, i) => answered.has(i));
				}

				function submit(cancelled: boolean) {
					const answers = cancelled ? [] : questions.map((_, i) => buildAnswer(i));
					done({ questions, answers, cancelled });
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					// Jump to next unanswered question, else Submit tab
					let next = questions.length;
					for (let step = 1; step <= questions.length; step++) {
						const cand = (currentTab + step) % questions.length;
						if (!answered.has(cand)) {
							next = cand;
							break;
						}
					}
					currentTab = next;
					optionIndex = 0;
					refresh();
				}

				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					inputMode = false;
					editor.setText("");
					if (trimmed) {
						const i = currentTab;
						const list = customTexts.get(i) ?? [];
						list.push(trimmed);
						customTexts.set(i, list);
						if (q().multiSelect) {
							refresh(); // stay on question; user keeps toggling
						} else {
							pickedSet(i).clear();
							answered.add(i);
							advanceAfterAnswer();
						}
					} else {
						refresh();
					}
				};

				function handleInput(data: string) {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					// Tab navigation
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					const opts = currentOptions();

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					const opt = opts[optionIndex];
					const i = currentTab;
					const multi = q().multiSelect;

					// Space: toggle (multiSelect only, not on Other).
					// matchesKey handles both legacy " " and Kitty-protocol CSI sequences.
					if (multi && matchesKey(data, Key.space) && !opt.isOther) {
						const s = pickedSet(i);
						if (s.has(optionIndex)) s.delete(optionIndex);
						else s.add(optionIndex);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						if (opt.isOther) {
							inputMode = true;
							editor.setText("");
							refresh();
							return;
						}
						if (multi) {
							// Enter confirms the question if anything is picked; else toggles focused
							const s = pickedSet(i);
							const hasCustom = (customTexts.get(i) ?? []).length > 0;
							if (s.size === 0 && !hasCustom) {
								s.add(optionIndex);
								refresh();
								return;
							}
							answered.add(i);
							advanceAfterAnswer();
							return;
						}
						// Single select: commit and advance
						const s = pickedSet(i);
						s.clear();
						s.add(optionIndex);
						customTexts.delete(i);
						answered.add(i);
						advanceAfterAnswer();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answered.has(i);
							const box = isAnswered ? "■" : "□";
							const text = ` ${box} ${questions[i].header} `;
							const styled = isActive
								? theme.bg("selectedBg", theme.fg("text", text))
								: theme.fg(isAnswered ? "success" : "muted", text);
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
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					const onSubmitTab = currentTab === questions.length;
					const question = onSubmitTab ? undefined : q();
					const opts = onSubmitTab ? [] : currentOptions();
					const multi = question?.multiSelect === true;
					const pickedNow = onSubmitTab ? new Set<number>() : pickedSet(currentTab);
					const customNow = onSubmitTab ? [] : (customTexts.get(currentTab) ?? []);

					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const focused = i === optionIndex;
							const prefix = focused ? theme.fg("accent", "❯ ") : "  ";
							let marker = "";
							if (multi && !opt.isOther) {
								marker = pickedNow.has(i) ? theme.fg("success", "[x] ") : theme.fg("muted", "[ ] ");
							}
							const editing = opt.isOther && inputMode;
							const label = `${opt.label}${editing ? " ✎" : ""}`;
							const color = focused || editing ? "accent" : "text";
							addWrappedWithPrefix(prefix, marker + theme.fg(color, label));
							if (opt.description) {
								addWrappedWithPrefix(multi && !opt.isOther ? "      " : "    ", theme.fg("muted", opt.description));
							}
						}
						if (customNow.length > 0) {
							for (const c of customNow) {
								addWrappedWithPrefix("  ", theme.fg("success", "[x] ") + theme.fg("text", `(wrote) ${c}`));
							}
						}
					}

					function renderPreview() {
						const opt = opts[optionIndex];
						if (!opt || !opt.preview || multi) return;
						lines.push("");
						const inner = Math.max(1, renderWidth - 4);
						addWrappedWithPrefix(" ", theme.fg("dim", `┌ preview ${"─".repeat(Math.max(0, inner - 9))}`));
						for (const raw of opt.preview.split("\n")) {
							for (const w of wrapTextWithAnsi(raw === "" ? " " : raw, inner)) {
								addWrappedWithPrefix(" ", theme.fg("dim", "│ ") + theme.fg("muted", w));
							}
						}
						addWrappedWithPrefix(" ", theme.fg("dim", `└${"─".repeat(Math.max(0, inner + 1))}`));
					}

					if (inputMode && question) {
						addWrappedWithPrefix(" ", theme.fg("text", theme.bold(question.question)));
						lines.push("");
						renderOptions();
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
					} else if (onSubmitTab) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (let i = 0; i < questions.length; i++) {
							if (!answered.has(i)) continue;
							const a = buildAnswer(i);
							addWrappedWithPrefix(
								" ",
								theme.fg("muted", `${a.header}: `) + theme.fg("text", a.labels.join(", ") || "(none)"),
							);
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							const missing = questions
								.filter((_, i) => !answered.has(i))
								.map((qq) => qq.header)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (question) {
						addWrappedWithPrefix(" ", theme.fg("text", theme.bold(question.question)));
						if (multi) {
							addWrappedWithPrefix(" ", theme.fg("dim", "(multiple choice)"));
						}
						lines.push("");
						renderOptions();
						renderPreview();
					}

					lines.push("");
					if (!inputMode) {
						const parts: string[] = [];
						if (isMulti) parts.push("Tab/←→ questions");
						parts.push("↑↓ move");
						if (multi) parts.push("Space toggle • Enter confirm");
						else parts.push("Enter select");
						parts.push("Esc cancel");
						addWrappedWithPrefix(" ", theme.fg("dim", parts.join(" • ")));
					}
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

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User declined to answer (cancelled the dialog)" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const parts = a.labels.map((l) => (a.customLabels.includes(l) ? `(user wrote) ${l}` : l));
				return `${a.header}: ${parts.join(", ")}`;
			});

			return {
				content: [{ type: "text", text: `User answered:\n${answerLines.join("\n")}` }],
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
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const parts = a.labels.map((l) =>
					a.customLabels.includes(l) ? `${theme.fg("muted", "(wrote) ")}${l}` : l,
				);
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${parts.join(", ")}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
