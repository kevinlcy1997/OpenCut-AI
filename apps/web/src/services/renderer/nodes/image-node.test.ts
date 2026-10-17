import { expect, spyOn, test } from "bun:test";
import { ImageNode, type ImageNodeParams } from "./image-node";
import { clearImageSourceCache } from "../image-source-cache";
import type { CanvasRenderer } from "../canvas-renderer";

test("image nodes load only in range, share sources, and reload after cache release", async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
	let loads = 0;
	class FixtureImage {
		naturalWidth = 320;
		naturalHeight = 180;
		onload?: () => void;
		onerror?: () => void;
		set src(_value: string) {
			loads++;
			queueMicrotask(() => this.onload?.());
		}
	}
	Object.defineProperty(globalThis, "Image", {
		value: FixtureImage,
		configurable: true,
	});
	clearImageSourceCache();
	const params: ImageNodeParams = {
		url: "fixture-image",
		duration: 2,
		timeOffset: 2,
		trimStart: 0,
		trimEnd: 0,
		opacity: 1,
		transform: { scale: 1, rotate: 0, position: { x: 0, y: 0 } },
	};
	const first = new ImageNode(params),
		second = new ImageNode(params);
	const drawFirst = spyOn(
		first as unknown as { renderVisual(options: unknown): void },
		"renderVisual",
	).mockImplementation(() => {});
	const drawSecond = spyOn(
		second as unknown as { renderVisual(options: unknown): void },
		"renderVisual",
	).mockImplementation(() => {});
	try {
		expect(loads).toBe(0);
		await first.render({ renderer: {} as CanvasRenderer, time: 1 });
		expect(loads).toBe(0);
		expect(drawFirst).not.toHaveBeenCalled();
		await Promise.all([
			first.render({ renderer: {} as CanvasRenderer, time: 2 }),
			second.render({ renderer: {} as CanvasRenderer, time: 2 }),
		]);
		expect(loads).toBe(1);
		expect(drawFirst).toHaveBeenCalledTimes(1);
		expect(drawSecond).toHaveBeenCalledTimes(1);
		clearImageSourceCache();
		await first.render({ renderer: {} as CanvasRenderer, time: 2 });
		expect(loads).toBe(2);
	} finally {
		drawFirst.mockRestore();
		drawSecond.mockRestore();
		clearImageSourceCache();
		if (original) Object.defineProperty(globalThis, "Image", original);
		else Reflect.deleteProperty(globalThis, "Image");
	}
});
