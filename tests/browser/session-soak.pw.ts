import { expect, test } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { restore, settings } from "./support";

const enabled = process.env.OPENCUT_SESSION_SOAK_MINUTES !== undefined;
test("sustained mixed-media editing and native AI session", async ({ page, request }) => {
	test.skip(!enabled, "Opt-in native Mac stability run; requires prepared mixed-media archive and AI services");
	const minutes = Number(process.env.OPENCUT_SESSION_SOAK_MINUTES);
	const warmupMinutes = Number(process.env.OPENCUT_SESSION_WARMUP_MINUTES ?? "2");
	if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(warmupMinutes) || warmupMinutes < 0) throw new Error("Invalid soak duration");
	test.setTimeout((minutes + warmupMinutes + 10) * 60_000);
	const archive = readFileSync(resolve(process.env.OPENCUT_SESSION_BACKUP ?? "../../outputs/mixed-media-fixture.ocbackup"));
	const manifest = JSON.parse(archive.subarray(44, 44 + archive.readUInt32LE(8)).toString());
	const speech = readFileSync(resolve(process.env.OPENCUT_SESSION_SPEECH ?? ".mac-runtime/fixtures/speech-two-speakers-600s.wav"));
	const token = readFileSync(".mac-runtime/token", "utf8").trim();
	const headers = { Authorization: `Bearer ${token}` };
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const memoryPath = test.info().outputPath("session-memory.jsonl");
	const reportPath = test.info().outputPath("session-report.json");
	const sampler = spawn(resolve("services/ai-backend/.venv/bin/python"), ["tests/browser/session-memory.py", "--parent", String(process.pid), "--state", resolve(".mac-runtime"), "--output", memoryPath], { stdio: ["ignore", "ignore", "pipe"] });
	let samplerFailure = "";
	sampler.stderr.on("data", (chunk) => { samplerFailure += chunk.toString(); });
	const samplerDone = new Promise<void>((resolveDone, reject) => {
		sampler.once("error", reject);
		sampler.once("exit", (code) => code === 0 ? resolveDone() : reject(new Error(`Memory sampler exited ${code}: ${samplerFailure}`)));
	});
	// Observe rejection immediately while preserving it for the final await.
	void samplerDone.catch(() => {});
	const operations: { kind: string; passed: boolean; seconds: number; detail?: string }[] = [];
	const start = Date.now();
	const measuredStart = start + warmupMinutes * 60_000;
	const stop = measuredStart + minutes * 60_000;
	let cycles = 0;
	try {
		await restore(page, manifest.project.metadata.name, archive);
		while (Date.now() < stop) {
			const cycleStart = Date.now();
			await page.getByTitle("Click to edit time", { exact: true }).click();
			const timeInput = page.getByPlaceholder(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
			await timeInput.fill("00:00:00:00");
			await timeInput.press("Enter");
			await page.getByRole("button", { name: "Play", exact: true }).click();
			await expect(page.getByTitle("Click to edit time", { exact: true })).not.toHaveText("00:00:00:00");
			// Native work overlaps actual timeline playback, one heavy AI request at a time.
			for (const kind of ["transcribe", "llm", "image"] as const) {
				const began = Date.now();
				try {
					let response;
					if (kind === "transcribe") response = await request.post("http://127.0.0.1:8421/transcribe", { headers, multipart: { file: { name: "speech.wav", mimeType: "audio/wav", buffer: speech }, language: "en" }, timeout: 180_000 });
					else if (kind === "llm") response = await request.post("http://127.0.0.1:11435/api/generate", { headers, data: { model: "qwen2.5:0.5b", stream: false, prompt: "Give one concise video editing tip.", options: { num_predict: 32, num_ctx: 2048, temperature: 0 } }, timeout: 180_000 });
					else {
						const load = await request.post("http://127.0.0.1:8423/load?model_name=segmind%2Ftiny-sd", { headers, timeout: 180_000 });
						if (!load.ok()) throw new Error(`Image load ${load.status()}: ${(await load.text()).slice(0, 500)}`);
						response = await request.post("http://127.0.0.1:8423/generate", { headers, data: { prompt: "A ceramic teapot beside a window", steps: 20, seed: 42, width: 512, height: 512 }, timeout: 180_000 });
					}
					if (!response.ok()) throw new Error(`HTTP ${response.status()}: ${(await response.text()).slice(0, 500)}`);
					operations.push({ kind, passed: true, seconds: (Date.now() - began) / 1000 });
					await response.dispose();
				} catch (error) { operations.push({ kind, passed: false, seconds: (Date.now() - began) / 1000, detail: String(error) }); }
			}
			if (await page.getByRole("button", { name: "Pause", exact: true }).isVisible()) await page.getByRole("button", { name: "Pause", exact: true }).click();
			// Seek through the visible timecode, edit via the action-backed toolbar, undo,
			// then export/download and reopen the saved mixed video/image/audio project.
			await page.getByTitle("Click to edit time", { exact: true }).click();
			await timeInput.fill("00:00:00:15");
			await timeInput.press("Enter");
			await page.keyboard.press("ControlOrMeta+a");
			await page.getByRole("button", { name: "Split element", exact: true }).click();
			await page.getByRole("button", { name: "Undo (Ctrl+Z)", exact: true }).click();
			await page.getByRole("button", { name: "Export", exact: true }).click();
			await page.getByLabel("Include OpenCut AI watermark", { exact: true }).uncheck();
			const download = page.waitForEvent("download", { timeout: 180_000 });
			await page.getByRole("button", { name: "Export", exact: true }).last().click();
			const path = await (await download).path();
			if (!path) throw new Error("No exported video");
			const probe = JSON.parse(execFileSync(process.env.FFPROBE || "ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }));
			const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
			expect(Number(video.nb_read_frames)).toBe(Math.round(manifest.project.metadata.duration * manifest.project.settings.fps));
			expect(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
			await settings(page);
			const saved = page.waitForEvent("download");
			await page.getByRole("button", { name: "Download project backup", exact: true }).click();
			await saved;
			await page.reload();
			await expect(page.locator("input[readonly]")).toHaveValue(`${manifest.project.metadata.name} (restored)`);
			operations.push({ kind: "editing_playback_export_reload", passed: true, seconds: (Date.now() - cycleStart) / 1000 });
			cycles++;
			writeFileSync(reportPath, JSON.stringify({ complete: false, cycles, operations, errors, elapsed_seconds: (Date.now() - start) / 1000 }, null, 2));
		}
	} finally {
		sampler.kill("SIGTERM");
		await samplerDone;
		const samples = readFileSync(memoryPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const first = samples[0];
		const measured = first ? samples.filter((s) => s.monotonic - first.monotonic >= warmupMinutes * 60) : [];
		const baseline = measured[0];
		const swapGrowth = baseline ? Math.max(...measured.map((s) => s.swap_bytes - baseline.swap_bytes)) : Infinity;
		const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
		const quarter = Math.max(1, Math.floor(measured.length / 4));
		const retained = (s: { browser_rss_bytes: number; native_rss_bytes: number }) => s.browser_rss_bytes + s.native_rss_bytes;
		const early = median(measured.slice(0, quarter).map(retained));
		const late = median(measured.slice(-quarter).map(retained));
		const checks = {
			duration: minutes >= 30 && Date.now() - measuredStart >= 1_800_000,
			ai_coverage: ["transcribe", "llm", "image"].every((kind) => operations.some((operation) => operation.kind === kind && operation.passed)),
			all_operations_passed: operations.length > 0 && operations.every((operation) => operation.passed),
			repeated_editing: cycles >= 10,
			no_page_errors: errors.length === 0,
			memory_observed: measured.length > 0 && measured.every((s) => s.browser_processes > 0 && s.errors.length === 0),
			post_warmup_swap: swapGrowth <= 1024 ** 3,
		};
		const report = { checks, mixed_session_checks_passed: Object.values(checks).every(Boolean), first_quarter_median_process_rss_bytes: early, last_quarter_median_process_rss_bytes: late, process_rss_growth_bytes: early !== null && late !== null ? late - early : null, complete: Date.now() >= stop, measured_minutes: minutes, warmup_minutes: warmupMinutes, elapsed_seconds: (Date.now() - start) / 1000, cycles, operations, errors, memory_samples: samples.length, peak_post_warmup_swap_growth_bytes: swapGrowth, sampler_errors: samples.flatMap((s) => s.errors), browser_memory_observed: measured.length > 0 && measured.every((s) => s.browser_processes > 0), scope: `Mixed ${manifest.project.metadata.duration}-second ${manifest.project.settings.canvasSize.width}x${manifest.project.settings.canvasSize.height} video/image/audio fixture; process RSS includes browser GPU process, not independent GPU allocation or system-wide Docker memory; no audible-output verification`, full_stability_acceptance_passed: false };
		writeFileSync(reportPath, JSON.stringify(report, null, 2));
		await test.info().attach("session-report", { path: reportPath, contentType: "application/json" });
		await test.info().attach("session-memory", { path: memoryPath, contentType: "application/x-ndjson" });
	}
	expect(errors).toEqual([]);
	expect(operations.every((operation) => operation.passed)).toBe(true);
});
