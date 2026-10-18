import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const uncaughtErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	uncaughtErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
	expect(uncaughtErrors.get(page)).toEqual([]);
});

// Synthetic originals only; Playwright's fresh context never shares the user's profile.
const original = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
);
const hash = (value: Buffer) => createHash("sha256").update(value).digest();
const versionSource = readFileSync(
	"apps/web/src/services/storage/migrations/index.ts",
	"utf8",
);
const version = Number(
	versionSource.match(/CURRENT_PROJECT_VERSION = (\d+)/)?.[1],
);
if (!version) throw new Error("Project version unavailable");

function archive(name: string, brokenReference = false) {
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
async function uploadBackup(page: Page, data: Buffer) {
	const path = test.info().outputPath(`fixture-${++uploadSequence}.ocbackup`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
	await page
		.getByLabel("Project backup file", { exact: true })
		.setInputFiles(path);
}

async function restore(page: Page, name: string) {
	await page.goto("/projects");
	await expect(
		page.getByRole("button", { name: "Restore project backup", exact: true }),
	).toBeVisible();
	await uploadBackup(page, archive(name));
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
async function settings(page: Page) {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Download project backup", exact: true }),
	).toBeVisible();
}
async function inspectDownloadedBackup(page: Page) {
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
	expect(bytes.subarray(44 + length)).toEqual(original);
	return JSON.parse(json.toString());
}

test("real IndexedDB/OPFS restore survives reload and backup preserves originals", async ({
	page,
}) => {
	const url = await restore(page, "Durable storage fixture");
	await page.reload();
	await expect(page.locator("input[readonly]")).toHaveValue(
		"Durable storage fixture (restored)",
	);
	await settings(page);
	const saved = await inspectDownloadedBackup(page);
	expect(saved.project.metadata.id).toBe(url.split("/").pop());
	expect(saved.project.scenes[0].tracks[0].elements[0].duration).toBe(1);
	expect(saved.assets[0].hashes).toEqual([hash(original).toString("hex")]);
});

test("correctly hashed malformed archive is rejected without replacing the open project", async ({
	page,
}) => {
	const url = await restore(page, "Preserved fixture");
	await settings(page);
	await uploadBackup(page, archive("Broken fixture", true));
	await expect(
		page.getByText("Backup clip has an invalid media reference", {
			exact: true,
		}),
	).toBeVisible();
	expect(page.url()).toBe(url);
	const saved = await inspectDownloadedBackup(page);
	expect(saved.project.metadata.name).toBe("Preserved fixture (restored)");
	await page.reload();
	await expect(page.locator("input[readonly]")).toHaveValue(
		"Preserved fixture (restored)",
	);
});

test("real browser write quota failure preserves the project and recovers its journal before retry", async ({
	page,
	context,
}) => {
	const url = await restore(page, "Quota original");
	await settings(page);
	const cdp = await context.newCDPSession(page);
	try {
		await cdp.send("Storage.overrideQuotaForOrigin", {
			origin: "http://127.0.0.1:3000",
			quotaSize: 1,
		});
		const quota = await cdp.send("Storage.getUsageAndQuota", {
			origin: "http://127.0.0.1:3000",
		});
		expect(quota.quota).toBe(1);
		const estimate = await page.evaluate(() => navigator.storage.estimate());
		// Chromium's optimistic estimate does not reflect this effective quota.
		// Prove that we exercise a real write failure, not just admission refusal.
		expect(estimate.quota).toBeGreaterThan(quota.quota);
		await test.info().attach("browser-quota-observation", {
			body: JSON.stringify({ quota, estimate }),
			contentType: "application/json",
		});
		await uploadBackup(page, archive("Quota retry"));
		await expect(
			page.getByText(
				"Restore failed and temporary media cleanup failed. Browser storage may still contain incomplete restore data; your existing projects are unchanged.",
				{ exact: true },
			),
		).toBeVisible();
		expect(page.url()).toBe(url);
	} finally {
		await cdp.send("Storage.overrideQuotaForOrigin", {
			origin: "http://127.0.0.1:3000",
		});
		await cdp.detach();
	}
	const preserved = await inspectDownloadedBackup(page);
	expect(preserved.project.metadata.id).toBe(url.split("/").pop());
	expect(preserved.project.metadata.name).toBe("Quota original (restored)");
	await page.goto("/projects");
	await expect(
		page.getByRole("heading", {
			name: "Quota original (restored)",
			exact: true,
		}),
	).toBeVisible();
	await expect(page.locator('main a[href^="/editor/"]')).toHaveCount(1);
	const journalKeys = await page.evaluate(
		() =>
			new Promise<IDBValidKey[]>((resolve, reject) => {
				const request = indexedDB.open("video-editor-restore-journal", 1);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const transaction = db.transaction("restores", "readonly");
					const keys = transaction.objectStore("restores").getAllKeys();
					transaction.oncomplete = () => {
						db.close();
						resolve(keys.result);
					};
					transaction.onabort = () => {
						db.close();
						reject(transaction.error);
					};
				};
			}),
	);
	expect(journalKeys).toEqual([]);
	const remainingOriginals = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const files: string[] = [];
		for await (const [name, entry] of root.entries()) {
			if (!name.startsWith("media-files-") || entry.kind !== "directory")
				continue;
			for await (const [fileName, file] of (
				entry as FileSystemDirectoryHandle
			).entries()) {
				if (file.kind === "file") files.push(`${name}/${fileName}`);
			}
		}
		return files.sort();
	});
	expect(remainingOriginals).toEqual([
		`media-files-${url.split("/").pop()}/fixture-media`,
	]);
	await uploadBackup(page, archive("Quota retry"));
	await expect(page.locator("input[readonly]")).toHaveValue(
		"Quota retry (restored)",
	);
	expect(page.url()).not.toBe(url);
});

