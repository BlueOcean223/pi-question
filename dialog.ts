/**
 * The interactive dialog: state, key handling, and rendering for one
 * `ask_user_question` call.
 *
 * Layout is stable by construction — every tab is padded to the tallest
 * question's body so switching tabs never shifts the rows under the cursor —
 * and bounded by the terminal, so a tall questionnaire scrolls inside the body
 * instead of pushing its own header off the top of the screen.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	type Editor,
	isKeyRelease,
	Markdown,
	stripTerminalSequences,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { AFK_COUNTDOWN_MS } from "./afk.js";
import { extensionFromMagic, readClipboardImage, readClipboardText } from "./clipboard.js";
import { attachedPaths, attachmentLabel, resolveImagePath } from "./images.js";
import { COLLAPSE_KEY, createKeymap, formatKeySpec, type KeybindingMatcher, type Keymap } from "./keys.js";
import {
	bodyHeightCap,
	focusWindow,
	globalLeftWidth,
	PREVIEW_COLUMN_GAP,
	SIDE_BY_SIDE_MIN_WIDTH,
} from "./layout.js";
import { hasPreviewLayout, ROW_INTENT, rowDigit, rowsFor, type SentinelKind } from "./rows.js";
import {
	createHeadlessEditor,
	cursorOffset,
	displayText,
	editExternally,
	renderInlineBuffer,
	storedText,
} from "./text-input.js";
import type { Answer, AskResult, Question } from "./types.js";

const PREVIEW_MAX_LINES = 12;

type EditKind = "none" | "freetext" | "notes";

export interface DialogDeps {
	questions: Question[];
	signal?: AbortSignal;
	/** Session working directory — what a relative image path resolves against. */
	cwd: string;
	/** Pi's configured `$EDITOR` command, or undefined when none is set. */
	externalEditorCommand(): string | undefined;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Idle time before the dialog submits what is selected. Absent: wait for the person. */
	afkTimeoutMs?: number;
}

export interface DialogComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	dispose(): void;
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

