/**
 * Turning image file paths the user wrote into attachments the model receives.
 *
 * The text field is the single source of truth: an image is attached because
 * its path appears in the answer, so deleting the path detaches it and the
 * model still reads the file name alongside the answer. One mechanism covers
 * both ways an image gets in — the paste key inserts a path, and a file
 * dragged onto the terminal arrives as a path already.
 *
 * Extraction is deliberately conservative. A token only counts when it ends in
 * an image extension *and* names a file that exists *and* sniffs as an image,
 * so mentioning `logo.png` in passing costs nothing.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import {
	convertToPng,
	detectSupportedImageMimeTypeFromFile,
	formatDimensionNote,
	resizeImage,
} from "@earendil-works/pi-coding-agent";

/** Content block shape Pi hands to the provider. Structural, so no deep import. */
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

/** Resize bounds a model publishes for images entering its context. */
export interface ResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

/** Mime types that can go to a provider as-is; anything else is converted. */
const INLINE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Ceiling for the unresized fallback, in base64 characters — the same unit the
 * resizer measures its own budget in, and the one that decides the request size.
 */
const UNRESIZED_MAX_BASE64 = 4.5 * 1024 * 1024;

/** Refused before reading: no file this big becomes an inline image. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** Default cap per call, unless the model publishes a smaller one. */
const MAX_ATTACHMENTS = 8;

// ---------- Extraction (pure) ----------

