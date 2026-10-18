import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { archive, hash, original, restore } from "./support";

function signalArchive() {
	const rate = 48000,
		frames = rate * 2;
	const wav = Buffer.alloc(44 + frames * 4);
	wav.write("RIFF");
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(2, 22);
	wav.writeUInt32LE(rate, 24);
	wav.writeUInt32LE(rate * 4, 28);
	wav.writeUInt16LE(4, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(frames * 4, 40);
	for (let i = 0; i < frames; i++) {
		const time = i / rate;
		const amplitude = time < 0.5 || time >= 1.5 ? 0.001 : 0.2;
		const frequency = time >= 1 && time < 1.5 ? 6000 : 1000;
		const sample = amplitude * Math.sin(2 * Math.PI * frequency * time);
		wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 4);
		wav.writeInt16LE(Math.round(sample * 0.5 * 32767), 46 + i * 4);
	}
	const template = archive("Dynamics export fixture");
	const manifest = JSON.parse(
		template.subarray(44, 44 + template.readUInt32LE(8)).toString(),
	);
	manifest.project.metadata.duration = 2;
	manifest.project.scenes[0].tracks[0].elements[0].duration = 2;
	manifest.project.scenes[0].tracks.push({
		id: "signal-track",
		type: "audio",
		name: "Signal",
		muted: false,
		volume: 1,
		pan: 0,
		audioEffects: [
			{
				id: "gate",
				type: "noise-gate",
				enabled: true,
				params: { threshold: -30, attack: 0, release: 10 },
			},
			{
				id: "ess",
				type: "de-esser",
				enabled: true,
				params: { frequency: 6000, threshold: -30, reduction: 10 },
			},
		],
		elements: [
			{
				id: "signal",
				type: "audio",
				name: "Signal",
				sourceType: "upload",
				mediaId: "signal-media",
				startTime: 0,
				duration: 2,
				trimStart: 0,
				trimEnd: 0,
				volume: 1,
				playbackRate: 1,
			},
		],
	});
	manifest.assets.push({
		id: "signal-media",
		name: "signal.wav",
		type: "audio",
		mime: "audio/wav",
		size: wav.length,
		lastModified: 0,
		duration: 2,
		hashes: [hash(wav).toString("hex")],
	});
	const json = Buffer.from(JSON.stringify(manifest)),
		header = Buffer.alloc(44);
	header.write("OCBACK01");
	header.writeUInt32LE(json.length, 8);
	hash(json).copy(header, 12);
	return Buffer.concat([header, json, original, wav]);
}

test("browser MP4 export applies gate and de-esser with aligned stereo audio", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await restore(page, "Dynamics export fixture", signalArchive());
	await page.getByRole("button", { name: "Export", exact: true }).click();
	await page
		.getByLabel("Include OpenCut AI watermark", { exact: true })
		.uncheck();
	const downloading = page.waitForEvent("download");
	await page
		.getByRole("button", { name: "Export", exact: true })
		.last()
		.click();
	const output = await (await downloading).path();
	if (!output) throw new Error("Export download unavailable");
	const probe = JSON.parse(
		execFileSync(
			process.env.FFPROBE || "ffprobe",
			[
				"-v",
				"error",
				"-count_frames",
				"-show_streams",
				"-show_format",
				"-of",
				"json",
				output,
			],
			{ encoding: "utf8" },
		),
	);
	const video = probe.streams.find(
		(s: { codec_type: string }) => s.codec_type === "video",
	);
	const audio = probe.streams.find(
		(s: { codec_type: string }) => s.codec_type === "audio",
	);
	expect(Number(video.nb_read_frames)).toBe(60);
	expect(audio.channels).toBe(2);
	expect(Math.abs(Number(probe.format.duration) - 2)).toBeLessThan(1 / 30);
	const rate = 44100;
	const pcm = execFileSync(process.env.FFMPEG || "ffmpeg", [
		"-v",
		"error",
		"-i",
		output,
		"-vn",
		"-af",
		"aresample=async=1:first_pts=0",
		"-ar",
		String(rate),
		"-ac",
		"2",
		"-f",
		"f32le",
		"pipe:1",
	]);
	function rms(start: number, end: number, channel = 0) {
		let sum = 0;
		const first = Math.round(start * rate),
			last = Math.round(end * rate);
		for (let i = first; i < last; i++)
			sum += pcm.readFloatLE(i * 8 + channel * 4) ** 2;
		return Math.sqrt(sum / (last - first));
	}
	const quiet = rms(0.1, 0.4),
		loud = rms(0.65, 0.9),
		sibilance = rms(1.15, 1.4),
		tailNoise = rms(1.75, 1.9);
	expect(quiet).toBeLessThan(3e-5);
	expect(tailNoise).toBeLessThan(3e-5);
	expect(loud).toBeGreaterThan(0.134);
	expect(loud).toBeLessThan(0.149);
	expect(20 * Math.log10(sibilance / loud)).toBeGreaterThan(-11);
	expect(20 * Math.log10(sibilance / loud)).toBeLessThan(-9);
	expect(rms(0.65, 0.9, 1) / loud).toBeCloseTo(0.5, 1);
	let onset = 0;
	for (let ms = 450; ms < 550; ms++) {
		if (rms(ms / 1000, ms / 1000 + 0.01) > 0.02) {
			onset = ms / 1000 + 0.005;
			break;
		}
	}
	expect(Math.abs(onset - 0.5)).toBeLessThan(0.02);
	expect(errors).toEqual([]);
	await test
		.info()
		.attach("encoded-dynamics-measurements", {
			body: JSON.stringify(
				{ probe, quiet, loud, sibilance, tailNoise, onset },
				null,
				2,
			),
			contentType: "application/json",
		});
});
