import { z } from "zod";
import type { TProject } from "@/types/project";
import type { MediaAsset } from "@/types/assets";
import { CURRENT_PROJECT_VERSION } from "./migrations";

const MAGIC = new TextEncoder().encode("OCBACK01");
const HEADER = 44;
const CHUNK = 8 * 1024 * 1024;
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_ARCHIVE = 8 * 1024 ** 3;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const positive = z.number().finite().positive();
const element = z
	.object({
		id,
		type: z.enum([
			"video",
			"image",
			"audio",
			"text",
			"sticker",
			"effect",
			"compound",
		]),
		trimStart: z.number().finite().nonnegative().optional(),
		trimEnd: z.number().finite().nonnegative().optional(),
		playbackRate: positive.optional(),
		startTime: z.number().finite().nonnegative(),
		duration: z.number().finite().nonnegative(),
	})
	.passthrough();
const projectSchema = z
	.object({
		version: z.literal(CURRENT_PROJECT_VERSION),
		metadata: z
			.object({
				id,
				name: z.string().min(1).max(1000),
				duration: z.number().finite().nonnegative(),
				createdAt: date,
				updatedAt: date,
			})
			.passthrough(),
		currentSceneId: id,
		scenes: z
			.array(
				z
					.object({
						id,
						name: z.string(),
						createdAt: date,
						updatedAt: date,
						tracks: z
							.array(
								z
									.object({
										id,
										type: z.enum([
											"video",
											"audio",
											"text",
											"sticker",
											"effect",
										]),
										elements: z.array(element).max(100000),
									})
									.passthrough(),
							)
							.max(10000),
					})
					.passthrough(),
			)
			.min(1)
			.max(1000),
		settings: z
			.object({
				fps: positive.max(240),
				canvasSize: z.object({
					width: positive.max(16384),
					height: positive.max(16384),
				}),
				background: z.discriminatedUnion("type", [
					z.object({ type: z.literal("color"), color: z.string() }),
					z.object({
						type: z.literal("blur"),
						blurIntensity: z.number().finite(),
					}),
				]),
			})
			.passthrough(),
	})
	.passthrough();
const assetSchema = z.object({
	id,
	name: z.string().max(1000),
	type: z.enum(["video", "audio", "image"]),
	mime: z.string().max(255),
	size: z.number().int().nonnegative().max(MAX_ARCHIVE),
	lastModified: z.number().finite(),
	width: positive.optional(),
	height: positive.optional(),
	duration: z.number().finite().nonnegative().optional(),
	fps: positive.optional(),
	label: z.string().optional(),
	hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_ARCHIVE / CHUNK),
});
const manifestSchema = z.object({
	format: z.literal(1),
	project: projectSchema,
	assets: z.array(assetSchema).max(10000),
});

async function hashes(blob: Blob): Promise<string[]> {
	const result: string[] = [];
	for (let offset = 0; offset < blob.size; offset += CHUNK) {
		const digest = await crypto.subtle.digest(
			"SHA-256",
			await blob.slice(offset, offset + CHUNK).arrayBuffer(),
		);
		result.push(
			Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join(""),
		);
	}
	return result;
}

export async function createProjectBackup(
	project: TProject,
	assets: MediaAsset[],
): Promise<Blob> {
	const entries = [];
	const assetIds = new Set<string>();
	let total = 0;
	for (const asset of assets) {
		if (assetIds.has(asset.id)) throw new Error("Duplicate media ID in backup");
		assetIds.add(asset.id);
		total += asset.file.size;
		if (total > MAX_ARCHIVE)
			throw new Error("Project backup exceeds the 8 GiB archive limit");
		entries.push({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			mime: asset.file.type,
			size: asset.file.size,
			lastModified: asset.file.lastModified,
			width: asset.width,
			height: asset.height,
			duration: asset.duration,
			fps: asset.fps,
			label: asset.label,
			hashes: await hashes(asset.file),
		});
	}
	// AudioBuffers are decoded caches, not project data. Preserve all other fields.
	const clean = JSON.parse(
		JSON.stringify(project, (key, value) =>
			key === "buffer" ? undefined : value,
		),
	);
	const manifest = manifestSchema.parse({
		format: 1,
		project: clean,
		assets: entries,
	});
	validateReferences(
		manifest.project,
		new Set(entries.map((entry) => entry.id)),
	);
	const json = new TextEncoder().encode(JSON.stringify(manifest));
	if (json.length > MAX_MANIFEST)
		throw new Error("Project backup manifest is too large");
	const header = new Uint8Array(HEADER);
	header.set(MAGIC);
	new DataView(header.buffer).setUint32(8, json.length, true);
	header.set(new Uint8Array(await crypto.subtle.digest("SHA-256", json)), 12);
	return new Blob([header, json, ...assets.map((asset) => asset.file)], {
		type: "application/octet-stream",
	});
}

