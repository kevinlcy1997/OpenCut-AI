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