export function createDialog(deps: DialogDeps) {
	const { questions, signal, cwd, externalEditorCommand, notify, afkTimeoutMs } = deps;
	// A timeout shorter than the countdown counts down from the start.
	const countdownMs = afkTimeoutMs === undefined ? 0 : Math.min(AFK_COUNTDOWN_MS, afkTimeoutMs);

	return (tui: TUI, theme: Theme, kb: KeybindingMatcher | undefined, done: (r: AskResult) => void): DialogComponent => {
		const keys: Keymap = createKeymap(kb);

		// ---- State ----
		let currentTab = 0;
		let editing: EditKind = "none";
		let collapsed = false;
		let cachedLines: string[] | undefined;
		const cursorByQ = questions.map(() => 0);
		// Sticky "which option's preview is showing" for preview-layout questions:
		// stays put when focus moves onto Skip/Chat, instead of snapping to
		// whichever option happens to sit last in the list.
		const lastOptionByQ = questions.map(() => 0);
		const picked = questions.map(() => new Set<number>());
		const freeformSelected = questions.map(() => false);
		const skipped = questions.map(() => false);

		// One editor per field per question, created on first use. Keeping them
		// alive is what makes a draft survive a tab switch with its paste markers,
		// undo history, and cursor position intact.
		const freeEditors: (Editor | undefined)[] = questions.map(() => undefined);
		const notesEditors: (Editor | undefined)[] = questions.map(() => undefined);

		let lastActivity = Date.now();
		let afkTimer: ReturnType<typeof setInterval> | undefined;

		const isMulti = questions.length > 1;
		const totalTabs = questions.length + 1; // questions + Submit

		const mdTheme = getMarkdownTheme();
		const mdCache = new Map<string, string[]>(); // `${qi}:${oi}:${width}` -> rendered lines
		const heightCache = new Map<number, number>(); // width -> global body height
		const leftWidthCache = new Map<number, number>(); // width -> preview column split

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		// ---- Text fields ----

		function freeEditor(qi: number): Editor {
			const existing = freeEditors[qi];
			if (existing) return existing;
			const created = createHeadlessEditor(tui, theme);
			freeEditors[qi] = created;
			return created;
		}

		function notesEditor(qi: number): Editor {
			const existing = notesEditors[qi];
			if (existing) return existing;
			const created = createHeadlessEditor(tui, theme);
			notesEditors[qi] = created;
			return created;
		}

		/** Free-text answer as the model will see it (pastes expanded). */
		function freeformText(qi: number): string {
			const ed = freeEditors[qi];
			return ed ? storedText(ed) : "";
		}

		/** Free-text answer as the row shows it (pastes as compact markers). */
		function freeformDisplay(qi: number): string {
			const ed = freeEditors[qi];
			return ed ? displayText(ed) : "";
		}

		function notesText(qi: number): string {
			const ed = notesEditors[qi];
			return ed ? storedText(ed) : "";
		}

		function notesDisplay(qi: number): string {
			const ed = notesEditors[qi];
			return ed ? displayText(ed) : "";
		}

		function activeEditor(): Editor | undefined {
			if (editing === "freetext") return freeEditor(currentTab);
			if (editing === "notes") return notesEditor(currentTab);
			return undefined;
		}

		// ---- Image attachments ----

		// Rendering re-reads the fields on every keystroke, so the filesystem
		// lookup behind "is this token a real file" is answered once per token.
		const resolvedPaths = new Map<string, string | undefined>();

		function resolveCached(candidate: string, base: string): string | undefined {
			if (resolvedPaths.has(candidate)) return resolvedPaths.get(candidate);
			const resolved = resolveImagePath(candidate, base);
			resolvedPaths.set(candidate, resolved);
			return resolved;
		}

		/** Image files named across the given field texts, in order, deduped. */
		function imagePathsIn(...texts: string[]): string[] {
			const paths: string[] = [];
			for (const text of texts) {
				for (const path of attachedPaths(text, cwd, resolveCached)) {
					if (!paths.includes(path)) paths.push(path);
				}
			}
			return paths;
		}

		/** The `📎 name.png` confirmation drawn under a field. */
		function attachmentLines(text: string, indent: number, width: number): string[] {
			const avail = Math.max(4, width - indent);
			return imagePathsIn(text).map(
				(path) => " ".repeat(indent) + theme.fg("dim", truncateToWidth(`📎 ${attachmentLabel(path)}`, avail)),
			);
		}

		// ---- Question/row model ----

		function q(i: number = currentTab): Question {
			return questions[Math.min(i, questions.length - 1)];
		}

		function cursor(): number {
			return cursorByQ[currentTab] ?? 0;
		}

		function setCursor(v: number) {
			const rows = rowsFor(q());
			const clamped = Math.max(0, Math.min(v, rows.length - 1));
			cursorByQ[currentTab] = clamped;
			const row = rows[clamped];
			if (row.kind === "option") lastOptionByQ[currentTab] = row.optionIndex;
		}

		function isAnswered(qi: number): boolean {
			return picked[qi].size > 0 || (freeformSelected[qi] && freeformText(qi).trim().length > 0);
		}

		function hasNotes(qi: number): boolean {
			return notesText(qi).trim().length > 0 || (freeformText(qi).trim().length > 0 && !freeformSelected[qi]);
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
			const text = freeformText(qi).trim();
			const custom = freeformSelected[qi] && text ? [text] : [];
			// Typed text the user didn't end up voting with rides along as a note
			// instead of being dropped. Only one source can be set per question:
			// preview questions have `n` notes and no free-text row, and vice versa.
			const strayTyped = text && custom.length === 0 ? text : undefined;
			const noteFromN = notesText(qi).trim() || undefined;
			const notes = noteFromN ?? strayTyped;
			let preview: string | undefined;
			if (!question.multiSelect && picked[qi].size === 1) {
				preview = question.options[[...picked[qi]][0]].preview;
			}
			const chosen = [...labels, ...custom];
			const notesOnly = chosen.length === 0 && !!notes;
			// Both fields, whatever each one ended up being used for: a path typed
			// as the answer attaches just as much as one written in a note.
			const attachments = imagePathsIn(freeformText(qi), notesText(qi));
			return {
				header: question.header,
				question: question.question,
				labels: chosen,
				customLabels: custom,
				...(notesOnly ? { notesOnly: true } : {}),
				...(notes ? { notes } : {}),
				...(preview ? { preview } : {}),
				...(attachments.length > 0 ? { attachments } : {}),
			};
		}

		function syncFreeformSelection() {
			const i = currentTab;
			const text = freeformText(i).trim();
			if (text && picked[i].size === 0) freeformSelected[i] = true;
			else if (!text) freeformSelected[i] = false;
		}

		function flushEdits() {
			if (editing === "freetext") syncFreeformSelection();
			editing = "none";
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
				afkTimeoutMs,
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
			if (seedData) freeEditor(currentTab).handleInput(seedData);
			else freeEditor(currentTab);
			refresh();
		}

		function startNotesEdit() {
			editing = "notes";
			notesEditor(currentTab);
			refresh();
		}

		/** Leave the field, keeping the text. */
		function saveEdit() {
			const i = currentTab;
			if (editing === "freetext") {
				const text = freeformText(i).trim();
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
			}
			editing = "none";
			refresh();
		}

		function confirmFreetext() {
			const i = currentTab;
			const text = freeformText(i).trim();
			editing = "none";
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
		}

		async function openExternalEditor() {
			const ed = activeEditor();
			if (!ed) return;
			const command = externalEditorCommand();
			if (!command) {
				notify("No external editor is configured", "warning");
				return;
			}
			try {
				ed.setText(await editExternally(tui, command, storedText(ed)));
			} catch (error) {
				notify(`External editor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			refresh();
		}

		let pasting = false;

		/**
		 * Attach whatever image the clipboard holds, falling back to its text.
		 *
		 * A terminal cannot deliver bytes through a paste, so the image is written
		 * to a temporary file and its path inserted as ordinary text. A file
		 * dragged onto the terminal arrives as a path already, so from here on
		 * both are the same thing.
		 *
		 * The clipboard is read before any field is opened: the read can take a
		 * moment, and whichever field is focused when the text is ready is the one
		 * that gets it.
		 */
		async function pasteFromClipboard() {
			if (pasting) return;
			pasting = true;
			try {
				const bytes = await readClipboardImage();
				const text = bytes ? undefined : await readClipboardText();
				if (finished) return;
				if (!bytes && !text) {
					notify("The clipboard holds no image or text", "info");
					return;
				}
				if (editing === "none") {
					if (hasPreviewLayout(q())) startNotesEdit();
					else startFreetextEdit();
				}
				const ed = activeEditor();
				if (!ed) return;
				if (bytes) {
					const file = join(tmpdir(), `pi-question-${randomUUID()}.${extensionFromMagic(bytes)}`);
					writeFileSync(file, bytes);
					insertAtCursor(ed, file);
				} else if (text) {
					insertAtCursor(ed, text);
				}
				refresh();
			} catch (error) {
				notify(`Could not paste from the clipboard: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				pasting = false;
			}
		}

		/** Insert with a space where the text would otherwise run into a word. */
		function insertAtCursor(ed: Editor, text: string) {
			const buffer = displayText(ed);
			const at = cursorOffset(ed);
			const before = buffer.slice(Math.max(0, at - 1), at);
			const after = buffer.slice(at, at + 1);
			const lead = before !== "" && !/\s/.test(before) ? " " : "";
			const trail = after !== "" && !/\s/.test(after) ? " " : "";
			ed.insertTextAtCursor(lead + text + trail);
		}

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

		function activateSentinel(kind: SentinelKind) {
			switch (kind) {
				case "freetext": {
					const question = q();
					if (!question.multiSelect && freeformText(currentTab).trim()) commitCustom();
					else startFreetextEdit();
					return;
				}
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

		function digitAction(n: number) {
			const question = q();
			const rows = rowsFor(question);
			if (hasPreviewLayout(question)) {
				// Previews are for comparing: digits only move focus (across every row,
				// Skip and Chat included), Enter is what decides. Row indices and
				// displayed digits line up here — no free-text row to skip over.
				if (n - 1 < rows.length) {
					setCursor(n - 1);
					refresh();
				}
				return;
			}
			const k = question.options.length;
			if (n <= k) {
				setCursor(n - 1);
				if (question.multiSelect) toggleOption(n - 1);
				else commitOption(n - 1);
				return;
			}
			for (const row of rows) {
				if (row.kind === "option") continue;
				if (rowDigit(question, row.kind as SentinelKind) !== n) continue;
				setCursor(rows.indexOf(row));
				activateSentinel(row.kind as SentinelKind);
				return;
			}
		}

		// ---- Input handling ----

		function bumpActivity() {
			lastActivity = Date.now();
		}

		function handleEditingInput(data: string) {
			bumpActivity();
			const ed = activeEditor();
			if (!ed) return;

			// Newline is tested before confirm: a configuration that binds one key to
			// both must insert a line here, not submit the draft.
			if (keys.newline(data)) {
				ed.handleInput(data);
				refresh();
				return;
			}
			if (keys.externalEditor(data)) {
				void openExternalEditor();
				return;
			}
			if (keys.pasteImage(data)) {
				void pasteFromClipboard();
				return;
			}
			if (keys.confirm(data)) {
				if (editing === "notes") saveEdit();
				else confirmFreetext();
				return;
			}
			if (keys.cancel(data)) {
				saveEdit();
				return;
			}
			if (isMulti && editing === "freetext" && (keys.nextTab(data) || keys.prevTab(data))) {
				const delta = keys.nextTab(data) ? 1 : -1;
				saveEdit();
				switchTab(delta);
				return;
			}
			if (keys.up(data) || keys.down(data)) {
				// Inside a multi-line draft the arrows belong to the text; only at the
				// first/last line do they mean "leave this row".
				const { line } = ed.getCursor();
				const lastLine = Math.max(0, ed.getLines().length - 1);
				const goingUp = keys.up(data);
				if ((goingUp && line > 0) || (!goingUp && line < lastLine)) {
					ed.handleInput(data);
					refresh();
					return;
				}
				saveEdit();
				const rows = rowsFor(q());
				setCursor((cursor() + (goingUp ? -1 : 1) + rows.length) % rows.length);
				refresh();
				return;
			}
			ed.handleInput(data);
			refresh();
		}

		function handleInput(data: string) {
			// Kitty-protocol terminals report press and release separately. Nothing in
			// this dialog should fire twice for one keystroke.
			if (isKeyRelease(data)) return;

			// Collapse is reachable from every mode, and while collapsed only it and
			// cancel do anything — the point is that the dialog is out of the way.
			if (keys.collapse(data)) {
				bumpActivity();
				collapsed = !collapsed;
				refresh();
				return;
			}
			if (collapsed) {
				if (keys.cancel(data)) submitCancel();
				return;
			}

			if (editing !== "none") {
				handleEditingInput(data);
				return;
			}

			bumpActivity();

			// Tab navigation
			if (isMulti) {
				if (keys.nextTab(data)) {
					switchTab(1);
					return;
				}
				if (keys.prevTab(data)) {
					switchTab(-1);
					return;
				}
			}

			// Submit tab
			if (currentTab === questions.length) {
				if (keys.confirm(data)) submitAnswered();
				else if (keys.cancel(data)) submitCancel();
				return;
			}

			const question = q();
			const rows = rowsFor(question);

			// Attaching does not need the field open first: the paste opens it.
			if (keys.pasteImage(data)) {
				void pasteFromClipboard();
				return;
			}

			if (keys.up(data)) {
				setCursor((cursor() - 1 + rows.length) % rows.length);
				refresh();
				return;
			}
			if (keys.down(data)) {
				setCursor((cursor() + 1) % rows.length);
				refresh();
				return;
			}
			if (keys.firstRow(data)) {
				setCursor(0);
				refresh();
				return;
			}
			if (keys.lastRow(data)) {
				setCursor(rows.length - 1);
				refresh();
				return;
			}
			if (keys.cancel(data)) {
				submitCancel();
				return;
			}

			const row = rows[cursor()];
			const ch = printableChar(data);

			// Space: toggle (multiSelect), or activate the free-text input.
			// Full-width space is normalized here too, for CJK input methods.
			if (keys.space(data) || ch === "　") {
				if (row.kind === "option" && question.multiSelect) {
					toggleOption(row.optionIndex);
				} else if (row.kind === "freetext") {
					if (question.multiSelect && freeformText(currentTab).trim()) {
						freeformSelected[currentTab] = !freeformSelected[currentTab];
						refresh();
					} else {
						startFreetextEdit();
					}
				}
				return;
			}

			if (keys.confirm(data)) {
				if (row.kind === "option") {
					if (question.multiSelect) toggleOption(row.optionIndex);
					else commitOption(row.optionIndex);
				} else {
					activateSentinel(row.kind as SentinelKind);
				}
				return;
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

		function notesLine(qi: number, width: number, editingNotes: boolean): string[] {
			const label = theme.fg("accent", "Notes: ");
			const labelW = visibleWidth("Notes: ");
			const attached = attachmentLines(notesText(qi), labelW, width);
			if (editingNotes) {
				return [
					...renderInlineBuffer({
						buffer: notesDisplay(qi),
						cursorOffset: cursorOffset(notesEditor(qi)),
						focused: true,
						prefix: label,
						continuationPrefix: " ".repeat(labelW),
						contentWidth: Math.max(4, width - labelW),
					}),
					...attached,
				];
			}
			const text = notesDisplay(qi).trim();
			const body = text
				? theme.italic(theme.fg("muted", truncateToWidth(text.replace(/\n/g, " "), Math.max(4, width - labelW))))
				: theme.fg("dim", "press n to add notes");
			return [label + body, ...attached];
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
				marker = picked[currentTabForRender].has(oi) ? theme.fg("success", "[x] ") : theme.fg("muted", "[ ] ");
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

		function freetextRowLines(question: Question, focused: boolean, isEditing: boolean, width: number): string[] {
			const qi = currentTabForRender;
			const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
			const num = theme.fg("dim", `${rowDigit(question, "freetext")}. `);
			let marker = "";
			if (question.multiSelect) {
				marker = freeformSelected[qi] && freeformText(qi).trim()
					? theme.fg("success", "[x] ")
					: theme.fg("muted", "[ ] ");
			}
			const prefix = pointer + num + marker;
			const prefixW = visibleWidth(prefix);
			const avail = Math.max(4, width - prefixW);
			const attached = attachmentLines(freeformText(qi), prefixW, width);
			// No label in front of the input or the saved text: what the person
			// typed is the answer, and a "Type:" prefix only eats width.
			if (isEditing) {
				return [
					...renderInlineBuffer({
						buffer: freeformDisplay(qi),
						cursorOffset: cursorOffset(freeEditor(qi)),
						focused: true,
						prefix,
						continuationPrefix: " ".repeat(prefixW),
						contentWidth: avail,
					}),
					...attached,
				];
			}
			const text = freeformDisplay(qi).trim();
			if (!text) {
				// Dim: the row is an invitation, not one of the answers on offer.
				return [prefix + truncateToWidth(theme.fg(focused ? "accent" : "dim", ROW_INTENT.freetext.label), avail)];
			}
			const flat = text.replace(/\n/g, " ");
			const body = freeformSelected[qi]
				? theme.fg("text", flat) + theme.fg("success", " ✓")
				: theme.fg("muted", flat) + theme.fg("dim", " (kept as note)");
			return [prefix + truncateToWidth(body, avail), ...attached];
		}

		/** Rule that sets "Chat about this" apart from the rows above it. */
		function separatorLine(width: number): string {
			return theme.fg("dim", "─".repeat(Math.max(1, width)));
		}

		function sentinelRowLine(question: Question, kind: SentinelKind, focused: boolean, qi: number): string {
			const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
			const color = focused ? "accent" : "muted";
			if (kind === "submit") {
				const label = isMulti ? "Next" : "Submit";
				return pointer + "    " + theme.bold(theme.fg(color, label));
			}
			const num = theme.fg("dim", `${rowDigit(question, kind)}. `);
			const label = kind === "skip" && skipped[qi] ? "Skip ✓" : ROW_INTENT[kind].label;
			return pointer + num + theme.fg(color, label);
		}

		// The row-rendering helpers need the question index being rendered
		// (measurement renders non-active questions too).
		let currentTabForRender = 0;

		interface Body {
			lines: string[];
			/** Index of the first line of the focused row, for the scroll window. */
			focusLine: number;
		}

		function previewLeftWidth(width: number): number {
			const cached = leftWidthCache.get(width);
			if (cached !== undefined) return cached;
			const labelsByTab = questions.filter(hasPreviewLayout).map((question) => question.options.map((o) => o.label));
			const value = globalLeftWidth(labelsByTab, width);
			leftWidthCache.set(width, value);
			return value;
		}

		function questionBodyLines(qi: number, width: number, view: { focusRow: number; editingKind: EditKind }): Body {
			const prevTab = currentTabForRender;
			currentTabForRender = qi;
			try {
				const question = questions[qi];
				const rows = rowsFor(question);
				const lines: string[] = [];
				let focusLine = 0;

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
					const leftW = previewLeftWidth(width);
					const rightW = Math.max(10, width - leftW - PREVIEW_COLUMN_GAP);
					const left: string[] = [];
					for (let oi = 0; oi < question.options.length; oi++) {
						if (view.focusRow === oi) focusLine = lines.length + left.length;
						left.push(
							...optionRowLines(question, oi, view.focusRow === oi, leftW, {
								showMarker: false,
								showCheck: true,
								withDescription: false,
							}),
						);
					}
					// Once focus moves past the option list (onto Skip/Chat), keep showing
					// the last option actually looked at rather than snapping to whichever
					// option is last in the array.
					const focusedOption = view.focusRow < question.options.length ? view.focusRow : lastOptionByQ[qi];
					const right = previewBoxLines(qi, focusedOption, rightW);
					const rowCount = Math.max(left.length, right.length);
					for (let t = 0; t < rowCount; t++) {
						lines.push(padToWidth(left[t] ?? "", leftW) + " ".repeat(PREVIEW_COLUMN_GAP) + (right[t] ?? ""));
					}
					// The focused option's description and the Notes line both belong to the
					// option whose preview is showing, so they stay in the preview column,
					// under the box, instead of drifting to the far left.
					const gutter = " ".repeat(leftW + PREVIEW_COLUMN_GAP);
					const desc = question.options[focusedOption]?.description;
					if (desc) {
						for (const line of wrapTextWithAnsi(theme.fg("muted", desc), rightW)) lines.push(gutter + line);
					}
					lines.push("");
					for (const line of notesLine(qi, rightW, view.editingKind === "notes")) lines.push(gutter + line);
					// No leading space on the action rows: their own pointer ("❯ "/"  ") is
					// the indent, same as the option rows above.
					for (let r = question.options.length; r < rows.length; r++) {
						const kind = rows[r].kind as SentinelKind;
						if (ROW_INTENT[kind].blankAbove) lines.push("");
						if (ROW_INTENT[kind].ruleAbove) lines.push(separatorLine(width));
						if (view.focusRow === r) focusLine = lines.length;
						lines.push(sentinelRowLine(question, kind, view.focusRow === r, qi));
					}
					return { lines, focusLine };
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
						for (const line of notesLine(qi, width - 1, view.editingKind === "notes")) lines.push(" " + line);
						lines.push("");
					}
					const intent = ROW_INTENT[row.kind];
					if (intent.blankAbove) lines.push("");
					if (intent.ruleAbove) lines.push(separatorLine(width));
					if (focused) focusLine = lines.length;
					if (row.kind === "option") {
						lines.push(
							...optionRowLines(question, row.optionIndex, focused, width, {
								showMarker: question.multiSelect,
								showCheck: !question.multiSelect,
								withDescription: true,
							}),
						);
					} else if (row.kind === "freetext") {
						lines.push(...freetextRowLines(question, focused, focused && view.editingKind === "freetext", width));
					} else {
						lines.push(sentinelRowLine(question, row.kind as SentinelKind, focused, qi));
					}
				}

				return { lines, focusLine };
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
				const clip = a.attachments?.length ? theme.fg("dim", ` 📎${a.attachments.length}`) : "";
				const note = (a.notes ? theme.fg("dim", " ✎") : "") + clip;
				if (isAnswered(i)) {
					addWrapped(theme.fg("muted", `${a.header}: `) + theme.fg("text", a.labels.join(", ")) + note);
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
						max = Math.max(max, questionBodyLines(i, width, { focusRow: oi, editingKind: "none" }).lines.length);
					}
				} else {
					max = Math.max(max, questionBodyLines(i, width, { focusRow: 0, editingKind: "none" }).lines.length);
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

		/** Undefined when the dialog waits for the person indefinitely. */
		function remainingAfkMs(): number | undefined {
			if (afkTimeoutMs === undefined) return undefined;
			return Math.max(0, afkTimeoutMs - (Date.now() - lastActivity));
		}

		function hintLines(width: number): string[] {
			let parts: string[];
			if (editing === "freetext" || editing === "notes") {
				parts = ["Enter save", "Shift+Enter line", "Ctrl+V image", "Ctrl+G editor", "Esc back"];
				if (editing === "freetext") parts.push("↑↓ move away");
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
			parts.push(`${formatKeySpec(COLLAPSE_KEY)} collapse`);
			const remaining = remainingAfkMs();
			let color: "warning" | "dim" = "dim";
			if (remaining !== undefined && remaining <= countdownMs) {
				parts.push(`auto-submit ${Math.ceil(remaining / 1000)}s`);
				color = "warning";
			}
			const out: string[] = [];
			for (const line of wrapTextWithAnsi(theme.fg(color, parts.join(" · ")), Math.max(1, width - 1))) {
				out.push(" " + line);
			}
			return out;
		}

		/** Clip a too-tall body to a window around the cursor, marking what is hidden. */
		function clipBody(lines: string[], focusLine: number, cap: number): string[] {
			const { start, end } = focusWindow(lines.length, focusLine, cap);
			const out = lines.slice(start, end);
			if (start > 0) out[0] = theme.fg("dim", ` ↑ ${start} more`);
			if (end < lines.length) out[out.length - 1] = theme.fg("dim", ` ↓ ${lines.length - end} more`);
			return out;
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const renderWidth = Math.max(1, width);

			if (collapsed) {
				cachedLines = [
					theme.fg("dim", ` … ask_user_question collapsed — ${formatKeySpec(COLLAPSE_KEY)} to reopen, Esc to cancel`),
				];
				return cachedLines;
			}

			const lines: string[] = [];
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			const tabs = isMulti ? tabBarLines(renderWidth) : [];
			lines.push(...tabs);

			const hint = hintLines(renderWidth);
			// Top rule + tab bar + the blank above the hint + the hint + bottom rule.
			const chromeRows = 1 + tabs.length + 1 + hint.length + 1;
			const cap = bodyHeightCap(tui.terminal.rows, chromeRows);

			let body: string[];
			let focusLine = 0;
			if (currentTab === questions.length) {
				body = submitBodyLines(renderWidth);
			} else {
				const built = questionBodyLines(currentTab, renderWidth, { focusRow: cursor(), editingKind: editing });
				body = built.lines;
				focusLine = built.focusLine;
			}
			// Pad every tab up to the tallest question so switching tabs never shifts
			// the rows, but let a body that outgrows that measurement — a multi-line
			// draft being typed — push taller rather than clip. Only the terminal
			// bound is hard.
			const stable = Math.min(globalBodyHeight(renderWidth), cap);
			const target = Math.min(Math.max(stable, body.length), cap);
			if (body.length > target) body = clipBody(body, focusLine, target);
			else while (body.length < target) body.push("");
			lines.push(...body);

			lines.push("");
			lines.push(...hint);
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;
		}

		// No timeout configured: no timer at all, the dialog waits for the person.
		if (afkTimeoutMs !== undefined) {
			afkTimer = setInterval(() => {
				if (finished) return;
				// A collapsed dialog is one the user deliberately put aside to read the
				// transcript. Auto-submitting something they cannot see is worse than
				// waiting, so the idle clock pauses rather than runs out behind them.
				if (collapsed) {
					bumpActivity();
					return;
				}
				const remaining = remainingAfkMs() ?? Infinity;
				if (remaining <= 0) {
					submitAfk();
					return;
				}
				if (remaining <= countdownMs) refresh();
			}, 1000);
			(afkTimer as { unref?: () => void }).unref?.();
		}

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
	};
}
