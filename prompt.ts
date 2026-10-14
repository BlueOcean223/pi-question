/**
 * What the model is told about this tool, split by where Pi puts each piece.
 *
 * - `PROMPT_SNIPPET` renders as one line of the system prompt's "Available
 *   tools" inventory. A tool without a snippet is left out of that list
 *   entirely, so this is what makes the tool visible at all.
 * - `PROMPT_GUIDELINES` render as bullets in the system prompt's global
 *   guidelines. They are in context every turn, so they carry policy only:
 *   when to ask, how often, and how to read an answer that is not a clean yes.
 * - `TOOL_DESCRIPTION` sits on the tool definition and is read when the model
 *   is already considering the call, so it carries mechanics: how to fill the
 *   parameters, what previews are for, and what each outcome means.
 *
 * The split is deliberate — repeating the whole policy in both places wastes
 * context and invites the two copies to drift apart. Only the trigger is stated
 * twice, because either half may be acted on alone.
 */

import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./types.ts";

export const PROMPT_SNIPPET = "Ask the user to choose between written-out options when a decision is theirs, not yours";

export const PROMPT_GUIDELINES: string[] = [
	`Call ask_user_question when the task hides a decision that is genuinely the user's: competing approaches with real trade-offs, a requirement the codebase cannot answer, a preference with no conventional default. If you can verify the answer yourself, or one option is the obvious default, decide it, say so in one line, and keep going — asking about those is the more annoying failure.`,
	`Spend the interruption once: do everything that does not depend on the answer first, then raise every open decision in a single ask_user_question call of up to ${MAX_QUESTIONS} questions rather than stacking calls turn after turn.`,
	`An ask_user_question answer can come back partial — questions skipped, notes attached instead of a choice, an answer typed in the user's own words, or a request to talk it through instead. Act on what it actually says; a skip or a note is not approval to proceed on that point.`,
	`When you ask with ask_user_question, lead with your own read: unless the choice is purely the user's taste, make the option you would pick the first one and append " (Recommended)" to its label. Laying out options as equals when you do not think they are equal just hands the work back.`,
];

export const TOOL_DESCRIPTION = `Ask the user up to ${MAX_QUESTIONS} multiple-choice questions in one interactive dialog and wait for the answers.

WHEN TO USE
You are blocked on a decision that is genuinely the user's to make and the answer changes what you do next.

WHEN NOT TO USE
There is a conventional default; the answer is in the codebase and you can go read it; you are asking permission to do work you were already asked to do; or you want a plan approved — state the plan in your reply instead. In all of these, decide, say what you decided in one line, and continue.

WRITING THE QUESTIONS
- ${MIN_OPTIONS}-${MAX_OPTIONS} options per question. Each needs a label of 1-5 words and a description that says what the choice costs or implies — not a restatement of the label.
- The options must be genuinely distinct paths. If only one real path exists, do not call this tool: state that path and continue.
- 'question' is the full text the user reads, ends with a question mark, and must be unique within the call. 'header' is its short chip in the tab bar (max 12 characters).
- Default to recommending. You have usually just read the code and know something the user does not, so put the option you would pick first, append " (Recommended)" to its label, and give the reason in its description. Leave the recommendation off only when the choice is genuinely the user's taste or you have no basis to prefer one — do not manufacture a recommendation to satisfy the convention.
- Never author "Other", "None", "Skip", or "Chat" options. Every question automatically gets a free-text row, a Skip row, and a "Chat about this" row — authoring your own duplicates them and wastes an option slot.
- Set multiSelect only when several answers can hold at once.

PREVIEWS
An option may carry 'preview': multi-line markdown (code snippet, ASCII mockup, config example, diagram) rendered in a box beside the option list while that option is focused. Use it when the user is choosing between concrete artifacts they need to compare, not for preference questions where labels and descriptions already say everything. Single-select only. A question with previews drops the free-text row — a typed fifth answer has nothing to compare against — and offers a notes field instead.

ATTACHED IMAGES
The user can attach screenshots while answering. They come back as image blocks after the text, and the text names them in the order they appear and says which question each belongs to. An attached image is evidence the user chose to show you — read it before you act on the words, and treat what it shows as the current state of things, not as something you produced.

READING THE RESULT
Answers come back keyed by the full question text, with the selected option's preview and any notes echoed alongside. The reply also tells you how the dialog ended, and these are not equivalent:
- Fully answered: proceed on those answers.
- Typed, not chosen: an answer marked as typed by the user is their own wording, not one of your options. It is as likely to be an instruction ("check the schema first", "neither — do X") as a choice. Follow it literally rather than mapping it onto the nearest option you wrote.
- Partial, skipped, or notes only — including a submit with nothing answered at all: the user withheld something on purpose. Do not quietly fill the gap with your own preference, and read the notes — they may tell you not to proceed at all.
- Declined: continue with your best judgment or ask different questions. Do not immediately re-ask the same ones.
- Chat: the user wants to discuss it. Ask what they would like to clarify. This is a request for conversation, not a refusal.
- Idle auto-continue: nobody was at the keyboard. Treat whatever was selected as a weak signal, not as consent.`;
