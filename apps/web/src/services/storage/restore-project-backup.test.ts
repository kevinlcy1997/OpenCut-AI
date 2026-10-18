import { expect, test } from "bun:test";
import type { TProject } from "@/types/project";
import type { MediaAsset } from "@/types/assets";
import { CURRENT_PROJECT_VERSION } from "./migrations";
import { createProjectBackup } from "./project-backup";
import { restoreProjectBackup } from "./restore-project-backup";

async function fixture() {
	const project = {
		version: CURRENT_PROJECT_VERSION,
		metadata: {
			id: "original",
			name: "Original",
			duration: 1,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		currentSceneId: "scene",
		settings: {
			fps: 30,
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000" },
		},
		scenes: [
			{
				id: "scene",
				name: "Main",
				createdAt: new Date(0),
				updatedAt: new Date(0),
				tracks: [],
			},
		],
	} as unknown as TProject;
	const assets = ["first", "second"].map(
		(id): MediaAsset => ({
			id,
			name: `${id}.wav`,
			type: "audio",
			file: new File(["original audio"], `${id}.wav`),
		}),
	);
	const archive = await createProjectBackup(project, assets);
	const projects = new Map([["original", project]]);
	const media = new Map<string, string[]>();
	const events: string[] = [];
	let failMedia = false,
		failProject = false,
		failCleanup = false;
	const storage = {
		async saveMediaAsset({
			projectId,
			mediaAsset,
		}: {
			projectId: string;
			mediaAsset: MediaAsset;
		}) {
			events.push(`media:${mediaAsset.id}`);
			media.set(projectId, [...(media.get(projectId) ?? []), mediaAsset.id]);
			// Simulate a write which partially stores bytes before rejecting.
			if (failMedia && mediaAsset.id === "second")
				throw new Error("quota exceeded during write");
		},
		async saveProject({ project }: { project: TProject }) {
			events.push("project");
			if (failProject) throw new Error("metadata transaction aborted");
			projects.set(project.metadata.id, project);
		},
		async deleteProjectMedia({ projectId }: { projectId: string }) {
			events.push("cleanup");
			if (failCleanup) throw new Error("storage unavailable");
			media.delete(projectId);
		},
	};
	return {
		archive,
		projects,
		media,
		events,
		options: {
			storage,
			journal: {
				run: async <T>(_id: string, operation: () => Promise<T>) => operation(),
			},
			estimate: async () => ({ quota: 1024, usage: 0 }),
			beforeWrite: async () => {
				events.push("flush");
			},
		},
		fail: (kind: string) => {
			failMedia = kind === "media" || kind === "cleanup";
			failProject = kind === "project";
			failCleanup = kind === "cleanup";
		},
	};
}

test("restore publishes a new project only after all original writes", async () => {
	const f = await fixture();
	const id = await restoreProjectBackup(f.archive, f.options);
	expect(id).not.toBe("original");
	expect(f.events).toEqual(["flush", "media:first", "media:second", "project"]);
	expect(f.projects.size).toBe(2);
	expect(f.media.get(id)).toEqual(["first", "second"]);
	expect(f.projects.get(id)?.metadata.name).toBe("Original (restored)");
});
for (const failure of ["media", "project"]) {
	test(`restore rolls back staged media after ${failure} failure and can retry`, async () => {
		const f = await fixture();
		f.fail(failure);
		await expect(restoreProjectBackup(f.archive, f.options)).rejects.toThrow(
			failure === "media" ? "quota exceeded" : "transaction aborted",
		);
		expect([...f.projects.keys()]).toEqual(["original"]);
		expect(f.media.size).toBe(0);
		expect(f.events.at(-1)).toBe("cleanup");
		f.fail("");
		await restoreProjectBackup(f.archive, f.options);
		expect(f.projects.size).toBe(2);
	});
}
test("low quota and corrupt archives cause no storage mutation", async () => {
	const f = await fixture();
	await expect(
		restoreProjectBackup(f.archive, {
			...f.options,
			estimate: async () => ({ quota: 1, usage: 0 }),
		}),
	).rejects.toThrow("Insufficient");
	await expect(
		restoreProjectBackup(f.archive.slice(0, 20), f.options),
	).rejects.toThrow();
	expect(f.events).toEqual([]);
	expect(f.projects.size).toBe(1);
});
test("failed pre-restore save does not stage any media", async () => {
	const f = await fixture();
	await expect(
		restoreProjectBackup(f.archive, {
			...f.options,
			beforeWrite: async () => {
				throw new Error("save failed");
			},
		}),
	).rejects.toThrow("save failed");
	expect(f.events).toEqual([]);
	expect(f.media.size).toBe(0);
});
test("cleanup failure is surfaced with both underlying errors", async () => {
	const f = await fixture();
	f.fail("cleanup");
	try {
		await restoreProjectBackup(f.archive, f.options);
		throw new Error("unexpected success");
	} catch (error) {
		expect(error).toBeInstanceOf(AggregateError);
		expect(
			(error as AggregateError).errors.map((e: Error) => e.message),
		).toEqual(["quota exceeded during write", "storage unavailable"]);
		expect((error as Error).message).toContain(
			"temporary media cleanup failed",
		);
	}
	expect([...f.projects.keys()]).toEqual(["original"]);
});

test("a correctly hashed archive with broken clip references cannot flush or mutate storage, and retry works", async () => {
	const f = await fixture();
	const header = new Uint8Array(await f.archive.slice(0, 44).arrayBuffer());
	const length = new DataView(header.buffer).getUint32(8, true);
	const manifest = JSON.parse(await f.archive.slice(44, 44 + length).text());
	manifest.project.scenes[0].tracks = [
		{
			id: "broken-track",
			type: "video",
			elements: [
				{
					id: "broken-clip",
					type: "video",
					startTime: 0,
					duration: 1,
				},
			],
		},
	];
	const json = new TextEncoder().encode(JSON.stringify(manifest));
	new DataView(header.buffer).setUint32(8, json.length, true);
	header.set(new Uint8Array(await crypto.subtle.digest("SHA-256", json)), 12);
	const broken = new Blob([header, json, f.archive.slice(44 + length)]);
	await expect(restoreProjectBackup(broken, f.options)).rejects.toThrow(
		"invalid media reference",
	);
	expect(f.events).toEqual([]);
	expect([...f.projects.keys()]).toEqual(["original"]);
	expect(f.media.size).toBe(0);
	const restoredId = await restoreProjectBackup(f.archive, f.options);
	expect(f.projects.has("original")).toBe(true);
	expect(f.projects.has(restoredId)).toBe(true);
	expect(f.media.get(restoredId)).toEqual(["first", "second"]);
});

test("excessive archive nesting is rejected before admission, journal or storage work", async () => {
	const f = await fixture();
	const header = new Uint8Array(await f.archive.slice(0, 44).arrayBuffer());
	const length = new DataView(header.buffer).getUint32(8, true);
	const manifest = JSON.parse(await f.archive.slice(44, 44 + length).text());
	let extension: unknown = { value: "leaf" };
	for (let depth = 0; depth < 258; depth++) extension = { nested: extension };
	manifest.project.scenes[0].extension = extension;
	const json = new TextEncoder().encode(JSON.stringify(manifest));
	new DataView(header.buffer).setUint32(8, json.length, true);
	header.set(new Uint8Array(await crypto.subtle.digest("SHA-256", json)), 12);
	const archive = new Blob([header, json, f.archive.slice(44 + length)]);
	let admissionCalled = false;
	await expect(
		restoreProjectBackup(archive, {
			...f.options,
			estimate: async () => {
				admissionCalled = true;
				return { quota: 1024 };
			},
			journal: {
				run: async () => {
					throw new Error("journal must not start");
				},
			},
		}),
	).rejects.toThrow("metadata nesting");
	expect(admissionCalled).toBe(false);
	expect(f.events).toEqual([]);
	expect([...f.projects.keys()]).toEqual(["original"]);
	expect(f.media.size).toBe(0);
});
