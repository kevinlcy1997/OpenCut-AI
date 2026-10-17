import { clearImageSourceCache } from "@/services/renderer/image-source-cache";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/types/assets";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { hasMediaId } from "@/lib/timeline/element-utils";
import {
	PROXY_THRESHOLD_WIDTH,
	PROXY_THRESHOLD_HEIGHT,
	type ProxyResolution,
} from "@/services/storage/types";
import { generateProxy } from "@/services/proxy";
import { deleteEmbedding } from "@/services/search/embedding-store";

export class MediaManager {
	private assets: MediaAsset[] = [];
	private generation = 0;
	private pendingMediaRemovals = 0;
	private isLoading = false;
	private listeners = new Set<() => void>();
	private proxyGenerators = new Map<string, AbortController>();

	constructor(
		private editor: EditorCore,
		private proxyGenerator: typeof generateProxy = generateProxy,
	) {}

	getSessionToken(): number {
		return this.generation;
	}

	async addMediaAsset({
		projectId,
		asset,
		sessionToken = this.generation,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
		sessionToken?: number;
	}): Promise<string> {
		const generation = sessionToken;
		this.assertProject(projectId, generation);
		const newAsset: MediaAsset = {
			...asset,
			id: generateUUID(),
		};

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			this.assertProject(projectId, generation);
			this.assets = [...this.assets, newAsset];
			this.notify();
		} catch (error) {
			if ((error as Error).name !== "AbortError")
				console.error("Failed to save media asset:", error);
			for (const url of [newAsset.url, newAsset.thumbnailUrl])
				if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();
			throw error;
		}