test("missing OPFS original blocks loading and reconnect restores the same project", async ({
	page,
}) => {
	const url = await restore(page, "Reconnect fixture");
	const projectId = url.split("/").pop();
	if (!projectId) throw new Error("No restored project ID");
	// Deliberate fault in this test's fresh context, never the user's browser profile.
	await page.evaluate(async (id) => {
		const root = await navigator.storage.getDirectory();
		const directory = await root.getDirectoryHandle(`media-files-${id}`);
		await directory.removeEntry("fixture-media");
	}, projectId);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Reconnect original files", exact: true }),
	).toBeVisible();
	expect(page.url()).toBe(url);
	await page
		.getByLabel("Reconnect original files", { exact: true })
		.setInputFiles({
			name: "fixture.svg",
			mimeType: "image/svg+xml",
			buffer: original,
		});
	await expect(page.locator("input[readonly]")).toHaveValue(
		"Reconnect fixture (restored)",
	);
	expect(page.url()).toBe(url);
	await settings(page);
	const saved = await inspectDownloadedBackup(page);
	expect(saved.project.metadata.id).toBe(projectId);
	expect(saved.assets[0].hashes).toEqual([hash(original).toString("hex")]);
});

async function restoreJournalKeys(page: Page) {
	return page.evaluate(
		() =>
			new Promise<IDBValidKey[]>((resolve, reject) => {
				const request = indexedDB.open("video-editor-restore-journal", 1);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction("restores", "readonly");
					const keys = tx.objectStore("restores").getAllKeys();
					tx.oncomplete = () => {
						db.close();
						resolve(keys.result);
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error);
					};
				};
			}),
	);
}
async function originalPaths(page: Page) {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const files: string[] = [];
		for await (const [name, entry] of root.entries()) {
			if (!name.startsWith("media-files-") || entry.kind !== "directory")
				continue;
			for await (const [fileName, file] of (
				entry as FileSystemDirectoryHandle
			).entries()) {
				if (file.kind === "file") files.push(`${name}/${fileName}`);
			}
		}
		return files.sort();
	});
}

