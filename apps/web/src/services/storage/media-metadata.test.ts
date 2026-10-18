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
			originalName: "original.mp4",
			mimeType: "video/mp4",
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

test("renamed media reloads using original filename and MIME rather than display name", async () => {
	const source = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
	const storedFile = new File([source], "opaque-id");
	// Bun 1.2 copies a previously read native File.name into cloned Files.
	// An own property models the OPFS name without populating that runtime cache.
	Object.defineProperty(storedFile, "name", { value: "opaque-id" });
	const reading = spyOn(OPFSAdapter.prototype, "get").mockResolvedValue(storedFile);
	const metadata = spyOn(IndexedDBAdapter.prototype, "get").mockResolvedValue({
		id: "asset", name: "Opening card", originalName: "camera.svg", mimeType: "image/svg+xml", type: "image", size: source.length, lastModified: 123,
	});
	let url: string | undefined;
	try {
		const loaded = await storageService.loadMediaAsset({ projectId: "project", id: "asset" });
		url = loaded?.url;
		expect(loaded?.name).toBe("Opening card");
		expect(loaded?.file.name).toBe("camera.svg");
		expect(loaded?.file.type).toBe("image/svg+xml");
		expect(loaded?.file.lastModified).toBe(123);
		expect(await loaded?.file.text()).toBe(source);
	} finally { if (url) URL.revokeObjectURL(url); reading.mockRestore(); metadata.mockRestore(); }
});

test("first legacy rename captures original identity and further renames retain it", async () => {
	const lease = spyOn(projectAccess, "write").mockImplementation(async (_id, operation) => operation());
	let stored: unknown = { id: "asset", name: "camera.svg", type: "image", size: 1 };
	const update = spyOn(IndexedDBAdapter.prototype, "update").mockImplementation(async (_id, change) => { stored = change(stored); return stored; });
	const write = spyOn(OPFSAdapter.prototype, "set");
	try {
		await storageService.updateMediaMetadata({ projectId: "project", id: "asset", updates: { name: "Opening card" } });
		await storageService.updateMediaMetadata({ projectId: "project", id: "asset", updates: { name: "Final card" } });
		expect(stored).toMatchObject({ name: "Final card", originalName: "camera.svg", mimeType: "image/svg+xml" });
		expect(write).not.toHaveBeenCalled();
	} finally { lease.mockRestore(); update.mockRestore(); write.mockRestore(); }
});


test("initial media persistence stores original file identity and source frame rate", async () => {
	const lease = spyOn(projectAccess, "write").mockImplementation(async (_id, operation) => operation());
	const original = spyOn(OPFSAdapter.prototype, "set").mockResolvedValue();
	const metadata = spyOn(IndexedDBAdapter.prototype, "set").mockResolvedValue();
	try {
		await storageService.saveMediaAsset({ projectId: "project", mediaAsset: { id: "asset", name: "Interview", type: "video", fps: 24, file: new File(["bytes"], "camera.mp4", { type: "video/mp4", lastModified: 123 }) } });
		expect(metadata).toHaveBeenCalledWith("asset", expect.objectContaining({ name: "Interview", originalName: "camera.mp4", mimeType: "video/mp4", fps: 24, lastModified: 123 }));
	} finally { lease.mockRestore(); original.mockRestore(); metadata.mockRestore(); }
});