		return newAsset.id;
	}

	async updateMediaAsset({
		projectId,
		id,
		updates,
	}: {
		projectId: string;
		id: string;
		updates: Partial<Pick<MediaAsset, "label" | "name">>;
	}): Promise<void> {
		const generation = this.generation;
		this.assertProject(projectId, generation);
		if (!this.assets.some((asset) => asset.id === id)) return;
		const metadata = await storageService.updateMediaMetadata({ projectId, id, updates });
		this.assertProject(projectId, generation);
		this.assets = this.assets.map((asset) => asset.id === id ? { ...asset, ...metadata } : asset);
		this.notify();
	}

	getIsRemovingMedia(): boolean {
		return this.pendingMediaRemovals > 0;
	}

	async removeMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const generation = this.generation;
		this.assertProject(projectId, generation);
		if (this.editor.project.getExportState().isExporting)
			throw new Error("Wait for the export to finish or cancel it before removing media");
		const asset = this.assets.find((asset) => asset.id === id);
		if (!asset) return;
		const controller = this.proxyGenerators.get(id);
		controller?.abort();
		if (this.proxyGenerators.get(id) === controller) this.proxyGenerators.delete(id);
		// A failed storage removal must not silently discard the editing state.
		this.pendingMediaRemovals++;
		try {
			await storageService.deleteMediaAsset({ projectId, id });
			this.assertProject(projectId, generation);
			if (!this.assets.some((item) => item.id === id)) return;

			videoCache.clearVideo({ mediaId: id });
			clearImageSourceCache();
			deleteEmbedding(id).catch(() => undefined);

			if (asset?.url) {
				URL.revokeObjectURL(asset.url);
				if (asset.thumbnailUrl) {
					URL.revokeObjectURL(asset.thumbnailUrl);
				}
				if (asset.proxyUrl) {
					URL.revokeObjectURL(asset.proxyUrl);
				}
			}

			this.assets = this.assets.filter((asset) => asset.id !== id);
			this.notify();

			const tracks = this.editor.timeline.getTracks();
			const elementsToRemove: Array<{ trackId: string; elementId: string }> = [];

			for (const track of tracks) {
				for (const element of track.elements) {
					if (hasMediaId(element) && element.mediaId === id) {
						elementsToRemove.push({ trackId: track.id, elementId: element.id });
					}
				}
			}

			if (elementsToRemove.length > 0) {
				this.editor.timeline.deleteElements({ elements: elementsToRemove });
			}

		} finally {
			this.pendingMediaRemovals--;
			this.notify();
		}
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			this.assets = mediaAssets;

			const proxyPromises = mediaAssets
				.filter((a) => a.proxy)
				.map((a) => this.loadProxyForAsset({ assetId: a.id, projectId }));
			await Promise.all(proxyPromises);

			this.notify();
		} catch (error) {
			console.error("Failed to load media assets:", error);
			throw error;
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
			if (asset.proxyUrl) {
				URL.revokeObjectURL(asset.proxyUrl);
			}
		});

		for (const [id, controller] of this.proxyGenerators) {
			controller.abort();
		}
		this.proxyGenerators.clear();

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		// Drop embedding index entries for the removed assets (fire-and-forget).
		mediaIds.forEach((id) => deleteEmbedding(id).catch(() => undefined));

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	private assertProject(projectId: string, generation: number): void {
		if (
			this.generation !== generation ||
			this.editor.project.getActiveOrNull()?.metadata.id !== projectId
		) {
			throw new DOMException(
				"The project changed while media was processing",
				"AbortError",
			);
		}
	}

	clearAllAssets(): void {
		this.generation++;
		clearImageSourceCache();
		videoCache.clearAll();

		for (const [, controller] of this.proxyGenerators) {
			controller.abort();
		}
		this.proxyGenerators.clear();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
			if (asset.proxyUrl) {
				URL.revokeObjectURL(asset.proxyUrl);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	getAssetById(id: string): MediaAsset | undefined {
		return this.assets.find((a) => a.id === id);
	}

	needsProxy(asset: MediaAsset): boolean {
		if (asset.type !== "video") return false;
		if (!asset.width || !asset.height) return false;
		return (
			asset.width > PROXY_THRESHOLD_WIDTH ||
			asset.height > PROXY_THRESHOLD_HEIGHT
		);
	}

	isProxyGenerating(assetId: string): boolean {
		return this.proxyGenerators.has(assetId);
	}

	async generateProxyForAsset({
		assetId,
		projectId,
		resolution,
		onProgress,
	}: {
		assetId: string;
		projectId: string;
		resolution: ProxyResolution;
		onProgress?: (progress: number) => void;
	}): Promise<void> {
		const generation = this.generation;
		this.assertProject(projectId, generation);
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset || asset.type !== "video") return;

		const existing = this.proxyGenerators.get(assetId);
		if (existing) {
			existing.abort();
			this.proxyGenerators.delete(assetId);
		}

		const controller = new AbortController();
		this.proxyGenerators.set(assetId, controller);
		this.notify();

		let proxyUrl: string | undefined;
		let published = false;
		const check = () => {
			this.assertProject(projectId, generation);
			if (
				controller.signal.aborted ||
				this.proxyGenerators.get(assetId) !== controller
			)
				throw new DOMException("Proxy cancelled", "AbortError");
		};
		try {
			const result = await this.proxyGenerator({
				file: asset.file,
				resolution,
				onProgress,
				signal: controller.signal,
			});

			check();
			proxyUrl = URL.createObjectURL(result.file);

			await storageService.saveProxyFile({
				projectId,
				assetId,
				proxyFile: result.file,
			});

			check();
			const updatedAsset: MediaAsset = {
				...asset,
				proxyFile: result.file,
				proxyUrl,
				proxy: {
					resolution,
					width: result.width,
					height: result.height,
					generatedAt: Date.now(),
					fileSize: result.file.size,
				},
			};

			await storageService.saveMediaAsset({
				projectId,
				mediaAsset: updatedAsset,
			});

			check();
			this.assets = this.assets.map((a) =>
				a.id === assetId ? updatedAsset : a,
			);
			published = true;
			this.notify();
		} catch (error) {
			if ((error as Error).name !== "AbortError") {
				console.error("Proxy generation failed:", error);
			}
		} finally {
			if (!published && proxyUrl) URL.revokeObjectURL(proxyUrl);
			if (this.proxyGenerators.get(assetId) === controller)
				this.proxyGenerators.delete(assetId);
			this.notify();
		}
	}

	async loadProxyForAsset({
		assetId,
		projectId,
	}: {
		assetId: string;
		projectId: string;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset || !asset.proxy) return;

		try {
			const proxyFile = await storageService.loadProxyFile({
				projectId,
				assetId,
			});
			if (!proxyFile) return;

			const proxyUrl = URL.createObjectURL(proxyFile);

			this.assets = this.assets.map((a) =>
				a.id === assetId ? { ...a, proxyFile, proxyUrl } : a,
			);
			this.notify();
		} catch (error) {
			console.error("Failed to load proxy:", error);
		}
	}

	async deleteProxyForAsset({
		assetId,
		projectId,
	}: {
		assetId: string;
		projectId: string;
	}): Promise<void> {
		const asset = this.assets.find((a) => a.id === assetId);
		if (!asset) return;

		const controller = this.proxyGenerators.get(assetId);
		if (controller) {
			controller.abort();
			this.proxyGenerators.delete(assetId);
		}

		if (asset.proxyUrl) {
			URL.revokeObjectURL(asset.proxyUrl);
		}

		this.assets = this.assets.map((a) =>
			a.id === assetId
				? {
						...a,
						proxyFile: undefined,
						proxyUrl: undefined,
						proxy: undefined,
					}
				: a,
		);
		this.notify();

		await storageService.deleteProxyFile({ projectId, assetId });
	}

	cancelProxyGeneration(assetId: string): void {
		const controller = this.proxyGenerators.get(assetId);
		if (controller) {
			controller.abort();
			this.proxyGenerators.delete(assetId);
			this.notify();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => fn());
	}
}
