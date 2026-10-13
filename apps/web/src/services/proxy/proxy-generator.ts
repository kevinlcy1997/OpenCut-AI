import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	Output,
	Mp4OutputFormat,
	BufferTarget,
	CanvasSource,
	QUALITY_LOW,
} from "mediabunny";
import type { ProxyResolution } from "@/services/storage/types";
import { PROXY_PRESETS } from "@/services/storage/types";
import {
	nativeSession,
	nativeRequest,
	uploadNative,
	runNativeJob,
	releaseNative,
	type NativeCapabilities,
} from "../native/client";
import { hardwarePreference } from "../renderer/encoding";

export interface ProxyGenerateOptions {
	file: File;
	resolution: ProxyResolution;
	onProgress?: (progress: number) => void;
	signal?: AbortSignal;
	encoder?: "auto" | "browser";
}

export interface ProxyGenerateResult {
	file: File;
	width: number;
	height: number;
}

export async function generateProxy(
	options: ProxyGenerateOptions,
): Promise<ProxyGenerateResult> {
	const { file, resolution, onProgress, signal } = options;
	const preset = PROXY_PRESETS[resolution];

	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error("No video track found");

		const canDecode = await videoTrack.canDecode();
		if (!canDecode) throw new Error("Video codec not supported for decoding");

		const origWidth = videoTrack.displayWidth;
		const origHeight = videoTrack.displayHeight;
		const duration = await videoTrack.computeDuration();

		if (duration <= 0) throw new Error("Video has no duration");

		const scale = Math.min(
			preset.maxWidth / origWidth,
			preset.maxHeight / origHeight,
			1,
		);
		const proxyWidth = Math.max(2, Math.round((origWidth * scale) / 2) * 2);
		const proxyHeight = Math.max(2, Math.round((origHeight * scale) / 2) * 2);

		const stats = await videoTrack.computePacketStats();
		const fps = Math.min(stats.averagePacketRate ?? 30, 30);
		const frameCount = Math.ceil(duration * fps);
		// Hardware route is enabled only after recorded parity and speed gates.
		let session = null;
		try {
			if (options.encoder !== "browser") session = await nativeSession();
		} catch {
			/* browser fallback */
		}
		if (
			session &&
			resolution === "720p" &&
			origWidth === 3840 &&
			origHeight === 2160 &&
			Math.abs(fps - 30) < 0.001 &&
			Math.abs(duration * fps - Math.round(duration * fps)) < 0.0001
		) {
			const ids: string[] = [];
			try {
				const capabilities: NativeCapabilities = await (
					await nativeRequest(session, "/capabilities", {
						signal: options.signal,
					})
				).json();
				if (
					capabilities.automatic.proxy &&
					capabilities.validated_browser?.proxy === navigator.userAgent
				) {
					const id = await uploadNative(session, file, options.signal);
					ids.push(id);
					const blob = await runNativeJob(
						session,
						{
							kind: "proxy",
							validated_profile: "4k-sdr-30fps",
							clips: [{ asset_id: id, start: 0, duration }],
							width: Math.max(2, Math.round(proxyWidth / 2) * 2),
							height: Math.max(2, Math.round(proxyHeight / 2) * 2),
							fps,
							bitrate: 2_000_000,
						},
						options.onProgress,
						options.signal,
					);
					return {
						file: new File([blob], `${file.name}.proxy.mp4`, {
							type: "video/mp4",
						}),
						width: Math.max(2, Math.round(proxyWidth / 2) * 2),
						height: Math.max(2, Math.round(proxyHeight / 2) * 2),
					};
				}
			} catch (error) {
				if (options.signal?.aborted) throw error;
				console.warn("Native proxy unavailable; using browser encoder", error);
			} finally {
				await releaseNative(session, ids);
			}
		}

		const canvas = document.createElement("canvas");
		canvas.width = proxyWidth;
		canvas.height = proxyHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Proxy canvas context unavailable");

		const sink = new CanvasSink(videoTrack, {
			poolSize: 2,
			fit: "contain",
		});

		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const videoSource = new CanvasSource(canvas, {
			codec: "avc",
			bitrate: QUALITY_LOW,
			latencyMode: "quality",
			hardwareAcceleration: await hardwarePreference(
				"avc",
				proxyWidth,
				proxyHeight,
				QUALITY_LOW,
			),
		});

		output.addVideoTrack(videoSource, { frameRate: fps });
		await output.start();

		const iterator = sink.canvases(0);
		let framesProcessed = 0;

		try {
			for await (const frame of iterator) {
				if (signal?.aborted) {
					await output.cancel();
					throw new Error("Proxy generation cancelled");
				}

				if (ctx) {
					ctx.clearRect(0, 0, proxyWidth, proxyHeight);
					ctx.drawImage(frame.canvas, 0, 0, proxyWidth, proxyHeight);
				}

				await videoSource.add(frame.timestamp, frame.duration);

				framesProcessed++;
				if (onProgress && framesProcessed % 5 === 0) {
					onProgress(Math.min(framesProcessed / frameCount, 0.99));
				}

				if (frame.timestamp >= duration - frame.duration) break;
			}
		} finally {
			try {
				await iterator.return();
			} catch {}
		}

		videoSource.close();
		await output.finalize();

		const buffer = output.target.buffer;
		if (!buffer) throw new Error("Failed to generate proxy");

		const proxyFile = new File([buffer], `proxy_${file.name}`, {
			type: "video/mp4",
		});

		onProgress?.(1);

		return { file: proxyFile, width: proxyWidth, height: proxyHeight };
	} finally {
		input.dispose();
	}
}
