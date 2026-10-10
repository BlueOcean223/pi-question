/**
 * pi-question — AskUserQuestion tool for pi
 *
 * Registers `ask_user_question`: an interactive multiple-choice dialog the model
 * opens when it is blocked on a decision that is genuinely the user's, plus a
 * reconciler that hides the tool wherever that dialog cannot render.
 *
 * - Single question: option list; single-select submits on pick
 * - Multiple questions: tab bar (header chips) + Submit review page
 * - Number keys 1-9 select directly (full-width digits normalized)
 * - "Type about this" is an inline field: focus it and just start typing.
 *   Multi-line, paste-aware, Ctrl+G opens the configured external editor
 * - Ctrl+V attaches a clipboard image, and any image path in an answer comes
 *   back to the model as an image block beside the text
 * - Skip: leave a question unanswered and continue (partial submit allowed)
 * - multiSelect: Space/Enter toggle, explicit Next/Submit button confirms
 * - "Chat about this": ends the dialog asking the model to clarify instead;
 *   a rule sets it apart from the option and action rows above it
 * - Option previews: side-by-side layout, markdown-rendered; no free-text row
 *   there — `n` notes are the escape hatch while comparing options
 * - Ctrl+] collapses the dialog to one line so the transcript is readable
 * - Answers keyed by full question text; notes/preview echoed as annotations
 * - Waits for an answer by default; PI_QUESTION_AFK_TIMEOUT opts into an idle
 *   auto-submit of whatever is selected so far
 * - Reports itself to herdr as blocked while it waits
 * - Keys resolve through Pi's keybinding manager, so remaps are honored
 * - Stable layout: every tab padded to the tallest question's height, and the
 *   whole body bounded by the terminal so it never scrolls off the top
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AFK_ENV, formatDuration, parseAfkTimeout } from "./afk.js";
import { createDialog } from "./dialog.js";
import { CANCEL_TEXT, formatAttachments, formatChatAboutThis, formatSubmitted, NOTES_ONLY } from "./format.js";
import { attachmentLabel, collectImages } from "./images.js";
import { PROMPT_GUIDELINES, PROMPT_SNIPPET, TOOL_DESCRIPTION } from "./prompt.js";
import { registerReconciler, TOOL_NAME } from "./reconcile.js";
import { AskParams, type AskResult, type Question } from "./types.js";
import { validateQuestions } from "./validate.js";

/**
 * herdr, a terminal workspace for agents, marks a pane as waiting on its user
 * from this event; with no listener the emit does nothing. Its Pi integration
 * does not read Pi's own prompt events, so a dialog that does not announce
 * itself shows as "working" for as long as nobody answers it.
 */
const BLOCKED_EVENT = "herdr:blocked";

/** A bad value is reported once per process, not on every question. */
let afkConfigWarned = false;

function errorResult(message: string, questions: Question[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { questions, answers: [], outcome: "cancelled" } as AskResult,
	};
}

/**
 * Text and image blocks for a dialog that ran.
 *
 * The images are read here rather than in the dialog so the person is never
 * kept waiting on a disk read and a rescale, and so the bytes stay out of
 * `details`, which is written to the session file verbatim.
 */
async function resultContent(body: string, result: AskResult, model: ExtensionContext["model"]) {
	const sources = result.answers
		.filter((a) => a.attachments && a.attachments.length > 0)
		.map((a) => ({ question: a.question, paths: a.attachments ?? [] }));
	if (sources.length === 0) return [{ type: "text" as const, text: body }];

	let collected: Awaited<ReturnType<typeof collectImages>>;
	try {
		collected = await collectImages(sources, {
			// A model with no image input would be sent a block it cannot read; the
			// user is told about the attachment in words instead.
			vision: model?.input.includes("image") ?? false,
			resizeOptions: model?.inputLimits?.images?.resize,
			maxImages: model?.inputLimits?.images?.maxPerMessage,
		});
	} catch (error) {
		// The answers are the thing that cost the user an interruption. Whatever
		// went wrong with the files, the words still go back.
		const reason = error instanceof Error ? error.message : String(error);
		return [{ type: "text" as const, text: `${body}\n\nThe images the user attached could not be read (${reason}).` }];
	}
	const tail = formatAttachments(collected.attached, collected.notes, result.questions.length > 1);
	const text = tail ? `${body}\n\n${tail}` : body;
	return [{ type: "text" as const, text }, ...collected.blocks];
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User Question",
		description: TOOL_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: AskParams,
		// Declared to the model, never callable from codemode scripts: a script
		// would get the answer as bare text, without the attached images, and
		// `codemode.mode: "only"` would otherwise hide the tool from the model.
		exposure: "model-only",
		// Asking changes nothing, so permission extensions that gate on these
		// hints do not ask the user to approve being asked.
		annotations: { readOnlyHint: true, openWorldHint: false },
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// The reconciler normally strips the tool before the model ever sees it;
			// this stays as a one-turn backstop.
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

			const afk = parseAfkTimeout(process.env[AFK_ENV]);
			if (afk.error && !afkConfigWarned) {
				afkConfigWarned = true;
				ctx.ui.notify(afk.error, "warning");
			}

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
					pi.events.emit(BLOCKED_EVENT, {
						active: true,
						label: `Question: ${questions.map((q) => q.header).join(", ")}`,
					});
					try {
						result = await ctx.ui.custom<AskResult>(
							createDialog({
								questions,
								signal,
								cwd: ctx.cwd,
								externalEditorCommand: () =>
									SettingsManager.create(ctx.cwd, undefined, {
										projectTrusted: ctx.isProjectTrusted(),
									}).getExternalEditorCommand() || undefined,
								notify: (message, type) => ctx.ui.notify(message, type),
								afkTimeoutMs: afk.timeoutMs,
							}),
						);
					} finally {
						pi.events.emit(BLOCKED_EVENT, { active: false });
					}
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
					content: await resultContent(formatChatAboutThis(result.questions, result.answers), result, ctx.model),
					details: result,
				};
			}

			return {
				content: await resultContent(formatSubmitted(result), result, ctx.model),
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
				const duration = details.afkTimeoutMs ? `${formatDuration(details.afkTimeoutMs)} ` : "";
				lines.push(theme.fg("warning", `Auto-continued after ${duration}idle`));
			}
			for (const a of details.answers) {
				if (a.notesOnly) {
					lines.push(
						`${theme.fg("muted", "✎ ")}${theme.fg("accent", a.header)}: ${theme.fg("dim", NOTES_ONLY)}` +
							(a.notes ? theme.fg("dim", ` (note: ${a.notes})`) : ""),
					);
				} else if (a.labels.length > 0) {
					const parts = a.labels.map((l) => (a.customLabels.includes(l) ? `${theme.fg("muted", "(wrote) ")}${l}` : l));
					let line = `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${parts.join(", ")}`;
					if (a.notes) line += theme.fg("dim", ` (note: ${a.notes})`);
					lines.push(line);
				} else {
					lines.push(`${theme.fg("dim", "– ")}${theme.fg("accent", a.header)}: ${theme.fg("dim", "(skipped)")}`);
				}
				// Names only: the thumbnails themselves are drawn by Pi, from the
				// image blocks in the result content.
				for (const path of a.attachments ?? []) {
					lines.push(theme.fg("dim", `  📎 ${attachmentLabel(path)}`));
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

	registerReconciler(pi);
}
