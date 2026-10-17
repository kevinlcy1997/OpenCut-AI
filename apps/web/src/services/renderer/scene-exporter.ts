import { frameCountForDuration } from "@/lib/media/frame-count";
import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/types/export";
import { CanvasRenderer } from "./canvas-renderer";
import { nativeExport } from "../native/export";
import { hardwarePreference } from "./encoding";
import { prepareAudio } from "./audio-encoding";
import { VideoCache } from "../video-cache/service";

type ExportParams = {
	width: number;
	height: number;
	fps: number;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	watermark?: boolean;
	encoder?: "auto" | "browser";
	nativeAllowed?: boolean;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
	metrics: [
		metrics: {
			frames: number;
			renderMs: number;
			encodeSubmissionMs: number;
			finalizeMs: number;
			decodeMs: number;
			copySubmissionMs: number;
			effectsSubmissionMs: number;
		},
	];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private encoder: "auto" | "browser";
	private watermark: boolean;
	private nativeAllowed: boolean;
	private nativeAbort = new AbortController();

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		watermark,
		encoder = "auto",
		nativeAllowed = true,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
			watermark: watermark ?? false,
			videoCache: new VideoCache(),
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.encoder = encoder;
		this.watermark = watermark ?? false;
		this.nativeAllowed = nativeAllowed;
	}

	cancel(): void {
		this.isCancelled = true;
		this.nativeAbort.abort();
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		this.renderer.setSize({
			width: this.renderer.width,
			height: this.renderer.height,
		});
		Object.assign(this.renderer.metrics, {
			decodeMs: 0,
			copySubmissionMs: 0,
			effectsSubmissionMs: 0,
		});
		try {
			return await this.performExport({ rootNode });
		} finally {
			this.renderer.videoCache.clearAll();
			this.renderer.canvas.width = 1;
			this.renderer.canvas.height = 1;
		}
	}

	private async performExport({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const { fps } = this.renderer;
		const frameCount = frameCountForDuration(rootNode.duration, fps);
		if (
			this.encoder === "auto" &&
			this.format === "mp4" &&
			!this.watermark &&
			this.nativeAllowed
		) {
			try {
				const native = await nativeExport({
					root: rootNode,
					width: this.renderer.width,
					height: this.renderer.height,
					fps,
					quality: this.quality,
					audio: this.shouldIncludeAudio ? this.audioBuffer : undefined,
					signal: this.nativeAbort.signal,
					onProgress: (progress) => this.emit("progress", progress),
				});
				if (native) {
					this.emit("complete", native);
					return native;
				}
			} catch (error) {
				if (this.isCancelled) {
					this.emit("cancelled");
					return null;
				}
				console.warn(
					"Native export unavailable; using browser renderer",
					error,
				);
			}
		}

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		try {
			const codec = this.format === "webm" ? "vp9" : "avc";
			const videoSource = new CanvasSource(this.renderer.canvas, {
				codec,
				bitrate: qualityMap[this.quality],
				latencyMode: "quality",
				hardwareAcceleration: await hardwarePreference(
					codec,
					this.renderer.width,
					this.renderer.height,
					qualityMap[this.quality],
				),
			});

			output.addVideoTrack(videoSource, { frameRate: fps });

			let audioSource: Awaited<ReturnType<typeof prepareAudio>> | null = null;
			if (this.shouldIncludeAudio && this.audioBuffer) {
				let audioCodec: "aac" | "opus" =
					this.format === "webm" ? "opus" : "aac";

				if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
					const { supported } = await AudioEncoder.isConfigSupported({
						codec: "mp4a.40.2",
						sampleRate: this.audioBuffer.sampleRate,
						numberOfChannels: this.audioBuffer.numberOfChannels,
						bitrate: 192000,
					});
					if (!supported) audioCodec = "opus";
				}

				audioSource = await prepareAudio(
					this.audioBuffer,
					audioCodec,
					qualityMap[this.quality],
				);
				output.addAudioTrack(audioSource.source);
			}

			await output.start();

			if (audioSource && this.audioBuffer) {
				await audioSource.add();
			}

			let renderMs = 0;
			let encodeSubmissionMs = 0;
			for (let i = 0; i < frameCount; i++) {
				if (this.isCancelled) {
					await output.cancel();
					this.emit("cancelled");
					return null;
				}

				const time = i / fps;
				const renderStart = performance.now();
				await this.renderer.render({ node: rootNode, time });
				renderMs += performance.now() - renderStart;
				const encodeStart = performance.now();
				await videoSource.add(time, 1 / fps);
				encodeSubmissionMs += performance.now() - encodeStart;

				this.emit("progress", i / frameCount);
			}

			if (this.isCancelled) {
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			videoSource.close();
			const finalizeStart = performance.now();
			await output.finalize();
			this.emit("metrics", {
				frames: frameCount,
				renderMs,
				encodeSubmissionMs,
				finalizeMs: performance.now() - finalizeStart,
				...this.renderer.metrics,
			});
			this.emit("progress", 1);

			const buffer = output.target.buffer;
			if (!buffer) {
				this.emit("error", new Error("Failed to export video"));
				return null;
			}

			this.emit("complete", buffer);
			return buffer;
		} catch (error) {
			await output.cancel().catch(() => {});
			throw error;
		}
	}
}
