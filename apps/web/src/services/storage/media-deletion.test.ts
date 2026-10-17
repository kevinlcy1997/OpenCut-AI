import { afterEach, expect, spyOn, test } from "bun:test";
import { storageService } from "./service";
import { projectAccess } from "./project-access";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
const restore: Array<() => void> = [];
afterEach(() => {
	for (const undo of restore.splice(0)) undo();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
for (const kind of ["project", "asset"] as const) {
	for (const failedStore of ["metadata", "files"] as const) {
		test(`${kind} deletion keeps its lease while the other store finishes after ${failedStore} fails`, async () => {
			const pending = deferred();
			let held = false;
			const lease = spyOn(projectAccess, "write").mockImplementation(
				async (_id, operation) => {
					held = true;
					try {
						return await operation();
					} finally {
						held = false;
					}
				},
			);
			const failure = new Error(`${failedStore} unavailable`);
			const metadata = spyOn(
				IndexedDBAdapter.prototype,
				kind === "project" ? "clear" : "remove",
			).mockImplementation(() =>
				failedStore === "metadata" ? Promise.reject(failure) : pending.promise,
			);
			const files = spyOn(
				OPFSAdapter.prototype,
				kind === "project" ? "clear" : "remove",
			).mockImplementation(() =>
				failedStore === "files" ? Promise.reject(failure) : pending.promise,
			);
			restore.push(
				() => lease.mockRestore(),
				() => metadata.mockRestore(),
				() => files.mockRestore(),
			);
			let settled = false;
			const deletion = (
				kind === "project"
					? storageService.deleteProjectMedia({ projectId: "fixture" })
					: storageService.deleteMediaAsset({
							projectId: "fixture",
							id: "asset",
						})
			)
				.catch((error: Error) => error)
				.finally(() => {
					settled = true;
				});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(held).toBe(true);
			expect(settled).toBe(false);
			pending.resolve();
			const result = await deletion;
			expect(held).toBe(false);
			expect(result).toBeInstanceOf(AggregateError);
			expect((result as AggregateError).errors).toEqual([failure]);
		});
	}
}

test("media deletion reports failures from both stores", async () => {
	const lease = spyOn(projectAccess, "write").mockImplementation(
		async (_id, operation) => operation(),
	);
	const first = new Error("metadata unavailable"),
		second = new Error("files unavailable");
	const metadata = spyOn(IndexedDBAdapter.prototype, "clear").mockRejectedValue(
		first,
	);
	const files = spyOn(OPFSAdapter.prototype, "clear").mockRejectedValue(second);
	restore.push(
		() => lease.mockRestore(),
		() => metadata.mockRestore(),
		() => files.mockRestore(),
	);
	try {
		await storageService.deleteProjectMedia({ projectId: "fixture" });
		throw new Error("unexpected success");
	} catch (error) {
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([first, second]);
	}
});
