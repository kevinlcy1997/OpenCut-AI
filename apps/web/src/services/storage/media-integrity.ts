import type { MediaAssetData } from "./types";

export class MissingMediaError extends Error {
	constructor(
		public readonly missing: Pick<MediaAssetData, "id" | "name" | "size" | "originalName">[],
	) {
		super(
			`${missing.length} original media file(s) are missing from browser storage. Reconnect the original files or restore a project backup.`,
		);
		this.name = "MissingMediaError";
	}
}

/** Includes nested compound clips, so missing content cannot silently disappear. */
export function assertMediaReferences(
	value: unknown,
	available: Set<string>,
): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) assertMediaReferences(item, available);
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		if (key === "mediaId" && typeof item === "string" && !available.has(item)) {
			throw new Error(
				"The timeline references missing media. Restore a project backup before exporting.",
			);
		}
		assertMediaReferences(item, available);
	}
}
