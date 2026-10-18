import { describe, expect, test } from "bun:test";
import type { ElementAnimations } from "@/types/animation";
import {
	sourceOffsetAt,
	timelineOffsetAt,
	scheduleClipParameter,
} from "./clip-automation";

function channel(
	property: string,
	interpolation: "hold" | "linear" = "linear",
): ElementAnimations {
	return {
		channels: {
			[property]: {
				valueKind: "number",
				keyframes: [
					{ id: "a", time: 0, value: 1, interpolation },
					{ id: "b", time: 2, value: 3, interpolation: "linear" },
				],
			},
		},
	};
}
describe("shared clip automation", () => {
	test("integrates linear speed exactly and inverts it for audio scheduling", () => {
		const animation = channel("playbackRate");
		expect(sourceOffsetAt(1, 1, animation)).toBeCloseTo(1.5, 10);
		expect(sourceOffsetAt(2, 1, animation)).toBeCloseTo(4, 10);
		expect(sourceOffsetAt(3, 1, animation)).toBeCloseTo(7, 10);
		expect(timelineOffsetAt(4, 4, 1, animation)).toBeCloseTo(2, 10);
	});
	test("integrates hold steps without leaking the next key's value backwards", () => {
		const animation = channel("playbackRate", "hold");
		expect(sourceOffsetAt(2, 1, animation)).toBeCloseTo(2, 10);
		expect(sourceOffsetAt(3, 1, animation)).toBeCloseTo(5, 10);
	});
	test("schedules volume from the actual seek value and continues the ramp", () => {
		const events: unknown[] = [];
		const parameter = {
			setValueAtTime: (value: number, time: number) =>
				events.push(["set", value, time]),
			linearRampToValueAtTime: (value: number, time: number) =>
				events.push(["ramp", value, time]),
		} as unknown as AudioParam;
		scheduleClipParameter(parameter, "volume", 1, channel("volume"), 1, 2, 10);
		expect(events).toEqual([
			["set", 2, 10],
			["ramp", 3, 11],
		]);
	});
	test("hold volume jumps at a keyframe instead of fading", () => {
		const events: unknown[] = [];
		const parameter = {
			setValueAtTime: (value: number, time: number) =>
				events.push(["set", value, time]),
			linearRampToValueAtTime: (value: number, time: number) =>
				events.push(["ramp", value, time]),
		} as unknown as AudioParam;
		scheduleClipParameter(
			parameter,
			"volume",
			1,
			channel("volume", "hold"),
			0,
			2,
			5,
		);
		expect(events).toEqual([
			["set", 1, 5],
			["set", 3, 7],
		]);
	});
});
