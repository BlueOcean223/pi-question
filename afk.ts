/**
 * Idle auto-continue, off unless the user turns it on.
 *
 * A question waits for its answer by default. The failure people actually hit
 * is walking away from a long task and coming back to find the agent went
 * ahead on a guess — Claude Code shipped a default 60s timeout and reverted it
 * to opt-in for exactly that reason. Unattended runs that would rather keep
 * moving set `PI_QUESTION_AFK_TIMEOUT`.
 */

export const AFK_ENV = "PI_QUESTION_AFK_TIMEOUT";

/** Tail of the idle window during which the hint row shows a countdown. */
export const AFK_COUNTDOWN_MS = 20 * 1000;

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 } as const;

export interface AfkSetting {
	/** Idle time before the dialog submits what is selected; absent means wait. */
	timeoutMs?: number;
	/** Why the configured value was ignored, for a one-time warning. */
	error?: string;
}

/**
 * Reads the env value. A unit is required: a bare number is rejected rather
 * than guessed at, because reading `300` as 300ms or `5m` as 5ms is the kind of
 * mistake that fires the timeout the moment the dialog opens.
 */
export function parseAfkTimeout(raw: string | undefined): AfkSetting {
	const value = raw?.trim().toLowerCase() ?? "";
	if (value === "" || value === "never" || value === "off" || value === "0") return {};
	const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(value);
	if (!match) {
		return {
			error: `${AFK_ENV}="${raw}" is not a duration like 90s, 5m or 1h; questions will wait for an answer.`,
		};
	}
	const ms = Math.round(Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]);
	return ms > 0 ? { timeoutMs: ms } : {};
}

function plural(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** `5 minutes`, `90 seconds`, `1 hour` — the largest unit that divides evenly. */
export function formatDuration(ms: number): string {
	if (ms >= UNIT_MS.h && ms % UNIT_MS.h === 0) return plural(ms / UNIT_MS.h, "hour");
	if (ms >= UNIT_MS.m && ms % UNIT_MS.m === 0) return plural(ms / UNIT_MS.m, "minute");
	return plural(Math.max(1, Math.round(ms / UNIT_MS.s)), "second");
}
