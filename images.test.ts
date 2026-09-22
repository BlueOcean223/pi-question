/**
 * Extraction decides whether a sentence the user typed carries an attachment,
 * so these tests are mostly about what must *not* be picked up: a file name
 * mentioned in passing, an apostrophe in prose, a trailing comma.
 */

import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { extensionFromMagic } from "./clipboard.js";
import { attachedPaths, attachmentLabel, collectImages, extractImagePathCandidates } from "./images.js";

describe("extractImagePathCandidates", () => {
	test("finds a path among ordinary words", () => {
		expect(extractImagePathCandidates("this button is misaligned /tmp/shot.png")).toEqual(["/tmp/shot.png"]);
	});

	test("reads a path out of CJK text with no spaces around it", () => {
		expect(extractImagePathCandidates("这个按钮没对齐 /tmp/shot.png 看一下")).toEqual(["/tmp/shot.png"]);
	});

	test("ignores a token that is not an image", () => {
		expect(extractImagePathCandidates("see src/index.ts and notes.md")).toEqual([]);
	});

	test("matches the extension case-insensitively", () => {
		expect(extractImagePathCandidates("/tmp/Shot.PNG")).toEqual(["/tmp/Shot.PNG"]);
	});

	test("strips sentence punctuation that is not part of the name", () => {
		expect(extractImagePathCandidates("look at /tmp/a.png, then /tmp/b.jpg.")).toEqual(["/tmp/a.png", "/tmp/b.jpg"]);
	});

	test("strips full-width punctuation too", () => {
		expect(extractImagePathCandidates("看这个（/tmp/a.png），有问题")).toEqual(["/tmp/a.png"]);
	});

	test("keeps a quoted path with spaces in one piece", () => {
		expect(extractImagePathCandidates('use "/tmp/my shot.png" please')).toEqual(["/tmp/my shot.png"]);
	});

	test("keeps a backslash-escaped space, the form a dragged file arrives in", () => {
		expect(extractImagePathCandidates("/Users/me/my\\ shot.png")).toEqual(["/Users/me/my shot.png"]);
	});

	test("an apostrophe in prose does not swallow the path after it", () => {
		// A greedy quoted span would eat "don't ... it's" and the path with it.
		expect(extractImagePathCandidates("don't ship it — /tmp/a.png shows it's broken")).toEqual(["/tmp/a.png"]);
	});

	test("unwraps the file URL some terminals write on drag-and-drop", () => {
		expect(extractImagePathCandidates("file:///tmp/my%20shot.png")).toEqual(["/tmp/my shot.png"]);
	});

	test("unwraps a file URL inside quotes too", () => {
		expect(extractImagePathCandidates('"file:///tmp/my shot.png"')).toEqual(["/tmp/my shot.png"]);
	});

	test("reads a path out of full-width quotes, which is what a CJK keyboard types", () => {
		expect(extractImagePathCandidates("看这个“/tmp/a.png”对不对")).toEqual(["/tmp/a.png"]);
	});

	test("repeats collapse to one attachment", () => {
		expect(extractImagePathCandidates("/tmp/a.png and again /tmp/a.png")).toEqual(["/tmp/a.png"]);
	});

	test("keeps the order the paths were written in", () => {
		expect(extractImagePathCandidates("/tmp/b.webp then /tmp/a.gif")).toEqual(["/tmp/b.webp", "/tmp/a.gif"]);
	});

	test("a bare extension is not a path", () => {
		expect(extractImagePathCandidates("what about .png files?")).toEqual([]);
	});
});

describe("attachedPaths", () => {
	const resolver = (candidate: string) => (candidate.startsWith("/real/") ? candidate : undefined);

	test("keeps only the paths that name a file that exists", () => {
		expect(attachedPaths("/real/a.png and /gone/b.png", "/cwd", resolver)).toEqual(["/real/a.png"]);
	});

	test("two spellings of one file collapse once resolved", () => {
		const toOne = () => "/real/a.png";
		expect(attachedPaths("a.png ./a.png", "/cwd", toOne)).toEqual(["/real/a.png"]);
	});
});

describe("attachmentLabel", () => {
	test("shows the file name, not the temporary directory around it", () => {
		expect(attachmentLabel("/var/folders/xy/pi-question-1234.png")).toBe("pi-question-1234.png");
	});
});

describe("collectImages", () => {
	const shot = join(import.meta.dirname, "public", "single-select.png");
	const other = join(import.meta.dirname, "public", "multi-select.png");
	const notAnImage = join(import.meta.dirname, "README.md");

	test("reads a real image into a provider-ready block", async () => {
		const { blocks, attached, notes } = await collectImages([{ question: "Which?", paths: [shot] }], { vision: true });
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("image");
		expect(blocks[0].mimeType).toBe("image/png");
		expect(blocks[0].data.length).toBeGreaterThan(0);
		expect(attached.map((a) => a.name)).toEqual(["single-select.png"]);
		expect(notes).toEqual([]);
	});

	test("a model with no image input is told in words instead of sent a block it cannot read", async () => {
		const { blocks, notes } = await collectImages([{ question: "Which?", paths: [shot] }], { vision: false });
		expect(blocks).toHaveLength(0);
		expect(notes.join("\n")).toContain("cannot read images");
		expect(notes.join("\n")).toContain("single-select.png");
	});

	test("a file that is not an image is reported by name, and the rest still go", async () => {
		const { blocks, notes } = await collectImages([{ question: "Which?", paths: [notAnImage, shot] }], {
			vision: true,
		});
		expect(blocks).toHaveLength(1);
		expect(notes.join("\n")).toContain("[README.md was not sent: it is not a readable image file.]");
	});

	test("past the cap the extras are named, not silently dropped", async () => {
		const { blocks, notes } = await collectImages([{ question: "Which?", paths: [shot, other] }], {
			vision: true,
			maxImages: 1,
		});
		expect(blocks).toHaveLength(1);
		expect(notes.join("\n")).toContain("Not sent: multi-select.png");
	});

	test("a file that disappeared between the dialog and the read is reported, not thrown", async () => {
		const gone = join(import.meta.dirname, "public", "no-such-file.png");
		const { blocks, notes } = await collectImages([{ question: "Which?", paths: [gone] }], { vision: true });
		expect(blocks).toHaveLength(0);
		expect(notes.join("\n")).toContain("no-such-file.png was not sent");
	});

	test("nothing attached means nothing said", async () => {
		expect(await collectImages([], { vision: true })).toEqual({ blocks: [], attached: [], notes: [] });
	});
});

describe("extensionFromMagic", () => {
	const bytes = (...values: number[]) => new Uint8Array(values);
	const ascii = (text: string, pad = 0) =>
		new Uint8Array([...Array(pad).fill(0), ...[...text].map((c) => c.charCodeAt(0))]);

	test("names a PNG", () => {
		expect(extensionFromMagic(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
	});

	test("names a JPEG", () => {
		expect(extensionFromMagic(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpg");
	});

	test("names a GIF", () => {
		expect(extensionFromMagic(ascii("GIF89a"))).toBe("gif");
	});

	test("names a WEBP by its RIFF container", () => {
		expect(extensionFromMagic(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]))).toBe("webp");
	});

	test("names a BMP", () => {
		expect(extensionFromMagic(ascii("BM"))).toBe("bmp");
	});

	test("falls back to png, which only affects the temporary file name", () => {
		expect(extensionFromMagic(bytes(0x00, 0x01, 0x02))).toBe("png");
	});
});
