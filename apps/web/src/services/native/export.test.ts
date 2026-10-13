import { describe, expect, test } from "bun:test";
import { RootNode } from "../renderer/nodes/root-node";
import { VideoNode } from "../renderer/nodes/video-node";
import { ColorNode } from "../renderer/nodes/color-node";
import { eligibleNativeClips } from "./export";

function video(timeOffset = 0): VideoNode {
	return new VideoNode({
		file: new File([], "fixture.mp4"),
		mediaId: "test",
		url: "blob:test",
		duration: 1,
		timeOffset,
		trimStart: 0,
		trimEnd: 0,
		opacity: 1,
		transform: { scale: 1, rotate: 0, position: { x: 0, y: 0 } },
	});
}

describe("native export parity eligibility", () => {
	test("accepts contiguous cuts", () => {
		const root = new RootNode({ duration: 2 }).add(video()).add(video(1));
		expect(eligibleNativeClips(root, 30)?.length).toBe(2);
	});
	test("rejects gaps, overlaps and speed changes", () => {
		for (const offset of [0.5, 1.5])
			expect(
				eligibleNativeClips(
					new RootNode({ duration: 2 }).add(video()).add(video(offset)),
					30,
				),
			).toBeNull();
		const clip = video();
		clip.params.playbackRate = 2;
		expect(
			eligibleNativeClips(new RootNode({ duration: 1 }).add(clip), 30),
		).toBeNull();
	});
	test("rejects non-default transforms and overlays", () => {
		const clip = video();
		clip.params.transform.scale = 1.1;
		expect(
			eligibleNativeClips(new RootNode({ duration: 1 }).add(clip), 30),
		).toBeNull();
		expect(
			eligibleNativeClips(
				new RootNode({ duration: 1 })
					.add(video())
					.add(new ColorNode({ color: "black" })),
				30,
			),
		).toBeNull();
	});
	test("accepts black background but rejects other colors", () => {
		for (const color of ["black", "#000000"])
			expect(
				eligibleNativeClips(
					new RootNode({ duration: 1 })
						.add(new ColorNode({ color }))
						.add(video()),
					30,
				)?.length,
			).toBe(1);
		expect(
			eligibleNativeClips(
				new RootNode({ duration: 1 })
					.add(new ColorNode({ color: "white" }))
					.add(video()),
				30,
			),
		).toBeNull();
	});
});
