import { afterEach, expect, spyOn, test } from "bun:test";
import type { EditorCore } from "@/core";
import { MediaManager } from "./media-manager";
import { storageService } from "@/services/storage/service";
const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function harness() {
	let active = "a";
	const manager = new MediaManager({
		project: { getActiveOrNull: () => ({ metadata: { id: active } }) },
	} as unknown as EditorCore);
	return {
		manager,
		switchProject: (id: string) => {
			active = id;
			manager.clearAllAssets();
		},
	};
}
const asset = {
	name: "image.png",
	type: "image" as const,
	file: new File(["image"], "image.png"),
};
test("an import completing after navigation cannot enter the next project's media", async () => {
	const pending = deferred();
	const saving = spyOn(storageService, "saveMediaAsset").mockImplementation(
		() => pending.promise,
	);
	restores.push(() => saving.mockRestore());
	const { manager, switchProject } = harness();
	const importing = manager
		.addMediaAsset({ projectId: "a", asset })
		.catch((error: Error) => error);
	switchProject("b");
	pending.resolve();
	expect(((await importing) as Error).name).toBe("AbortError");
	expect(manager.getAssets()).toEqual([]);
	expect(saving.mock.calls[0][0].projectId).toBe("a");
});
test("a stale import is rejected before storage is written", async () => {
	const saving = spyOn(storageService, "saveMediaAsset").mockResolvedValue();
	restores.push(() => saving.mockRestore());
	const { manager, switchProject } = harness();
	switchProject("b");
	await expect(
		manager.addMediaAsset({ projectId: "a", asset }),
	).rejects.toThrow("project changed");
	expect(saving).not.toHaveBeenCalled();
});
test("media appears only after its original bytes have been persisted", async () => {
	const pending = deferred();
	const saving = spyOn(storageService, "saveMediaAsset").mockImplementation(
		() => pending.promise,
	);
	restores.push(() => saving.mockRestore());
	const { manager } = harness();
	const importing = manager.addMediaAsset({ projectId: "a", asset });
	expect(manager.getAssets()).toEqual([]);
	pending.resolve();
	const id = await importing;
	expect(manager.getAssets()[0].id).toBe(id);
	manager.clearAllAssets();
});

test("an import from an earlier opening of the same project is rejected", async () => {
	const saving = spyOn(storageService, "saveMediaAsset").mockResolvedValue();
	restores.push(() => saving.mockRestore());
	const { manager, switchProject } = harness();
	const sessionToken = manager.getSessionToken();
	switchProject("a");
	await expect(
		manager.addMediaAsset({ projectId: "a", asset, sessionToken }),
	).rejects.toThrow("project changed");
	expect(saving).not.toHaveBeenCalled();
});

test("a proxy finishing after project navigation cannot publish or persist its result", async () => {
	let finish!: (value: { file: File; width: number; height: number }) => void;
	const result = new Promise<{ file: File; width: number; height: number }>(
		(resolve) => {
			finish = resolve;
		},
	);
	let active = "a";
	const video = { ...asset, id: "video", type: "video" as const };
	const loading = spyOn(storageService, "loadAllMediaAssets").mockResolvedValue(
		[video],
	);
	const saving = spyOn(storageService, "saveProxyFile").mockResolvedValue();
	restores.push(
		() => loading.mockRestore(),
		() => saving.mockRestore(),
	);
	const manager = new MediaManager(
		{
			project: { getActiveOrNull: () => ({ metadata: { id: active } }) },
		} as unknown as EditorCore,
		() => result,
	);
	await manager.loadProjectMedia({ projectId: "a" });
	const generating = manager.generateProxyForAsset({
		projectId: "a",
		assetId: "video",
		resolution: "720p",
	});
	active = "b";
	manager.clearAllAssets();
	finish({ file: new File(["proxy"], "proxy.mp4"), width: 1280, height: 720 });
	await generating;
	expect(saving).not.toHaveBeenCalled();
	expect(manager.getAssets()).toEqual([]);
	expect(manager.isProxyGenerating("video")).toBe(false);
});

