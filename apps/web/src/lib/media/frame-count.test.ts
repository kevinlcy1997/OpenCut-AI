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
test("invalid timing fails before entering an encoder loop", () => {
	for (const [duration, fps] of [
		[NaN, 30],
		[Infinity, 30],
		[-1, 30],
		[1, 0],
		[1, -30],
		[1, NaN],
		[1, Infinity],
		[Number.MAX_VALUE, 60],
	])
		expect(() => frameCountForDuration(duration, fps)).toThrow();
});
