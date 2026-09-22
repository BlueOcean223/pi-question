/**
 * Reading the system clipboard for the paste-image key.
 *
 * A terminal cannot paste binary data, so an image has to be fetched out of
 * band: the native helper Pi ships handles macOS and Windows, and on Linux the
 * usual command-line tools are tried first because the native X11 path does not
 * see a Wayland selection.
 *
 * `undefined` from a backend means "this backend is unavailable or failed" and
 * the next one is tried; `null` means "this backend works and the clipboard
 * holds no image", which must not fall through to a stale selection owned by a
 * different display server.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { getNativeClipboard } from "@earendil-works/pi-tui";

const LIST_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 3000;
const MAX_CLIPBOARD_BYTES = 50 * 1024 * 1024;

/** Image mime types worth asking a Linux clipboard tool for, best first. */
const WANTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	for (let i = 0; i < text.length; i++) {
		if (bytes[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

/**
 * File extension for clipboard bytes, from their magic number. Only used to
 * name the temporary file — what the image actually is gets sniffed again when
 * the attachment is read back, so an unrecognized blob defaulting to `.png` is
 * harmless.
 */
export function extensionFromMagic(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (startsWithAscii(bytes, 0, "GIF8")) return "gif";
	if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) return "webp";
	if (startsWithAscii(bytes, 0, "BM")) return "bmp";
	return "png";
}

/** Undefined means the command is missing, timed out, or exited non-zero. */
function run(command: string, args: string[], timeoutMs = READ_TIMEOUT_MS): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		} catch {
			resolve(undefined);
			return;
		}
		const chunks: Buffer[] = [];
		let length = 0;
		let settled = false;
		const finish = (result: Buffer | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const abort = () => {
			child.kill("SIGKILL");
			child.stdout?.destroy();
			finish(undefined);
		};
		const timer = setTimeout(abort, timeoutMs);
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks, length) : undefined));
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			length += chunk.length;
			if (length > MAX_CLIPBOARD_BYTES) abort();
			else chunks.push(chunk);
		});
	});
}

function isWayland(env = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function isWsl(env = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf-8"));
	} catch {
		return false;
	}
}

function listedMimeType(list: Buffer): string | undefined {
	const offered = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.split(";")[0]?.trim().toLowerCase())
		.filter((t): t is string => Boolean(t));
	return WANTED_MIME_TYPES.find((wanted) => offered.includes(wanted)) ?? offered.find((t) => t.startsWith("image/"));
}

async function readImageViaWlPaste(): Promise<Uint8Array | null | undefined> {
	const list = await run("wl-paste", ["--list-types"], LIST_TIMEOUT_MS);
	if (list === undefined) return undefined;
	const mimeType = listedMimeType(list);
	if (!mimeType) return null;
	const data = await run("wl-paste", ["--type", mimeType, "--no-newline"]);
	if (data === undefined) return undefined;
	return data.length > 0 ? new Uint8Array(data) : null;
}

async function readImageViaXclip(): Promise<Uint8Array | null | undefined> {
	const targets = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], LIST_TIMEOUT_MS);
	if (targets !== undefined && !listedMimeType(targets)) return null;
	const preferred = targets && listedMimeType(targets);
	for (const mimeType of new Set(preferred ? [preferred, ...WANTED_MIME_TYPES] : WANTED_MIME_TYPES)) {
		const data = await run("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data !== undefined && data.length > 0) return new Uint8Array(data);
	}
	return undefined;
}

async function readImageViaNative(): Promise<Uint8Array | null | undefined> {
	try {
		const bytes = await getNativeClipboard()?.getImage();
		if (bytes === undefined) return undefined;
		return bytes && bytes.length > 0 ? bytes : null;
	} catch {
		return undefined;
	}
}

/** Clipboard image bytes, or null when the clipboard holds no readable image. */
export async function readClipboardImage(): Promise<Uint8Array | null> {
	if (process.env.TERMUX_VERSION) return null;
	if (process.platform !== "linux") return (await readImageViaNative()) ?? null;

	let image: Uint8Array | null | undefined;
	if (isWayland() || isWsl()) image = await readImageViaWlPaste();
	if (image === undefined) image = await readImageViaXclip();
	if (image === undefined) image = await readImageViaNative();
	return image ?? null;
}

/** Clipboard text, for the fallback when the clipboard holds no image. */
export async function readClipboardText(): Promise<string | null> {
	try {
		const text = await getNativeClipboard()?.getText();
		if (text) return text;
		if (text === null || process.platform !== "linux") return null;
	} catch {
		// Fall through to the command-line tools.
	}
	if (process.platform !== "linux") return null;
	const wl = isWayland() || isWsl() ? await run("wl-paste", ["--no-newline"]) : undefined;
	if (wl !== undefined) return wl.toString("utf-8") || null;
	const x = await run("xclip", ["-selection", "clipboard", "-o"]);
	return x !== undefined ? x.toString("utf-8") || null : null;
}
