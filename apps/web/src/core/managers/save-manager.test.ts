import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { SaveManager } from "./save-manager";

function harness(write: () => Promise<void>, debounceMs = 60_000) {
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "project" } }),
			getIsLoading: () => false,
			getMigrationState: () => ({ isMigrating: false }),
			saveCurrentProject: write,
		},
	} as unknown as EditorCore;
	return new SaveManager(editor, { debounceMs });
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("durable autosave", () => {
	test("failed writes stay dirty and explicit retry clears the error", async () => {
		let fail = true;
		const save = harness(async () => {
			if (fail) throw new Error("Storage full");
		});
		await expect(save.flush()).rejects.toThrow("Storage full");
		expect(save.getIsDirty()).toBe(true);
		expect(save.getLastSavedAt()).toBeNull();
		expect(save.getLastError()).toBe("Storage full");
		fail = false;
		await save.flush();
		expect(save.getIsDirty()).toBe(false);
		expect(save.getLastError()).toBeNull();
		expect(save.getLastSavedAt()).not.toBeNull();
		save.stop();
	});
	test("flush waits for an active write and saves edits made during it", async () => {
		const first = deferred();
		const second = deferred();
		let writes = 0;
		const save = harness(() =>
			++writes === 1 ? first.promise : second.promise,
		);
		let complete = false;
		const flushing = save.flush().then(() => {
			complete = true;
		});
		save.markDirty();
		const otherFlush = save.flush();
		expect(writes).toBe(1);
		expect(complete).toBe(false);
		first.resolve();
		await new Promise((done) => setTimeout(done, 0));
		expect(writes).toBe(2);
		expect(complete).toBe(false);
		second.resolve();
		await Promise.all([flushing, otherFlush]);
		expect(save.getIsDirty()).toBe(false);
		save.stop();
	});
	test("background failure is visible without an unhandled rejection or retry loop", async () => {
		let writes = 0;
		const save = harness(async () => {
			writes++;
			throw new Error("Disk unavailable");
		}, 1);
		save.markDirty();
		await new Promise((done) => setTimeout(done, 20));
		expect(writes).toBe(1);
		expect(save.getIsDirty()).toBe(true);
		expect(save.getLastError()).toBe("Disk unavailable");
		save.stop();
	});
});

test("pause stops an already queued autosave until resume", async () => {
	let writes = 0;
	const save = harness(async () => {
		writes++;
	}, 1);
	save.markDirty();
	save.pause();
	await new Promise((done) => setTimeout(done, 10));
	expect(writes).toBe(0);
	expect(save.getIsDirty()).toBe(true);
	save.resume();
	await new Promise((done) => setTimeout(done, 10));
	expect(writes).toBe(1);
	save.stop();
});

test("suspend drains the current write and reset discards queued work", async () => {
	const pending = deferred();
	let writes = 0;
	const save = harness(async () => {
		writes++;
		await pending.promise;
	}, 1);
	save.markDirty();
	await new Promise((done) => setTimeout(done, 5));
	save.markDirty();
	let suspended = false;
	const suspension = save.suspend().then((resume) => {
		suspended = true;
		return resume;
	});
	await Promise.resolve();
	expect(suspended).toBe(false);
	pending.resolve();
	const resume = await suspension;
	save.reset();
	resume();
	await new Promise((done) => setTimeout(done, 10));
	expect(writes).toBe(1);
	expect(save.getIsDirty()).toBe(false);
	save.stop();
});

test("a concurrent suspension rejects flush instead of looping on queued edits", async () => {
	const pending = deferred();
	const save = harness(() => pending.promise);
	const flushing = save.flush().catch((error: Error) => error);
	save.markDirty();
	const suspension = save.suspend();
	pending.resolve();
	const resume = await suspension;
	expect(((await flushing) as Error).message).toContain("paused");
	save.reset();
	resume();
	save.stop();
});
