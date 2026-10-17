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
		await expect(createProjectBackup(project, assets)).rejects.toThrow("Duplicate media ID");
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
