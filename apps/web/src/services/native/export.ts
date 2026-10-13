import type { RootNode } from "../renderer/nodes/root-node";
import { VideoNode } from "../renderer/nodes/video-node";
import { ColorNode } from "../renderer/nodes/color-node";
import type { ExportQuality } from "@/types/export";
import {
	nativeSession,
	nativeRequest,
	uploadNative,
	runNativeJob,
	releaseNative,
	type NativeCapabilities,
} from "./client";

export function eligibleNativeClips(
	root: RootNode,
	fps: number,
): VideoNode[] | null {
	const videos: VideoNode[] = [];
	for (const [index, node] of root.children.entries()) {
		if (
			index === 0 &&
			node instanceof ColorNode &&
			!node.children.length &&
			["black", "#000", "#000000"].includes(node.params.color.toLowerCase())
		)
			continue;
		if (!(node instanceof VideoNode) || node.children.length) return null;
		const p = node.params;
		if (
			(p.effects?.length ?? 0) > 0 ||
			(p.animations && Object.keys(p.animations).length > 0) ||
			(p.playbackRate ?? 1) !== 1 ||
			p.opacity !== 1 ||
			(p.blendMode && p.blendMode !== "normal") ||
			p.transform.scale !== 1 ||
			p.transform.rotate !== 0 ||
			p.transform.position.x !== 0 ||
			p.transform.position.y !== 0 ||
			Math.abs(p.duration * fps - Math.round(p.duration * fps)) > 0.0001
		)
			return null;
		videos.push(node);
	}
	videos.sort((a, b) => a.params.timeOffset - b.params.timeOffset);
	let end = 0;
	for (const video of videos) {
		if (Math.abs(video.params.timeOffset - end) > 0.000001) return null;
		end += video.params.duration;
	}
	return videos.length && Math.abs(end - root.duration) < 0.000001
		? videos
		: null;
}

export function audioWav(audio: AudioBuffer): Blob {
	const channels = audio.numberOfChannels;
	const length = audio.length * channels * 2;
	const buffer = new ArrayBuffer(44 + length);
	const view = new DataView(buffer);
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++)
			view.setUint8(offset + i, value.charCodeAt(i));
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + length, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, audio.sampleRate, true);
	view.setUint32(28, audio.sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, length, true);
	const samples = Array.from({ length: channels }, (_, i) =>
		audio.getChannelData(i),
	);
	let offset = 44;
	for (let i = 0; i < audio.length; i++)
		for (let channel = 0; channel < channels; channel++) {
			const sample = Math.max(-1, Math.min(1, samples[channel][i]));
			view.setInt16(
				offset,
				Math.round(sample * (sample < 0 ? 32768 : 32767)),
				true,
			);
			offset += 2;
		}
	return new Blob([buffer], { type: "audio/wav" });
}

export async function nativeExport(options: {
	root: RootNode;
	width: number;
	height: number;
	fps: number;
	quality: ExportQuality;
	audio?: AudioBuffer;
	signal: AbortSignal;
	onProgress: (progress: number) => void;
}): Promise<ArrayBuffer | null> {
	const clips = eligibleNativeClips(options.root, options.fps);
	if (!clips) return null;
	const session = await nativeSession();
	if (!session) return null;
	const capabilities: NativeCapabilities = await (
		await nativeRequest(session, "/capabilities", { signal: options.signal })
	).json();
	if (!capabilities.automatic.export) return null;
	const ids: string[] = [];
	try {
		const map = new Map<File, string>();
		for (const clip of clips)
			if (!map.has(clip.params.file)) {
				const id = await uploadNative(
					session,
					clip.params.file,
					options.signal,
				);
				ids.push(id);
				map.set(clip.params.file, id);
			}
		const audioId = options.audio
			? await uploadNative(session, audioWav(options.audio), options.signal)
			: undefined;
		if (audioId) ids.push(audioId);
		const rates = {
			low: 3_000_000,
			medium: 5_000_000,
			high: 8_000_000,
			very_high: 12_000_000,
		};
		const output = await runNativeJob(
			session,
			{
				kind: "export",
				width: options.width,
				height: options.height,
				fps: options.fps,
				bitrate: Math.round(
					rates[options.quality] *
						Math.max(1, (options.width * options.height) / (1920 * 1080)),
				),
				clips: clips.map((clip) => ({
					asset_id: map.get(clip.params.file),
					start: clip.params.trimStart,
					duration: clip.params.duration,
				})),
				audio_asset_id: audioId,
			},
			options.onProgress,
			options.signal,
		);
		return output.arrayBuffer();
	} finally {
		await releaseNative(session, ids);
	}
}
