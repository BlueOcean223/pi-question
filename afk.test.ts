import { describe, expect, test } from "bun:test";
import { AFK_ENV, formatDuration, parseAfkTimeout } from "./afk.js";

describe("parseAfkTimeout", () => {
	test("unset waits for the person", () => {
		expect(parseAfkTimeout(undefined)).toEqual({});
		expect(parseAfkTimeout("")).toEqual({});
		expect(parseAfkTimeout("  ")).toEqual({});
	});

	test("explicit off values wait for the person", () => {
		for (const raw of ["never", "off", "0", "NEVER", "0s", "0m"]) {
			expect(parseAfkTimeout(raw)).toEqual({});
		}
	});

	test("durations with a unit", () => {
		expect(parseAfkTimeout("90s")).toEqual({ timeoutMs: 90_000 });
		expect(parseAfkTimeout("5m")).toEqual({ timeoutMs: 300_000 });
		expect(parseAfkTimeout("1h")).toEqual({ timeoutMs: 3_600_000 });
		expect(parseAfkTimeout(" 1.5M ")).toEqual({ timeoutMs: 90_000 });
	});

	test("a bare number is rejected rather than guessed at", () => {
		const { timeoutMs, error } = parseAfkTimeout("300");
		expect(timeoutMs).toBeUndefined();
		expect(error).toBe(`${AFK_ENV}="300" is not a duration like 90s, 5m or 1h; questions will wait for an answer.`);
	});

	test("garbage is rejected and leaves the dialog waiting", () => {
		for (const raw of ["-5m", "5 min", "abc", "5d"]) {
			const result = parseAfkTimeout(raw);
			expect(result.timeoutMs).toBeUndefined();
			expect(result.error).toContain(`"${raw}"`);
		}
	});
});

describe("formatDuration", () => {
	test("uses the largest unit that divides evenly", () => {
		expect(formatDuration(3_600_000)).toBe("1 hour");
		expect(formatDuration(7_200_000)).toBe("2 hours");
		expect(formatDuration(300_000)).toBe("5 minutes");
		expect(formatDuration(60_000)).toBe("1 minute");
		expect(formatDuration(90_000)).toBe("90 seconds");
		expect(formatDuration(5_400_000)).toBe("90 minutes");
	});

	test("never says zero", () => {
		expect(formatDuration(1)).toBe("1 second");
	});
});
