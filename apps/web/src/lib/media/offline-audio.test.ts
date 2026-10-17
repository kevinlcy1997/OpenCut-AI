import { describe, expect, test } from "bun:test";
import {
	audioSourceTime,
	audioTimelineTime,
	renderTimelineAudio,
	type DecodedTimelineAudio,
} from "./offline-audio";
import type { TimelineTrack } from "@/types/timeline";

function parameter(initial: number) {
	return {
		value: initial,
		setValueAtTime(value: number) {
			this.value = value;
		},
		linearRampToValueAtTime(value: number) {
			this.value = value;
		},
	};
}
function graph() {
	const gains: any[] = [],
		panners: any[] = [],
		sources: any[] = [];
	const context = {
		destination: {},
		createGain: () => {
			const node = { gain: parameter(1), connect: () => {} };
			gains.push(node);
			return node;
		},
		createStereoPanner: () => {
			const node = { pan: { value: 0 }, connect: () => {} };
			panners.push(node);
			return node;
		},
		createBufferSource: () => {
			const node = {
				buffer: null,
				playbackRate: parameter(1),
				start: (...args: number[]) => {
					node.started = args;
				},
				stop: (time: number) => {
					node.stopped = time;
				},
				started: [] as number[],
				stopped: 0,
				connect: () => {},
			};
			sources.push(node);
			return node;
		},
		startRendering: async () => ({ length: 48000 }),
	} as unknown as OfflineAudioContext;
	return { context, gains, panners, sources };
}
const track = {
	id: "audio",
	name: "Audio",
	type: "audio",
	muted: false,
	volume: 0.5,
	pan: -1,
	elements: [],
} as TimelineTrack;
const clip: DecodedTimelineAudio = {
	buffer: {} as AudioBuffer,
	trackId: "audio",
	startTime: 2,
	duration: 3,
	trimStart: 1,
	trimEnd: 0,
	playbackRate: 2,
	volume: 0.25,
};

describe("audio export graph", () => {
	test("applies clip/track gain, pan, source trim, speed and timeline stop", async () => {
		const fake = graph();
		await renderTimelineAudio({
			clips: [clip],
			tracks: [track],
			duration: 8,
			sampleRate: 48000,
			createContext: () => fake.context,
		});
		expect(fake.gains.map((gain) => gain.gain.value)).toEqual([0.5, 0.25]);
		expect(fake.panners[0].pan.value).toBe(-1);
		expect(fake.sources[0].playbackRate.value).toBe(2);
		expect(fake.sources[0].started).toEqual([2, 1]);
		expect(fake.sources[0].stopped).toBe(5);
	});
	test("solo silences other tracks and mute remains effective", async () => {
		const fake = graph();
		const tracks = [track, { ...track, id: "solo", solo: true, muted: true }];
		await renderTimelineAudio({
			clips: [clip],
			tracks,
			duration: 8,
			sampleRate: 48000,
			createContext: () => fake.context,
		});
		expect(fake.gains[0].gain.value).toBe(0);
		expect(fake.gains[1].gain.value).toBe(0);
	});
	test("muted clips are not scheduled and invalid playback rates fail", async () => {
		const fake = graph();
		await renderTimelineAudio({
			clips: [{ ...clip, muted: true }],
			tracks: [track],
			duration: 8,
			sampleRate: 48000,
			createContext: () => fake.context,
		});
		expect(fake.sources.length).toBe(0);
		await expect(
			renderTimelineAudio({
				clips: [{ ...clip, playbackRate: 0 }],
				tracks: [track],
				duration: 8,
				sampleRate: 48000,
				createContext: () => fake.context,
			}),
		).rejects.toThrow("speed");
	});
	test("preview speed conversion round trips cuts and nonzero seek positions", () => {
		expect(audioSourceTime(7, 3, 5, 2)).toBe(7);
		expect(audioTimelineTime(7, 3, 5, 2)).toBe(7);
		expect(audioSourceTime(7, 3, 5, 0.5)).toBe(4);
		expect(audioTimelineTime(4, 3, 5, 0.5)).toBe(7);
	});
});