function deletionHarness() {
	let active = "a",
		exporting = false;
	const removed: unknown[] = [];
	const manager = new MediaManager({
		project: {
			getActiveOrNull: () => ({ metadata: { id: active } }),
			getExportState: () => ({ isExporting: exporting }),
		},
		timeline: {
			getTracks: () => [
				{
					id: "track",
					elements: [{ id: "clip", type: "image", mediaId: "media-id" }],
				},
			],
			deleteElements: (args: unknown) => {
				removed.push(args);
			},
		},
	} as unknown as EditorCore);
	manager.setAssets({ assets: [{ ...asset, id: "media-id" }] });
	return {
		manager,
		removed,
		setExporting: () => {
			exporting = true;
		},
		switchProject: () => {
			active = "b";
			manager.clearAllAssets();
			manager.setAssets({ assets: [{ ...asset, id: "media-id" }] });
		},
	};
}

test("failed media removal preserves the asset and timeline for a visible retry", async () => {
	const f = deletionHarness();
	const deleting = spyOn(storageService, "deleteMediaAsset").mockRejectedValue(
		new Error("storage unavailable"),
	);
	restores.push(() => deleting.mockRestore());
	await expect(
		f.manager.removeMediaAsset({ projectId: "a", id: "media-id" }),
	).rejects.toThrow("storage unavailable");
	expect(f.manager.getAssets()).toHaveLength(1);
	expect(f.removed).toEqual([]);
	deleting.mockResolvedValue();
	await f.manager.removeMediaAsset({ projectId: "a", id: "media-id" });
	expect(f.manager.getAssets()).toEqual([]);
	expect(f.removed).toHaveLength(1);
});

test("a delayed removal cannot mutate a newer project session", async () => {
	const f = deletionHarness(),
		pending = deferred();
	const deleting = spyOn(storageService, "deleteMediaAsset").mockReturnValue(
		pending.promise,
	);
	restores.push(() => deleting.mockRestore());
	const removal = f.manager
		.removeMediaAsset({ projectId: "a", id: "media-id" })
		.catch((error: Error) => error);
	expect(f.manager.getIsRemovingMedia()).toBe(true);
	f.switchProject();
	pending.resolve();
	expect(((await removal) as Error).name).toBe("AbortError");
	expect(f.manager.getIsRemovingMedia()).toBe(false);
	expect(f.manager.getAssets()).toHaveLength(1);
	expect(f.removed).toEqual([]);
});

test("removing media is rejected while export owns the original", async () => {
	const f = deletionHarness();
	f.setExporting();
	const deleting = spyOn(
		storageService,
		"deleteMediaAsset",
	).mockResolvedValue();
	restores.push(() => deleting.mockRestore());
	await expect(
		f.manager.removeMediaAsset({ projectId: "a", id: "media-id" }),
	).rejects.toThrow("export");
	expect(deleting).not.toHaveBeenCalled();
	expect(f.manager.getAssets()).toHaveLength(1);
});

test("media labels publish after metadata commit and failure leaves the old label", async () => {
	const { manager } = harness();
	manager.setAssets({ assets: [{ ...asset, id: "label-asset" }] });
	const updating = spyOn(
		storageService,
		"updateMediaMetadata",
	).mockRejectedValue(new Error("metadata aborted"));
	const originalWrite = spyOn(storageService, "saveMediaAsset");
	restores.push(
		() => updating.mockRestore(),
		() => originalWrite.mockRestore(),
	);
	await expect(
		manager.updateMediaAsset({
			projectId: "a",
			id: "label-asset",
			updates: { label: "new" },
		}),
	).rejects.toThrow("metadata aborted");
	expect(manager.getAssets()[0].label).toBeUndefined();
	expect(originalWrite).not.toHaveBeenCalled();
	updating.mockResolvedValue({ name: "image.png", label: "new" });
	await manager.updateMediaAsset({
		projectId: "a",
		id: "label-asset",
		updates: { label: "new" },
	});
	expect(manager.getAssets()[0].label).toBe("new");
});
test("a metadata update from an older project cannot overwrite the next session", async () => {
	const { manager, switchProject } = harness();
	manager.setAssets({ assets: [{ ...asset, id: "same" }] });
	let finish!: (value: { name: string; label: string }) => void;
	const pending = new Promise<{ name: string; label: string }>((resolve) => {
		finish = resolve;
	});
	const updating = spyOn(storageService, "updateMediaMetadata").mockReturnValue(
		pending,
	);
	restores.push(() => updating.mockRestore());
	const update = manager
		.updateMediaAsset({ projectId: "a", id: "same", updates: { label: "old" } })
		.catch((error: Error) => error);
	switchProject("b");
	manager.setAssets({ assets: [{ ...asset, id: "same", label: "current" }] });
	finish({ name: "image.png", label: "old" });
	expect(((await update) as Error).name).toBe("AbortError");
	expect(manager.getAssets()[0].label).toBe("current");
});
