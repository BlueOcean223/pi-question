/**
 * The text field behind the "Type about this" row and the `n` notes line.
 *
 * A headless `Editor` holds the text: it is never added to the component tree
 * and never renders itself — the dialog draws the buffer inline so a long answer
 * wraps across the row instead of scrolling sideways in a one-line box. What the
 * Editor is here for is everything a text field needs and nobody wants to
 * reimplement: multi-line input, bracketed paste, word navigation, kill ring,
 * and undo.
 *
 * Two details are load-bearing:
 *
 * - `disableSubmit` is set. The dialog owns confirm semantics, so any key that
 *   reaches the Editor is text editing. Left enabled, a `tui.input.submit` match
 *   inside the Editor runs its own submit, which clears the buffer — and with no
 *   `onSubmit` wired, the draft is simply gone.
 * - The value kept for the model is `getExpandedText()`, not `getText()`. A long
 *   paste is stored as a compact `[paste #1 +40 lines]` marker, which is the
 *   right thing to show in a one-row field and the wrong thing to hand the model.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, type EditorTheme, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

/** A headless Editor wired the way the dialog needs it. */
export function createHeadlessEditor(tui: TUI, theme: Theme): Editor {
	const editor = new Editor(tui, createEditorTheme(theme));
	editor.disableSubmit = true;
	return editor;
}

/** Text as displayed (paste markers intact). */
export function displayText(editor: Editor): string {
	return editor.getText();
}

/** Text as handed to the model (paste markers expanded to their content). */
export function storedText(editor: Editor): string {
	return editor.getExpandedText?.() ?? editor.getText();
}

/**
 * Cursor position as an offset into `displayText`. The Editor reports
 * line/column; the inline renderer needs a single index into the flat buffer.
 */
export function cursorOffset(editor: Editor): number {
	const { line, col } = editor.getCursor();
	const lines = editor.getLines();
	let offset = 0;
	for (let i = 0; i < line && i < lines.length; i++) offset += lines[i].length + 1;
	return offset + col;
}

// Grapheme-aware so the cursor cell never splits an emoji or a combining mark
// across the reverse-video boundary.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Insert a reverse-video cell at the cursor without shifting any character.
 * At end-of-buffer, and on a literal space, the cell is a non-breaking space:
 * a real space there would tokenize as a wrap break and move the cursor.
 */
function withCursorCell(buffer: string, offset: number): string {
	const clamped = offset >= 0 && offset <= buffer.length ? offset : buffer.length;
	const before = buffer.slice(0, clamped);
	const [first] = graphemes.segment(buffer.slice(clamped));
	const at = first ? first.segment : "";
	// A newline occupies no cell: draw on a placeholder just before it and leave
	// the newline in place so the next logical line still renders.
	const atLineEnd = at === "\n";
	const cell = at === "" || at === " " || atLineEnd ? "\xa0" : at;
	const after = buffer.slice(clamped + (atLineEnd ? 0 : at.length));
	return `${before}${CURSOR_MARKER}\x1b[7m${cell}\x1b[27m${after}`;
}

export interface InlineBufferOptions {
	buffer: string;
	/** Undefined or out of range falls back to end-of-buffer. */
	cursorOffset: number | undefined;
	/** Whether to draw the cursor cell at all. */
	focused: boolean;
	/** Prefix for the first line, e.g. `❯ 4. `. */
	prefix: string;
	/** Prefix for wrapped continuation lines — whitespace of the same width. */
	continuationPrefix: string;
	/** Columns available to the text itself. */
	contentWidth: number;
	style?: (text: string) => string;
}

/** Render the buffer across as many lines as it wraps to. */
export function renderInlineBuffer(opts: InlineBufferOptions): string[] {
	const { buffer, focused, prefix, continuationPrefix, contentWidth, style } = opts;
	const raw = focused ? withCursorCell(buffer, opts.cursorOffset ?? buffer.length) : buffer;
	const wrapped = wrapTextWithAnsi(raw, Math.max(1, contentWidth));
	if (wrapped.length === 0) wrapped.push("");
	return wrapped.map((segment, i) => (i === 0 ? prefix : continuationPrefix) + (style ? style(segment) : segment));
}

// ---------- External editor ----------

export interface EditorLifecycle {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

function runEditor(command: string, file: string): Promise<void> {
	// Same argv grammar as Pi's own external-editor flow, so Ctrl+G behaves the
	// same here as it does in the prompt.
	const [editor, ...args] = command.split(" ");
	if (!editor) return Promise.reject(new Error("External editor command is empty"));

	return new Promise((resolve, reject) => {
		const child = spawn(editor, [...args, file], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`External editor exited with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`));
		});
	});
}

/** Hand the draft to the user's `$EDITOR` and read back what they saved. */
export async function editExternally(tui: EditorLifecycle, command: string, value: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "pi-question-"));
	const file = join(dir, "answer.md");
	let stopped = false;
	try {
		writeFileSync(file, value, "utf8");
		tui.stop();
		stopped = true;
		process.stdout.write(`Launching external editor: ${command}\npi will resume when the editor exits.\n`);
		await runEditor(command, file);
		return readFileSync(file, "utf8").replace(/\r?\n$/, "");
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort — never leave the TUI stopped because cleanup failed.
		}
		if (stopped) {
			tui.start();
			tui.requestRender(true);
		}
	}
}
