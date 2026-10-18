import { afterEach, expect, spyOn, test } from "bun:test";
import {
	checkExportCancellation,
	fetchAudioBytes,
} from "./export-cancellation";
let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
});

test("pre-cancelled audio requests never start a fetch", async () => {
	const fetcher = spyOn(globalThis, "fetch");
	restore = () => fetcher.mockRestore();
	await expect(
		fetchAudioBytes("https://example.invalid/audio", () => true),
	).rejects.toThrow("cancelled");
	expect(fetcher).not.toHaveBeenCalled();
});
test("cancellation aborts an in-flight library download", async () => {
	let cancelled = false;
	let aborted = false;
	const fetcher = spyOn(globalThis, "fetch").mockImplementation(
		((_input: RequestInfo | URL, options?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new DOMException("Cancelled", "AbortError"));
				});
			})) as typeof fetch,
	);
	restore = () => fetcher.mockRestore();
	const pending = fetchAudioBytes(
		"https://example.invalid/audio",
		() => cancelled,
	).catch((error: Error) => error);
	cancelled = true;
	const error = await pending;
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).name).toBe("AbortError");
	expect(aborted).toBe(true);
});
test("cancellation checkpoint identifies an abort", () => {
	try {
		checkExportCancellation(() => true);
		throw new Error("Expected cancellation");
	} catch (error) {
		expect((error as Error).name).toBe("AbortError");
	}
});