test("renderer crash after a staged original commit recovers abandoned restore without touching the existing project", async ({
	page,
	context,
}) => {
	const originalUrl = await restore(page, "Crash original");
	const originalId = originalUrl.split("/").pop();
	await settings(page);
	// Pause only this test realm after the actual OPFS close commits bytes. The
	// subsequent real renderer crash prevents app catch/finally cleanup running.
	await page.evaluate(() => {
		const close = FileSystemWritableFileStream.prototype.close;
		FileSystemWritableFileStream.prototype.close = async function () {
			await close.call(this);
			(
				window as unknown as { stagedOriginalCommitted: boolean }
			).stagedOriginalCommitted = true;
			await new Promise<void>(() => {});
		};
	});
	await uploadBackup(page, archive("Interrupted fixture"));
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { stagedOriginalCommitted?: boolean })
						.stagedOriginalCommitted,
			),
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Processing backup…", exact: true }),
	).toBeVisible();
	const pending = await restoreJournalKeys(page);
	expect(pending).toHaveLength(1);
	expect(pending[0]).not.toBe(originalId);
	const stagedPaths = await originalPaths(page);
	expect(stagedPaths).toEqual(
		[
			`media-files-${originalId}/fixture-media`,
			`media-files-${String(pending[0])}/fixture-media`,
		].sort(),
	);
	const stagedBytes = await page.evaluate(async (id) => {
		const root = await navigator.storage.getDirectory();
		const directory = await root.getDirectoryHandle(`media-files-${id}`);
		return Array.from(
			new Uint8Array(
				await (
					await (await directory.getFileHandle("fixture-media")).getFile()
				).arrayBuffer(),
			),
		);
	}, String(pending[0]));
	expect(Buffer.from(stagedBytes)).toEqual(original);
	const cdp = await context.newCDPSession(page);
	const crashed = page.waitForEvent("crash");
	// The crashed renderer cannot reply to this command; wait for its event.
	void cdp.send("Page.crash").catch(() => {});
	await crashed;
	await page.close();
	const recovery = await context.newPage();
	recovery.on("pageerror", (error) =>
		uncaughtErrors.get(page)?.push(error.message),
	);
	try {
		await recovery.goto("/projects");
		await expect(
			recovery.getByRole("heading", {
				name: "Crash original (restored)",
				exact: true,
			}),
		).toBeVisible();
		await expect(recovery.locator('main a[href^="/editor/"]')).toHaveCount(1);
		expect(await restoreJournalKeys(recovery)).toEqual([]);
		expect(await originalPaths(recovery)).toEqual([
			`media-files-${originalId}/fixture-media`,
		]);
		await recovery.goto(originalUrl);
		await expect(recovery.locator("input[readonly]")).toHaveValue(
			"Crash original (restored)",
		);
		await settings(recovery);
		const preserved = await inspectDownloadedBackup(recovery);
		expect(preserved.project.metadata.id).toBe(originalId);
		expect(preserved.project.metadata.name).toBe("Crash original (restored)");
		await uploadBackup(recovery, archive("Crash retry"));
		await expect(recovery.locator("input[readonly]")).toHaveValue(
			"Crash retry (restored)",
		);
		expect(recovery.url()).not.toBe(originalUrl);
		await recovery.screenshot({
			path: test.info().outputPath("renderer-crash-recovered.png"),
		});
	} finally {
		await recovery.close();
	}
});

test("a second browser tab cannot edit an owned project and recovers it after the owner closes", async ({ page, context }) => {
	const url = await restore(page, "Exclusive editor fixture");
	const second = await context.newPage();
	second.on("pageerror", (error) => uncaughtErrors.get(page)?.push(error.message));
	try {
		await second.goto(url);
		await expect(second.getByText("This project is open in another tab. Close it there, then retry here.", { exact: true })).toBeVisible();
		await expect(second.getByRole("button", { name: "Retry loading project", exact: true })).toBeVisible();
		await expect(second.getByRole("button", { name: "Export", exact: true })).toHaveCount(0);
		const locks = await second.evaluate(async () => (await navigator.locks.query()).held?.filter((lock) => lock.name?.startsWith("opencut-project:")));
		expect(locks).toHaveLength(1);
		expect(locks?.[0].name).toBe(`opencut-project:${url.split("/").pop()}`);
		await page.close();
		await second.getByRole("button", { name: "Retry loading project", exact: true }).click();
		await expect(second.locator("input[readonly]")).toHaveValue("Exclusive editor fixture (restored)");
		const welcome = second.getByRole("dialog", { name: "Welcome to OpenCut AI", exact: true });
		if (await welcome.isVisible()) await welcome.getByRole("button", { name: "Close", exact: true }).click();
		await settings(second);
		const saved = await inspectDownloadedBackup(second);
		expect(saved.project.metadata.id).toBe(url.split("/").pop());
		expect(saved.project.scenes[0].tracks[0].elements[0].duration).toBe(1);
	} finally {
		await second.close();
	}
});


