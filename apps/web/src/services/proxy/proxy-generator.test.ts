import { expect, test, spyOn } from "bun:test";
import { Input } from "mediabunny";
import { generateProxy } from "./proxy-generator";

test("pre-cancelled proxy jobs reject before opening media or creating a canvas", async () => {
	const controller = new AbortController();
	controller.abort();
	// An invalid file would otherwise enter format detection and reject differently.
	let progressCalled = false;
	try {
		await generateProxy({
			file: new File(["invalid media"], "bad.mp4"),
			resolution: "720p",
			signal: controller.signal,
			onProgress: () => {
				progressCalled = true;
			},
		});
		throw new Error("unexpected success");
	} catch (error) {
		expect((error as Error).name).toBe("AbortError");
		expect((error as Error).message).toContain("Proxy generation cancelled");
	}
	expect(progressCalled).toBe(false);
});

test("abort disposes a decoder input even while metadata is pending", async () => {
	const controller = new AbortController();
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let finish!: (value: null) => void;
	const metadata = new Promise<null>((resolve) => {
		finish = resolve;
	});
	const reading = spyOn(
		Input.prototype,
		"getPrimaryVideoTrack",
	).mockImplementation(() => {
		entered();
		return metadata;
	});
	const disposing = spyOn(Input.prototype, "dispose");
	try {
		const pending = generateProxy({
			file: new File(["fixture"], "test.mp4"),
			resolution: "720p",
			signal: controller.signal,
		}).catch((error: Error) => error);
		await started;
		controller.abort();
		expect(disposing).toHaveBeenCalled();
		finish(null);
		const result = await pending;
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).name).toBe("AbortError");
	} finally {
		finish(null);
		reading.mockRestore();
		disposing.mockRestore();
	}
});