export async function readProjectBackup(
	blob: Blob,
): Promise<{ project: TProject; assets: MediaAsset[] }> {
	if (blob.size < HEADER || blob.size > MAX_ARCHIVE + MAX_MANIFEST + HEADER)
		throw new Error("Invalid project backup size");
	const header = new Uint8Array(await blob.slice(0, HEADER).arrayBuffer());
	if (!MAGIC.every((byte, index) => header[index] === byte))
		throw new Error("This is not an OpenCut project backup");
	const length = new DataView(header.buffer).getUint32(8, true);
	if (!length || length > MAX_MANIFEST || length + HEADER > blob.size)
		throw new Error("Invalid backup manifest size");
	const json = await blob.slice(HEADER, HEADER + length).arrayBuffer();
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", json));
	if (!digest.every((byte, index) => header[12 + index] === byte))
		throw new Error("Backup manifest integrity check failed");
	const manifest = manifestSchema.parse(
		JSON.parse(new TextDecoder().decode(json)),
	);
	const ids = new Set<string>();
	let offset = length + HEADER;
	const assets: MediaAsset[] = [];
	for (const entry of manifest.assets) {
		if (ids.has(entry.id)) throw new Error("Duplicate media ID in backup");
		ids.add(entry.id);
		if (offset + entry.size > blob.size)
			throw new Error("Truncated backup media");
		const file = new File(
			[blob.slice(offset, offset + entry.size)],
			entry.name,
			{ type: entry.mime, lastModified: entry.lastModified },
		);
		if (JSON.stringify(await hashes(file)) !== JSON.stringify(entry.hashes))
			throw new Error(`Backup media integrity check failed: ${entry.name}`);
		const {
			hashes: _hashes,
			mime: _mime,
			size: _size,
			lastModified: _modified,
			...metadata
		} = entry;
		assets.push({ ...metadata, file });
		offset += entry.size;
	}
	if (offset !== blob.size) throw new Error("Unexpected trailing backup data");
	validateReferences(manifest.project, ids);
	const project = {
		...manifest.project,
		metadata: {
			...manifest.project.metadata,
			createdAt: new Date(manifest.project.metadata.createdAt),
			updatedAt: new Date(manifest.project.metadata.updatedAt),
		},
		scenes: manifest.project.scenes.map((scene) => ({
			...scene,
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})),
	} as unknown as TProject;
	return { project, assets };
}

function validateReferences(
	project: z.infer<typeof projectSchema>,
	mediaIds: Set<string>,
): void {
	if (!project.scenes.some((scene) => scene.id === project.currentSceneId))
		throw new Error("Backup current scene is missing");
	const sceneIds = new Set<string>();
	for (const scene of project.scenes) {
		if (sceneIds.has(scene.id)) throw new Error("Duplicate scene ID in backup");
		sceneIds.add(scene.id);
	}
	const trackIds = new Set<string>();
	const elementIds = new Set<string>();
	const validateTracks = (tracks: unknown): void => {
		const parsed =
			projectSchema.shape.scenes.element.shape.tracks.parse(tracks);
		for (const track of parsed) {
			if (trackIds.has(track.id))
				throw new Error("Duplicate track ID in backup");
			trackIds.add(track.id);
			for (const clip of track.elements) {
				if (elementIds.has(clip.id))
					throw new Error("Duplicate element ID in backup");
				elementIds.add(clip.id);
				if (!Number.isFinite(clip.startTime + clip.duration))
					throw new Error("Backup timeline duration exceeds numeric range");
				if (clip.type === "compound") validateTracks(clip.innerTracks);
			}
		}
	};
	for (const scene of project.scenes) {
		// Identity uniqueness is per scene, including compound children.
		trackIds.clear();
		elementIds.clear();
		validateTracks(scene.tracks);
	}
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		for (const [key, item] of Object.entries(value)) {
			if (key === "mediaId" && typeof item === "string" && !mediaIds.has(item))
				throw new Error("Backup is missing referenced media");
			visit(item);
		}
	};
	visit(project.scenes);
}
