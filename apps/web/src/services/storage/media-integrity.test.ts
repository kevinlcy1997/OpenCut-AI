import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { assertMediaReferences, MissingMediaError } from "./media-integrity";
import { StorageService } from "./service";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import { projectAccess } from "./project-access";

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});
function watch<T extends { mockRestore: () => void }>(spy: T): T {
	restores.push(() => spy.mockRestore());
	return spy;
}
const metadata = {
	id: "media",
	name: "original.mp4",
	size: 4,
	type: "video",
	duration: 1,
	lastModified: 0,
};

describe("missing media recovery", () => {
	test("checks references inside nested compounds", () => {
		const scene = [
			{ tracks: [{ elements: [{ children: [{ mediaId: "nested" }] }] }] },
		];
		expect(() => assertMediaReferences(scene, new Set())).toThrow(
			"missing media",
		);
		expect(() =>
			assertMediaReferences(scene, new Set(["nested"])),
		).not.toThrow();
	});
	test("missing originals are reported instead of silently omitted", async () => {
		watch(
			spyOn(IndexedDBAdapter.prototype, "getAll").mockResolvedValue([metadata]),
		);
		watch(spyOn(IndexedDBAdapter.prototype, "get").mockResolvedValue(metadata));
		watch(spyOn(OPFSAdapter.prototype, "get").mockResolvedValue(null));
		const failure = await new StorageService()
			.loadAllMediaAssets({ projectId: "project" })
			.catch((error) => error);
		expect(failure).toBeInstanceOf(MissingMediaError);
		expect(failure.missing[0].name).toBe("original.mp4");
	});
	test("reconnecting requires matching filename and byte count and keeps the media ID", async () => {
		watch(
			spyOn(projectAccess, "write").mockImplementation((_id, operation) =>
				operation(),
			),
		);
		watch(spyOn(IndexedDBAdapter.prototype, "get").mockResolvedValue(metadata));
		const store = watch(
			spyOn(OPFSAdapter.prototype, "set").mockResolvedValue(),
		);
		const service = new StorageService();
		await expect(
			service.reconnectMediaFile({
				projectId: "project",
				id: "media",
				file: new File(["bad"], "wrong.mp4"),
			}),
		).rejects.toThrow("Choose the original");
		expect(store).not.toHaveBeenCalled();
		const original = new File(["data"], "original.mp4");
		await service.reconnectMediaFile({
			projectId: "project",
			id: "media",
			file: original,
		});
		expect(store).toHaveBeenCalledWith("media", original);
	});
});

test("renamed missing media reconnects using the original filename rather than display name", async () => {
	watch(spyOn(projectAccess, "write").mockImplementation((_id, operation) => operation()));
	watch(spyOn(IndexedDBAdapter.prototype, "get").mockResolvedValue({ ...metadata, name: "Interview", originalName: "original.mp4" }));
	const store = watch(spyOn(OPFSAdapter.prototype, "set").mockResolvedValue());
	const service = new StorageService();
	const original = new File(["data"], "original.mp4");
	await service.reconnectMediaFile({ projectId: "project", id: "media", file: original });
	expect(store).toHaveBeenCalledWith("media", original);
	await expect(service.reconnectMediaFile({ projectId: "project", id: "media", file: new File(["data"], "Interview") })).rejects.toThrow("original.mp4");
});
