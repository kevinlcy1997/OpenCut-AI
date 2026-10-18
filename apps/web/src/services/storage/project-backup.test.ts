import type { VideoTrack } from "@/types/timeline";
import { describe, expect, test } from "bun:test";
import { createProjectBackup, readProjectBackup } from "./project-backup";
import { CURRENT_PROJECT_VERSION } from "./migrations";
import type { TProject } from "@/types/project";
import type { MediaAsset } from "@/types/assets";

function fixture() {
	const project = {
		version: CURRENT_PROJECT_VERSION,
		metadata: {
			id: "original",
			name: "Test",
			duration: 1,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		currentSceneId: "scene",
		settings: {
			fps: 30,
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		scenes: [
			{
				id: "scene",
				name: "Main",
				createdAt: new Date(0),
				updatedAt: new Date(0),
				isMain: true,
				tracks: [
					{
						id: "track",
						type: "video",
						elements: [
							{
								id: "clip",
								type: "video",
								mediaId: "media",
								startTime: 0,
								duration: 1,
								transform: { scale: 0.9 },
							},
						],
					},
				],
			},
		],
	} as unknown as TProject;
	const assets: MediaAsset[] = [
		{
			id: "media",
			name: "test.mp4",
			type: "video",
			duration: 1,
			file: new File([new Uint8Array([1, 2, 3, 4])], "test.mp4", {
				type: "video/mp4",
				lastModified: 123,
			}),
		},
	];
	return { project, assets };
}

describe("portable project backup", () => {
	test("round trips original bytes, dates, timeline edits and media IDs", async () => {
		const { project, assets } = fixture();
		const restored = await readProjectBackup(
			await createProjectBackup(project, assets),
		);
		expect(restored.project).toEqual(project);
		expect(await restored.assets[0].file.arrayBuffer()).toEqual(
			await assets[0].file.arrayBuffer(),
		);
		expect(restored.assets[0].file.name).toBe("test.mp4");
		expect(restored.assets[0].file.type).toBe("video/mp4");
		expect(restored.assets[0].file.lastModified).toBe(123);
	});
	test("round trips mixed media across hash chunk boundaries", async () => {
		const { project, assets } = fixture();
		const bytes = new Uint8Array(8 * 1024 * 1024 + 257);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 251;
		assets.push(
			{
				id: "audio",
				name: "speech.wav",
				type: "audio",
				duration: 12,
				file: new File([bytes], "speech.wav", { type: "audio/wav" }),
			},
			{
				id: "image",
				name: "still.png",
				type: "image",
				width: 100,
				height: 50,
				file: new File([new Uint8Array([137, 80, 78, 71])], "still.png", {
					type: "image/png",
				}),
			},
		);
		const restored = await readProjectBackup(
			await createProjectBackup(project, assets),
		);
		expect(restored.assets.map((asset) => asset.id)).toEqual([
			"media",
			"audio",
			"image",
		]);
		for (let i = 0; i < assets.length; i++) {
			expect(await restored.assets[i].file.arrayBuffer()).toEqual(
				await assets[i].file.arrayBuffer(),
			);
			expect(restored.assets[i].file.type).toBe(assets[i].file.type);
		}
		expect(restored.assets[1].duration).toBe(12);
		expect(restored.assets[2].width).toBe(100);
	});
	test("detects corruption in the second media hash chunk", async () => {
		const { project, assets } = fixture();
		assets[0].file = new File(
			[new Uint8Array(8 * 1024 * 1024 + 257)],
			"large.mp4",
		);
		const backup = await createProjectBackup(project, assets);
		const damaged = new Blob([
			backup.slice(0, backup.size - 1),
			new Uint8Array([1]),
		]);
		await expect(readProjectBackup(damaged)).rejects.toThrow("integrity");
	});
	test("rejects duplicate media IDs before restoring", async () => {
		const { project, assets } = fixture();
		assets.push({ ...assets[0] });
		await expect(createProjectBackup(project, assets)).rejects.toThrow(
			"Duplicate media ID",
		);
	});
	test("detects corrupted media", async () => {
		const { project, assets } = fixture();
		const backup = await createProjectBackup(project, assets);
		const damaged = new Blob([
			backup.slice(0, backup.size - 1),
			new Uint8Array([99]),
		]);
		await expect(readProjectBackup(damaged)).rejects.toThrow("integrity");
	});
	test("detects corrupted manifest before loading project", async () => {
		const { project, assets } = fixture();
		const backup = await createProjectBackup(project, assets);
		const damaged = new Blob([
			backup.slice(0, 50),
			new Uint8Array([99]),
			backup.slice(51),
		]);
		await expect(readProjectBackup(damaged)).rejects.toThrow(
			"manifest integrity",
		);
	});
	test("rejects incomplete archives and trailing data", async () => {
		const { project, assets } = fixture();
		const backup = await createProjectBackup(project, assets);
		await expect(
			readProjectBackup(backup.slice(0, backup.size - 1)),
		).rejects.toThrow("Truncated");
		await expect(
			readProjectBackup(new Blob([backup, "extra"])),
		).rejects.toThrow("trailing");
	});
	test("refuses to back up a timeline with missing original media", async () => {
		const { project } = fixture();
		await expect(createProjectBackup(project, [])).rejects.toThrow(
			"missing referenced media",
		);
	});
	test("rejects invalid format and future project versions", async () => {
		await expect(
			readProjectBackup(new Blob(["not an archive".repeat(4)])),
		).rejects.toThrow("not an OpenCut");
		const { project, assets } = fixture();
		project.version++;
		await expect(createProjectBackup(project, assets)).rejects.toThrow();
	});
});

for (const [field, value] of [
	["type", "unknown-renderer"],
	["playbackRate", 0],
	["trimStart", -1],
	["trimEnd", "bad"],
] as const) {
	test(`rejects malformed timeline ${field}`, async () => {
		const { project, assets } = fixture();
		Object.assign(project.scenes[0].tracks[0].elements[0], { [field]: value });
		await expect(createProjectBackup(project, assets)).rejects.toThrow();
	});
}
test("rejects duplicate timeline identities and overflowing end times", async () => {
	const { project, assets } = fixture();
	const track = project.scenes[0].tracks[0] as VideoTrack;
	track.elements.push({ ...track.elements[0] });
	await expect(createProjectBackup(project, assets)).rejects.toThrow(
		"Duplicate element",
	);
	track.elements.pop();
	project.scenes[0].tracks.push({ ...track });
	await expect(createProjectBackup(project, assets)).rejects.toThrow(
		"Duplicate track",
	);
	project.scenes[0].tracks.pop();
	Object.assign(track.elements[0], {
		startTime: Number.MAX_VALUE,
		duration: Number.MAX_VALUE,
	});
	await expect(createProjectBackup(project, assets)).rejects.toThrow(
		"numeric range",
	);
});
test("validates nested compound timelines before creating an archive", async () => {
	const { project, assets } = fixture();
	const inner = structuredClone(project.scenes[0].tracks[0]);
	inner.id = "inner-track";
	inner.elements[0].id = "inner-clip";
	Object.assign(project.scenes[0].tracks[0].elements[0], {
		type: "compound",
		innerTracks: [inner],
	});
	await readProjectBackup(await createProjectBackup(project, assets));
	Object.assign(inner.elements[0], { playbackRate: -1 });
	await expect(createProjectBackup(project, assets)).rejects.toThrow();
});

for (const type of ["video", "image", "audio"] as const) {
	for (const mediaId of [undefined, null, 123, "", "../outside"]) {
		test(`rejects ${type} clip with invalid media reference ${String(mediaId)}`, async () => {
			const { project, assets } = fixture();
			Object.assign(project.scenes[0].tracks[0].elements[0], {
				type,
				sourceType: "upload",
				mediaId,
			});
			await expect(createProjectBackup(project, assets)).rejects.toThrow(
				"invalid media reference",
			);
		});
	}
}

test("rejects invalid audio sources while retaining library audio", async () => {
	const { project, assets } = fixture();
	const clip = project.scenes[0].tracks[0].elements[0];
	Object.assign(clip, { type: "audio", sourceType: "unknown" });
	await expect(createProjectBackup(project, assets)).rejects.toThrow(
		"invalid source type",
	);
	Object.assign(clip, { sourceType: "library", sourceUrl: " " });
	await expect(createProjectBackup(project, assets)).rejects.toThrow(
		"source URL",
	);
	Object.assign(clip, { sourceUrl: "https://example.com/audio.mp3" });
	await readProjectBackup(await createProjectBackup(project, assets));
});

test("restore rejects a correctly hashed manifest with a missing clip reference", async () => {
	const { project, assets } = fixture();
	const archive = await createProjectBackup(project, assets);
	const header = new Uint8Array(await archive.slice(0, 44).arrayBuffer());
	const length = new DataView(header.buffer).getUint32(8, true);
	const manifest = JSON.parse(await archive.slice(44, 44 + length).text());
	delete manifest.project.scenes[0].tracks[0].elements[0].mediaId;
	const json = new TextEncoder().encode(JSON.stringify(manifest));
	new DataView(header.buffer).setUint32(8, json.length, true);
	header.set(new Uint8Array(await crypto.subtle.digest("SHA-256", json)), 12);
	await expect(
		readProjectBackup(new Blob([header, json, archive.slice(44 + length)])),
	).rejects.toThrow("invalid media reference");
});

test("deep compound archives fail with a supported-limit error rather than exhausting the call stack", async () => {
	const { project, assets } = fixture();
	let inner: unknown = project.scenes[0].tracks;
	for (let level = 0; level < 33; level++) {
		inner = [
			{
				id: `nested-track-${level}`,
				type: "video",
				elements: [
					{
						id: `compound-${level}`,
						type: "compound",
						startTime: 0,
						duration: 1,
						innerTracks: inner,
					},
				],
			},
		];
	}
	project.scenes[0].tracks = inner as TProject["scenes"][number]["tracks"];
	await expect(createProjectBackup(project, assets)).rejects.toThrow(
		"compound nesting",
	);
});

test("deep extension metadata fails cleanly while normal nested media references remain checked", async () => {
	const { project, assets } = fixture();
	let extension: unknown = { mediaId: "media" };
	for (let level = 0; level < 258; level++) extension = { nested: extension };
	Object.assign(project.scenes[0], { extension });
	await expect(createProjectBackup(project, assets)).rejects.toThrow(
		"metadata nesting",
	);
	Object.assign(project.scenes[0], {
		extension: { nested: { mediaId: "missing" } },
	});
	await expect(createProjectBackup(project, assets)).rejects.toThrow(
		"missing referenced media",
	);
	Object.assign(project.scenes[0], {
		extension: { nested: { mediaId: "media" } },
	});
	await readProjectBackup(await createProjectBackup(project, assets));
});

test("the supported compound-depth boundary still round trips", async () => {
	const { project, assets } = fixture();
	let inner: unknown = project.scenes[0].tracks;
	for (let level = 0; level < 32; level++) {
		inner = [
			{
				id: `boundary-track-${level}`,
				type: "video",
				elements: [
					{
						id: `boundary-compound-${level}`,
						type: "compound",
						startTime: 0,
						duration: 1,
						innerTracks: inner,
					},
				],
			},
		];
	}
	project.scenes[0].tracks = inner as TProject["scenes"][number]["tracks"];
	const restored = await readProjectBackup(
		await createProjectBackup(project, assets),
	);
	expect(restored.project.scenes).toEqual(project.scenes);
});

test("portable backup preserves display name separately from original filename and MIME", async () => {
	const { project, assets } = fixture();
	assets[0].name = "Interview";
	const restored = await readProjectBackup(await createProjectBackup(project, assets));
	expect(restored.assets[0].name).toBe("Interview");
	expect(restored.assets[0].file.name).toBe("test.mp4");
	expect(restored.assets[0].file.type).toBe("video/mp4");
	expect(await restored.assets[0].file.arrayBuffer()).toEqual(await assets[0].file.arrayBuffer());
});
