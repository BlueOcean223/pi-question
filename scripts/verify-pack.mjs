/**
 * Gate between `npm publish` and the registry.
 *
 * The tarball is an allowlist (`files` in package.json), which fails in two
 * opposite directions and neither one is visible at publish time:
 *
 * - Too much: `pro-ref/` is 169MB of vendored reference source. It is only
 *   kept out today because npm falls back to `.gitignore` when there is no
 *   `.npmignore` — an implicit rule that stops applying the moment someone
 *   adds one.
 * - Too little: a new module that nobody added to `files` publishes fine and
 *   then throws ERR_MODULE_NOT_FOUND on the user's first call.
 *
 * So this asks npm what it would actually ship, and checks both directions
 * against the source rather than against a second hand-maintained list.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Paths that must never reach the registry, matched as path prefixes. */
const FORBIDDEN = ["pro-ref/", ".agent/", "node_modules/", "public/", ".git/"];
/** A source-only package has no business shipping anything this big. */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024;

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function packReport() {
	try {
		// The default 1MB buffer overflows on a manifest listing a vendored tree,
		// which is precisely the case this script exists to name. Without the
		// bigger buffer it dies on ENOBUFS and reports nothing useful.
		return JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))[0];
	} catch (err) {
		if (err.code === "ENOBUFS") {
			console.error("verify-pack: the pack manifest is too large to even read — files[] is pulling in a whole tree.");
			process.exit(1);
		}
		throw err;
	}
}

const report = packReport();
const shipped = new Set(report.files.map((f) => f.path));
const failures = [];

for (const { path, size } of report.files) {
	if (FORBIDDEN.some((dir) => path.startsWith(dir))) failures.push(`ships a forbidden path: ${path}`);
	if (size > MAX_FILE_BYTES) failures.push(`${path} is ${(size / 1024).toFixed(0)}kB, over the ${MAX_FILE_BYTES / 1024}kB cap`);
}
if (report.unpackedSize > MAX_UNPACKED_BYTES) {
	failures.push(`unpacked size is ${(report.unpackedSize / 1024).toFixed(0)}kB, over the ${MAX_UNPACKED_BYTES / 1024}kB cap`);
}

// Walk the import graph from the declared entry points. Reaching a module the
// tarball does not carry is the "forgot to add it to files" bug.
const entries = (pkg.pi?.extensions ?? []).map((p) => p.replace(/^\.\//, ""));
if (entries.length === 0) failures.push("package.json has no pi.extensions entry point");

const seen = new Set();
const queue = [...entries];
while (queue.length > 0) {
	const file = queue.shift();
	if (seen.has(file)) continue;
	seen.add(file);
	if (!shipped.has(file)) {
		failures.push(`${file} is imported but missing from files[] in package.json`);
		continue;
	}
	for (const [, target] of readFileSync(file, "utf8").matchAll(/from "\.\/([\w.-]+)\.js"/g)) {
		queue.push(`${target}.ts`);
	}
}

// Anything pi bundles must be a peer dependency, never bundled or vendored.
const PI_PROVIDED = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
for (const dep of PI_PROVIDED) {
	if (pkg.dependencies?.[dep]) failures.push(`${dep} is a dependency; pi provides it, so it belongs in peerDependencies`);
}

if (failures.length > 0) {
	// One stray directory is thousands of failures; the first handful already
	// says which directory it is.
	const shown = failures.slice(0, 15);
	console.error(`verify-pack: ${failures.length} problem(s) with the tarball\n`);
	for (const line of shown) console.error(`  - ${line}`);
	if (failures.length > shown.length) console.error(`  ... and ${failures.length - shown.length} more`);
	process.exit(1);
}

console.log(
	`verify-pack: ${report.entryCount} files, ${(report.size / 1024).toFixed(1)}kB packed, ` +
		`${(report.unpackedSize / 1024).toFixed(1)}kB unpacked — reachable from ${entries.join(", ")}`,
);
