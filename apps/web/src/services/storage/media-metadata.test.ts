import { expect, spyOn, test } from "bun:test";
import { storageService } from "./service";
import { projectAccess } from "./project-access";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";

test("metadata-only edits preserve unrelated metadata without rewriting originals", async () => {
	const lease = spyOn(projectAccess, "write").mockImplementation(
		async (_id, operation) => operation(),
	);
	const originalWrite = spyOn(OPFSAdapter.prototype, "set");
	let saved: unknown;
	const update = spyOn(IndexedDBAdapter.prototype, "update").mockImplementation(
		async (_id, change) => {
			saved = change({
				id: "asset",
				name: "original.mp4",
				proxy: { resolution: "720p" },
				size: 123,
			});
			return saved;
		},
	);
	try {
		expect(
			await storageService.updateMediaMetadata({
				projectId: "project",
				id: "asset",
				updates: { label: "Scene A" },
			}),
		).toEqual({ name: "original.mp4", label: "Scene A" });
		expect(saved).toEqual({
			id: "asset",
			name: "original.mp4",
			label: "Scene A",
			proxy: { resolution: "720p" },
			size: 123,
		});
		expect(originalWrite).not.toHaveBeenCalled();
	} finally {
		lease.mockRestore();
		originalWrite.mockRestore();
		update.mockRestore();
	}
});

test("reloaded media retains its stored label and source frame rate", async () => {
	const file = new File(["original bytes"], "original.mp4", {
		type: "video/mp4",
	});
	const reading = spyOn(OPFSAdapter.prototype, "get").mockResolvedValue(file);
	const metadata = spyOn(IndexedDBAdapter.prototype, "get").mockResolvedValue({
		id: "asset",
		name: file.name,
		type: "video",
		label: "Scene A",
		fps: 30000 / 1001,
		size: file.size,
	});
	let url: string | undefined;
	try {
		const loaded = await storageService.loadMediaAsset({
			projectId: "project",
			id: "asset",
		});
		url = loaded?.url;
		expect(loaded?.label).toBe("Scene A");
		expect(loaded?.fps).toBe(30000 / 1001);
		expect(await loaded?.file.text()).toBe("original bytes");
	} finally {
		if (url) URL.revokeObjectURL(url);
		reading.mockRestore();
		metadata.mockRestore();
	}
});
