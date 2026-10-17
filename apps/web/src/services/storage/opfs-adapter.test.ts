import { afterEach, expect, spyOn, test } from "bun:test";
import { OPFSAdapter } from "./opfs-adapter";

const restore: Array<() => void> = [];
afterEach(() => {
	for (const undo of restore.splice(0)) undo();
});
function fixture(failure?: "write" | "close" | "abort") {
	const adapter = new OPFSAdapter("test-originals");
	const events: string[] = [];
	let original = new File(["existing original"], "original.mp4");
	let staged: File | null = null;
	const stream = {
		write: async (file: File) => {
			events.push("write");
			staged = file;
			if (failure === "write" || failure === "abort")
				throw new Error("quota exceeded");
		},
		close: async () => {
			events.push("close");
			if (failure === "close") throw new Error("commit failed");
			original = staged!;
			staged = null;
		},
		abort: async () => {
			events.push("abort");
			if (failure === "abort") throw new Error("abort failed");
			staged = null;
		},
	};
	const directory = {
		getFileHandle: async () => ({ createWritable: async () => stream }),
		removeEntry: async () => {
			throw new Error("must not delete original");
		},
	} as unknown as FileSystemDirectoryHandle;
	const directorySpy = spyOn(
		adapter as unknown as {
			getDirectory(): Promise<FileSystemDirectoryHandle>;
		},
		"getDirectory",
	).mockResolvedValue(directory);
	restore.push(() => directorySpy.mockRestore());
	return { adapter, events, original: () => original, staged: () => staged };
}

test("an original write commits only through close", async () => {
	const f = fixture();
	const replacement = new File(["replacement"], "replacement.mp4");
	await f.adapter.set("media-id", replacement);
	expect(f.events).toEqual(["write", "close"]);
	expect(f.original()).toBe(replacement);
});
for (const failure of ["write", "close"] as const) {
	test(`a failed ${failure} aborts staged bytes without deleting the existing original`, async () => {
		const f = fixture(failure);
		await expect(
			f.adapter.set("media-id", new File(["replacement"], "replacement.mp4")),
		).rejects.toThrow(failure === "write" ? "quota exceeded" : "commit failed");
		expect(f.events.at(-1)).toBe("abort");
		expect(f.staged()).toBeNull();
		expect(await f.original().text()).toBe("existing original");
	});
}
test("abort failure preserves both errors for recovery diagnostics", async () => {
	const f = fixture("abort");
	try {
		await f.adapter.set(
			"media-id",
			new File(["replacement"], "replacement.mp4"),
		);
		throw new Error("unexpected success");
	} catch (error) {
		expect(error).toBeInstanceOf(AggregateError);
		expect(
			(error as AggregateError).errors.map((e: Error) => e.message),
		).toEqual(["quota exceeded", "abort failed"]);
	}
	expect(await f.original().text()).toBe("existing original");
});