test("restored project exports a downloadable video with exact frame count and visible original", async ({ page }) => {
	await restore(page, "Browser export fixture");
	await page.getByRole("button", { name: "Export", exact: true }).click();
	await page.getByLabel("Include OpenCut AI watermark", { exact: true }).uncheck();
	const downloaded = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export", exact: true }).last().click();
	const output = await (await downloaded).path();
	if (!output) throw new Error("Video download unavailable");
	const probe = JSON.parse(execFileSync(process.env.FFPROBE || "ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", output], { encoding: "utf8" }));
	const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
	expect(video.width).toBe(320);
	expect(video.height).toBe(180);
	expect(Number(video.nb_read_frames)).toBe(30);
	expect(Math.abs(Number(probe.format.duration) - 1)).toBeLessThan(1 / 30);
	const pixel = execFileSync(process.env.FFMPEG || "ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=2:2:159:89,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
	expect(pixel.length).toBe(3);
	expect(pixel[0]).toBeGreaterThan(220);
	expect(pixel[1]).toBeLessThan(30);
	expect(pixel[2]).toBeLessThan(30);
	await test.info().attach("encoded-video-probe", { body: JSON.stringify(probe, null, 2), contentType: "application/json" });
});


test("split undo redo persist through production save and reopen", async ({ page }) => {
	const url = await restore(page, "Editing history fixture");
	const undo = page.getByRole("button", { name: "Undo (Ctrl+Z)", exact: true });
	const redo = page.getByRole("button", { name: "Redo (Ctrl+Shift+Z)", exact: true });
	await expect(undo).toBeDisabled();
	await expect(redo).toBeDisabled();
	await page.getByTitle("Click to edit time", { exact: true }).click();
	await page.getByPlaceholder("00:00:00:00", { exact: true }).fill("00:00:00:15");
	await page.getByPlaceholder("00:00:00:00", { exact: true }).press("Enter");
	await expect(page.getByTitle("Click to edit time", { exact: true })).toHaveText("00:00:00:15");
	await page.keyboard.press("ControlOrMeta+a");
	await page.getByRole("button", { name: "Split element", exact: true }).click();
	await expect(undo).toBeEnabled();
	await settings(page);
	let saved = await inspectDownloadedBackup(page);
	let clips = saved.project.scenes[0].tracks[0].elements;
	expect(clips).toHaveLength(2);
	expect(clips.map((clip: { startTime: number; duration: number }) => [clip.startTime, clip.duration])).toEqual([[0, .5], [.5, .5]]);
	await page.keyboard.press("Escape");
	await undo.click();
	await expect(redo).toBeEnabled();
	await settings(page);
	saved = await inspectDownloadedBackup(page);
	expect(saved.project.scenes[0].tracks[0].elements).toHaveLength(1);
	await page.keyboard.press("Escape");
	await redo.click();
	await expect(redo).toBeDisabled();
	await settings(page);
	saved = await inspectDownloadedBackup(page);
	expect(saved.project.scenes[0].tracks[0].elements).toHaveLength(2);
	await page.reload();
	await expect(page.locator("input[readonly]")).toHaveValue("Editing history fixture (restored)");
	await settings(page);
	saved = await inspectDownloadedBackup(page);
	expect(saved.project.metadata.id).toBe(url.split("/").pop());
	clips = saved.project.scenes[0].tracks[0].elements;
	expect(clips.map((clip: { startTime: number; duration: number }) => [clip.startTime, clip.duration])).toEqual([[0, .5], [.5, .5]]);
});