const QUOTED = /"([^"\n]+)"|'([^'\n]+)'|[“”]([^“”\n]+)[“”]/g;
// Punctuation that ends a sentence rather than a file name. Both widths, since
// a CJK answer wraps the path in full-width commas, brackets, and quotes.
const TRAILING = /[.,;:!?)\]}>，。、；：！？）】》」』”’]+$/;
const LEADING = /^[(\[{<（【《「『“‘@]+/;

/** True only with a name in front of the extension: a bare `.png` is prose. */
function hasImageExtension(token: string): boolean {
	const lower = token.toLowerCase();
	return IMAGE_EXTENSIONS.some((ext) => {
		if (!lower.endsWith(ext)) return false;
		const stem = token.slice(0, -ext.length);
		return stem.length > 0 && !stem.endsWith("/") && !stem.endsWith("\\");
	});
}

function clean(token: string): string {
	return stripFileUrl(token.replace(LEADING, "").replace(TRAILING, ""));
}

/** `file:///a/b.png` is what several terminals produce on drag-and-drop. */
function stripFileUrl(token: string): string {
	if (!token.toLowerCase().startsWith("file://")) return token;
	const withoutScheme = token.slice(7).replace(/^localhost/, "");
	try {
		return decodeURIComponent(withoutScheme);
	} catch {
		return withoutScheme;
	}
}

/**
 * Split on whitespace, keeping `\ ` escapes together — the form a path takes
 * when a terminal writes it for a dragged file whose name has spaces.
 *
 * Full-width punctuation splits too. A sentence in Chinese or Japanese puts no
 * spaces around a path, so `（/tmp/a.png）` would otherwise be one long token
 * with the path buried in the middle. Ideographs themselves are not separators:
 * a file name may well be written in them.
 */
const WIDE_PUNCTUATION = /[，。、；：！？（）【】《》〈〉「」『』…·]/;

function splitTokens(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\" && i + 1 < text.length && /\s/.test(text[i + 1])) {
			current += text[i + 1];
			i++;
			continue;
		}
		if (/\s/.test(ch) || WIDE_PUNCTUATION.test(ch)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

/**
 * Image-looking paths in a piece of answer text, in the order they appear.
 *
 * Quoted spans are read first, so a path with spaces survives; a span is only
 * consumed when it looks like a path, which is what keeps an apostrophe in
 * ordinary prose from swallowing the rest of the sentence.
 */
export function extractImagePathCandidates(text: string): string[] {
	const found: string[] = [];
	const rest = text.replace(QUOTED, (match, ...groups: (string | undefined)[]) => {
		const candidate = clean(groups[0] ?? groups[1] ?? groups[2] ?? "");
		if (!hasImageExtension(candidate)) return match;
		found.push(candidate);
		return " ".repeat(match.length);
	});
	for (const token of splitTokens(rest)) {
		const candidate = clean(token);
		if (candidate && hasImageExtension(candidate)) found.push(candidate);
	}
	return [...new Set(found)];
}

/** File name shown in the dialog and named for the model. */
export function attachmentLabel(path: string): string {
	return basename(path);
}

// ---------- Resolution ----------

const NARROW_NO_BREAK_SPACE = " ";

function expand(candidate: string, cwd: string): string {
	let path = candidate;
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Absolute path of an existing file, or undefined.
 *
 * The variants cover how macOS writes screenshot names versus how a person
 * types them: a narrow no-break space before AM/PM, decomposed Unicode, and a
 * curly apostrophe where the keyboard produced a straight one.
 */
export function resolveImagePath(candidate: string, cwd: string): string | undefined {
	const base = expand(candidate, cwd);
	const nfd = base.normalize("NFD");
	const variants = [
		base,
		base.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		nfd,
		base.replace(/'/g, "’"),
		nfd.replace(/'/g, "’"),
	];
	for (const variant of variants) {
		try {
			if (existsSync(variant)) return variant;
		} catch {
			// An unreadable path is simply not an attachment.
		}
	}
	return undefined;
}

/** Existing image files named in one piece of text, resolved and deduped. */
export function attachedPaths(text: string, cwd: string, resolvePath = resolveImagePath): string[] {
	const paths: string[] = [];
	for (const candidate of extractImagePathCandidates(text)) {
		const path = resolvePath(candidate, cwd);
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

// ---------- Loading ----------

export type LoadedImage =
	| { ok: true; data: string; mimeType: string; hints: string[] }
	| { ok: false; message: string };

/**
 * Convert formats a provider will not take, then resize to the model's budget.
 * Hints record anything the model should know about what it is looking at — a
 * rescale changes pixel coordinates, which matters the moment the image is a
 * screenshot of a UI.
 */
async function encodeImage(
	name: string,
	bytes: Uint8Array,
	mimeType: string,
	resizeOptions?: ResizeOptions,
): Promise<LoadedImage> {
	const hints: string[] = [];
	let source = bytes;
	if (!INLINE_MIME_TYPES.includes(mimeType)) {
		const converted = await convertToPng(Buffer.from(bytes).toString("base64"), mimeType);
		if (!converted) {
			return { ok: false, message: `[${name} was not sent: ${mimeType} could not be converted to a supported format.]` };
		}
		hints.push(`[${name} was converted from ${mimeType} to ${converted.mimeType}.]`);
		source = Buffer.from(converted.data, "base64");
		mimeType = converted.mimeType;
	}

	const resized = await resizeImage(source, mimeType, resizeOptions);
	if (resized) {
		const note = formatDimensionNote(resized);
		if (note) hints.push(`${name}: ${note}`);
		return { ok: true, data: resized.data, mimeType: resized.mimeType, hints };
	}
	// The resizer is optional at runtime. Dropping the user's screenshot because
	// it was unavailable is worse than sending an image that was already small
	// enough, so fall back rather than fail.
	const data = Buffer.from(source).toString("base64");
	if (data.length > UNRESIZED_MAX_BASE64) {
		return { ok: false, message: `[${name} was not sent: it could not be resized below the size limit.]` };
	}
	hints.push(`[${name} was sent at its original size: the image resizer was unavailable.]`);
	return { ok: true, data, mimeType, hints };
}

/**
 * Read one file into a provider-ready block.
 *
 * Every failure is a message rather than a throw: these run after the dialog
 * has closed, and one unreadable file must not cost the user the answers they
 * just gave.
 */
export async function loadImage(path: string, resizeOptions?: ResizeOptions): Promise<LoadedImage> {
	const name = attachmentLabel(path);
	try {
		const mimeType = await detectSupportedImageMimeTypeFromFile(path);
		// Covers an empty file too: nothing sniffs as an image.
		if (!mimeType) return { ok: false, message: `[${name} was not sent: it is not a readable image file.]` };
		if (statSync(path).size > MAX_SOURCE_BYTES) {
			return { ok: false, message: `[${name} was not sent: the file is too large to attach.]` };
		}
		return await encodeImage(name, readFileSync(path), mimeType, resizeOptions);
	} catch {
		return { ok: false, message: `[${name} was not sent: it could not be read as an image.]` };
	}
}

// ---------- Collection ----------

export interface Attachment {
	/** Full text of the question the image was attached to. */
	question: string;
	path: string;
	name: string;
}

export interface CollectOptions {
	/** False when the active model cannot read images at all. */
	vision: boolean;
	resizeOptions?: ResizeOptions;
	/** Cap for one tool result. */
	maxImages?: number;
}

export interface CollectedImages {
	blocks: ImageBlock[];
	/** What was actually sent, in block order. */
	attached: Attachment[];
	/** Model-facing notes about conversions, rescales, and anything dropped. */
	notes: string[];
}

/** Sources are `{question, paths}` pairs, one per answered question. */
export async function collectImages(
	sources: { question: string; paths: string[] }[],
	options: CollectOptions,
): Promise<CollectedImages> {
	const requested: Attachment[] = [];
	for (const source of sources) {
		for (const path of source.paths) {
			if (!requested.some((a) => a.path === path)) {
				requested.push({ question: source.question, path, name: attachmentLabel(path) });
			}
		}
	}
	if (requested.length === 0) return { blocks: [], attached: [], notes: [] };

	const names = requested.map((a) => a.name).join(", ");
	if (!options.vision) {
		return {
			blocks: [],
			attached: [],
			notes: [
				`The user attached ${requested.length === 1 ? "an image" : `${requested.length} images`} (${names}), ` +
					`but the current model cannot read images, so ${requested.length === 1 ? "it was" : "they were"} not sent. ` +
					`Ask the user to describe what it shows, or suggest switching to a model that accepts images.`,
			],
		};
	}

	const cap = Math.max(1, Math.min(options.maxImages ?? MAX_ATTACHMENTS, MAX_ATTACHMENTS));
	const notes: string[] = [];
	const overflow = requested.slice(cap);
	if (overflow.length > 0) {
		notes.push(
			`Only the first ${cap} images were sent. Not sent: ${overflow.map((a) => a.name).join(", ")}. ` +
				`Read them with the read tool if you need them.`,
		);
	}

	// Loaded together: each one is a file read plus a resize on its own worker,
	// and the person is waiting on all of them with the dialog already gone.
	const sent = requested.slice(0, cap);
	const loaded = await Promise.all(sent.map((a) => loadImage(a.path, options.resizeOptions)));

	const blocks: ImageBlock[] = [];
	const attached: Attachment[] = [];
	for (const [i, result] of loaded.entries()) {
		if (!result.ok) {
			notes.push(result.message);
			continue;
		}
		blocks.push({ type: "image", data: result.data, mimeType: result.mimeType });
		attached.push(sent[i]);
		notes.push(...result.hints);
	}
	return { blocks, attached, notes };
}
