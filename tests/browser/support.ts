import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Synthetic originals only; Playwright's fresh context never shares the user's profile.
export const original = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
);
export const hash = (value: Buffer) => createHash("sha256").update(value).digest();
const versionSource = readFileSync(
	"apps/web/src/services/storage/migrations/index.ts",
	"utf8",
);
const version = Number(
	versionSource.match(/CURRENT_PROJECT_VERSION = (\d+)/)?.[1],
);
if (!version) throw new Error("Project version unavailable");

export function archive(name: string, brokenReference = false) {
	const date = "2026-10-18T00:00:00.000Z";
	const clip: Record<string, unknown> = {
		id: "fixture-clip",
		name: "Synthetic card",
		type: "image",
		mediaId: "fixture-media",
		startTime: 0,
		duration: 1,
		trimStart: 0,
		trimEnd: 0,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotation: 0 },
		opacity: 1,
	};
	if (brokenReference) delete clip.mediaId;
	const manifest = {
		format: 1,
		project: {
			version,
			metadata: {
				id: "fixture-project",
				name,
				duration: 1,
				createdAt: date,
				updatedAt: date,
			},
			currentSceneId: "fixture-scene",
			settings: {
				fps: 30,
				canvasSize: { width: 320, height: 180 },
				background: { type: "color", color: "#000000" },
			},
			scenes: [
				{
					id: "fixture-scene",
					name: "Main scene",
					createdAt: date,
					updatedAt: date,
					isMain: true,
					bookmarks: [],
					markers: [],
					tracks: [
						{
							id: "fixture-track",
							type: "video",
							name: "Main Track",
							isMain: true,
							muted: false,
							hidden: false,
							elements: [clip],
						},
					],
				},
			],
		},
		assets: [
			{
				id: "fixture-media",
				name: "fixture.svg",
				type: "image",
				mime: "image/svg+xml",
				size: original.length,
				lastModified: 0,
				width: 16,
				height: 16,
				hashes: [hash(original).toString("hex")],
			},
		],
	};
	const json = Buffer.from(JSON.stringify(manifest));
	const header = Buffer.alloc(44);
	header.write("OCBACK01");
	header.writeUInt32LE(json.length, 8);
	hash(json).copy(header, 12);
	return Buffer.concat([header, json, original]);
}

let uploadSequence = 0;
export async function uploadBackup(page: Page, data: Buffer) {
	const path = test.info().outputPath(`fixture-${++uploadSequence}.ocbackup`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
	await page
		.getByLabel("Project backup file", { exact: true })
		.setInputFiles(path);
}

export async function restore(page: Page, name: string, data: Buffer = archive(name)) {
	await page.goto("/projects");
	await expect(
		page.getByRole("button", { name: "Restore project backup", exact: true }),
	).toBeVisible();
	await uploadBackup(page, data);
	await expect(page).toHaveURL(/\/editor\/[a-zA-Z0-9_-]+$/);
	await expect(page.locator("input[readonly]")).toHaveValue(
		`${name} (restored)`,
	);
	const welcome = page.getByRole("dialog", {
		name: "Welcome to OpenCut AI",
		exact: true,
	});
	await expect(welcome).toBeVisible();
	await welcome.getByRole("button", { name: "Close", exact: true }).click();
	await expect(welcome).toBeHidden();
	return page.url();
}
export async function settings(page: Page) {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Download project backup", exact: true }),
	).toBeVisible();
}
export async function inspectDownloadedBackup(page: Page, expectedOriginals: Buffer[] = [original]) {
	const download = page.waitForEvent("download");
	await page
		.getByRole("button", { name: "Download project backup", exact: true })
		.click();
	const path = await (await download).path();
	if (!path) throw new Error("No backup download");
	const bytes = readFileSync(path);
	const length = bytes.readUInt32LE(8);
	const json = bytes.subarray(44, 44 + length);
	expect(hash(json)).toEqual(bytes.subarray(12, 44));
	const manifest = JSON.parse(json.toString());
	const remaining = [...expectedOriginals];
	let cursor = 44 + length;
	for (const asset of manifest.assets) {
		const stored = bytes.subarray(cursor, cursor + asset.size);
		const index = remaining.findIndex((expected) => expected.equals(stored));
		expect(index).toBeGreaterThanOrEqual(0);
		remaining.splice(index, 1);
		expect(asset.hashes).toEqual([hash(stored).toString("hex")]);
		cursor += asset.size;
	}
	expect(remaining).toHaveLength(0);
	expect(cursor).toBe(bytes.length);
	return manifest;
}

