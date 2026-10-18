import { expect, test } from "bun:test";
import { frameCountForDuration } from "./frame-count";

test("frame-aligned durations do not gain a frame through floating-point roundoff", () => {
	const mismatches: unknown[] = [];
	for (const fps of [
		24,
		25,
		30,
		60,
		24000 / 1001,
		30000 / 1001,
		60000 / 1001,
	]) {
		for (let frames = 1; frames < 10000; frames++) {
			const actual = frameCountForDuration(frames / fps, fps);
			if (actual !== frames) mismatches.push({ fps, frames, actual });
		}
	}
	expect(mismatches).toEqual([]);
});
test("a real partial frame is retained rather than rounded down", () => {
	expect(frameCountForDuration(1.001, 30)).toBe(31);
	expect(frameCountForDuration((31 + 0.000001) / 30, 30)).toBe(32);
	expect(frameCountForDuration((31 - 0.000001) / 30, 30)).toBe(31);
	expect(frameCountForDuration(0, 30)).toBe(0);
	expect(frameCountForDuration(Number.MIN_VALUE, 30)).toBe(1);
});
test.each([
	["NaN duration", NaN, 30],
	["infinite duration", Infinity, 30],
	["negative duration", -1, 30],
	["zero fps", 1, 0],
	["negative fps", 1, -30],
	["NaN fps", 1, NaN],
	["infinite fps", 1, Infinity],
	["multiplication overflow", Number.MAX_VALUE, 60],
	["unsafe finite frame count", Number.MAX_SAFE_INTEGER, 2],
] as const)("invalid timing fails before encoding: %s", (_label, duration, fps) => {
	expect(() => frameCountForDuration(duration, fps)).toThrow();
});
