import { describe, expect, test } from "bun:test";
import { collectAudioElements, collectAudioClips } from "./audio";
import type { TimelineTrack } from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";

const asset: MediaAsset = {
	id: "media",
	name: "tone.wav",
	type: "audio",
	file: new File(["audio"], "tone.wav"),
};
function tracks(): TimelineTrack[] {
	return [
		{
			id: "track",
			type: "audio",
			muted: false,
			elements: [
				{
					id: "left",
					type: "audio",
					sourceType: "upload",
					mediaId: "media",
					startTime: 0,
					duration: 1,
					trimStart: 0,
					trimEnd: 1,
					volume: 0.25,
					playbackRate: 2,
				},
				{
					id: "right",
					type: "audio",
					sourceType: "upload",
					mediaId: "media",
					startTime: 1,
					duration: 1,
					trimStart: 2,
					trimEnd: 0,
					volume: 0.5,
					playbackRate: 2,
				},
			],
		},
	] as TimelineTrack[];
}

describe("timeline audio collection", () => {
	test("decodes a split source once and retains each clip's gain and speed", async () => {
		let decodes = 0;
		const context = {
			decodeAudioData: async () => {
				decodes++;
				return {} as AudioBuffer;
			},
		} as unknown as AudioContext;
		const clips = await collectAudioElements({
			tracks: tracks(),
			mediaAssets: [asset],
			audioContext: context,
			strict: true,
		});
		expect(decodes).toBe(1);
		expect(
			clips.map((clip) => [
				clip.trackId,
				clip.trimStart,
				clip.volume,
				clip.playbackRate,
			]),
		).toEqual([
			["track", 0, 0.25, 2],
			["track", 2, 0.5, 2],
		]);
		const preview = await collectAudioClips({
			tracks: tracks(),
			mediaAssets: [asset],
		});
		expect(preview.map((clip) => clip.playbackRate)).toEqual([2, 2]);
	});
	test("export fails clearly on undecodable audio instead of silently dropping it", async () => {
		const context = {
			decodeAudioData: async () => {
				throw new Error("Unsupported audio codec");
			},
		} as unknown as AudioContext;
		await expect(
			collectAudioElements({
				tracks: tracks(),
				mediaAssets: [asset],
				audioContext: context,
				strict: true,
			}),
		).rejects.toThrow("Unsupported audio codec");
	});
	test("muted audio is not fetched or decoded", async () => {
		const muted = tracks();
		if (muted[0].type === "audio") muted[0].muted = true;
		const clips = await collectAudioElements({
			tracks: muted,
			mediaAssets: [],
			audioContext: {} as AudioContext,
			strict: true,
		});
		expect(clips).toEqual([]);
	});
});

test("pre-cancelled collection does not decode any originals", async () => {
	let decodes = 0;
	const context = {
		decodeAudioData: async () => {
			decodes++;
			return {} as AudioBuffer;
		},
	} as unknown as AudioContext;
	await expect(
		collectAudioElements({
			tracks: tracks(),
			mediaAssets: [asset],
			audioContext: context,
			strict: true,
			shouldCancel: () => true,
		}),
	).rejects.toThrow("cancelled");
	expect(decodes).toBe(0);
});

test("cancel during an uninterruptible browser decode is checked before accepting its result", async () => {
	let cancelled = false;
	const context = {
		decodeAudioData: async () => {
			cancelled = true;
			return {} as AudioBuffer;
		},
	} as unknown as AudioContext;
	await expect(
		collectAudioElements({
			tracks: tracks(),
			mediaAssets: [asset],
			audioContext: context,
			strict: true,
			shouldCancel: () => cancelled,
		}),
	).rejects.toThrow("cancelled");
});
