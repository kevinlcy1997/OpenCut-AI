import {
	checkExportCancellation,
	fetchAudioBytes,
} from "./export-cancellation";
import type { ElementAnimations } from "@/types/animation";
import {
	renderTimelineAudio,
	type DecodedTimelineAudio,
} from "./offline-audio";
import type {
	AudioElement,
	LibraryAudioElement,
	TimelineElement,
	TimelineTrack,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { canElementHaveAudio } from "@/lib/timeline/element-utils";
import { canTracktHaveAudio } from "@/lib/timeline";
import { mediaSupportsAudio } from "@/lib/media/media-utils";
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;

export type CollectedAudioElement = DecodedTimelineAudio;

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export async function decodeAudioToFloat32({
	audioBlob,
}: {
	audioBlob: Blob;
}): Promise<DecodedAudio> {
	const audioContext = createAudioContext();
	try {
		const arrayBuffer = await audioBlob.arrayBuffer();
		const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

		// mix down to mono
		const numChannels = audioBuffer.numberOfChannels;
		const length = audioBuffer.length;
		const samples = new Float32Array(length);

		for (let i = 0; i < length; i++) {
			let sum = 0;
			for (let channel = 0; channel < numChannels; channel++) {
				sum += audioBuffer.getChannelData(channel)[i];
			}
			samples[i] = sum / numChannels;
		}

		return { samples, sampleRate: audioBuffer.sampleRate };
	} finally {
		await audioContext.close();
	}
}

export async function collectAudioElements({
	tracks,
	mediaAssets,
	audioContext,
	strict = false,
	shouldCancel,
}: {
	strict?: boolean;
	shouldCancel?: () => boolean;
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	audioContext: AudioContext;
}): Promise<CollectedAudioElement[]> {
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((media) => [media.id, media]),
	);
	const pendingElements: Array<Promise<CollectedAudioElement | null>> = [];
	const solo = tracks.some((track) => "solo" in track && track.solo);
	const decoded = new Map<string, Promise<AudioBuffer | null>>();
	let decodeTail = Promise.resolve();
	let decodeError: unknown;
	const once = (key: string, decode: () => Promise<AudioBuffer | null>) => {
		if (!decoded.has(key)) {
			const pending = decodeTail.then(() => {
				checkExportCancellation(shouldCancel);
				if (decodeError) throw decodeError;
				return decode();
			});
			decoded.set(key, pending);
			decodeTail = pending.then(
				() => {},
				(error) => {
					decodeError = error;
				},
			);
		}
		return decoded.get(key)!;
	};

	checkExportCancellation(shouldCancel);
	for (const track of tracks) {
		if (
			canTracktHaveAudio(track) &&
			(track.muted || (solo && !("solo" in track && track.solo)))
		)
			continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.duration <= 0 || ("muted" in element && element.muted))
				continue;

			const isTrackMuted = canTracktHaveAudio(track) && track.muted;

			if (element.type === "audio") {
				pendingElements.push(
					once(
						element.sourceType === "upload"
							? element.mediaId
							: element.sourceUrl,
						() =>
							resolveAudioBufferForElement({
								element,
								mediaMap,
								audioContext,
								strict,
								shouldCancel,
							}),
					).then((audioBuffer) => {
						if (!audioBuffer) return null;
						return {
							buffer: audioBuffer,
							trackId: track.id,
							animations: element.animations,
							volume:
								"volume" in element && typeof element.volume === "number"
									? element.volume
									: 1,
							playbackRate: element.playbackRate ?? 1,
							startTime: element.startTime,
							duration: element.duration,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							muted: element.muted || isTrackMuted,
						};
					}),
				);
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset || !mediaSupportsAudio({ media: mediaAsset })) continue;

				pendingElements.push(
					once(mediaAsset.id, () =>
						resolveAudioBufferForVideoElement({
							mediaAsset,
							audioContext,
							strict,
							shouldCancel,
						}),
					).then((audioBuffer) => {
						if (!audioBuffer) return null;
						const elementMuted = element.muted ?? false;
						return {
							buffer: audioBuffer,
							trackId: track.id,
							animations: element.animations,
							volume:
								"volume" in element && typeof element.volume === "number"
									? element.volume
									: 1,
							playbackRate: element.playbackRate ?? 1,
							startTime: element.startTime,
							duration: element.duration,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							muted: elementMuted || isTrackMuted,
						};
					}),
				);
			}
		}
	}

	const resolvedElements = await Promise.all(pendingElements);
	checkExportCancellation(shouldCancel);
	const audioElements: CollectedAudioElement[] = [];
	for (const element of resolvedElements) {
		if (element) audioElements.push(element);
	}
	return audioElements;
}

async function resolveAudioBufferForElement({
	element,
	mediaMap,
	audioContext,
	strict = false,
	shouldCancel,
}: {
	element: AudioElement;
	mediaMap: Map<string, MediaAsset>;
	audioContext: AudioContext;
	strict?: boolean;
	shouldCancel?: () => boolean;
}): Promise<AudioBuffer | null> {
	try {
		if (element.sourceType === "upload") {
			const asset = mediaMap.get(element.mediaId);
			if (!asset || asset.type !== "audio") {
				if (strict) throw new Error("Audio original is missing");
				return null;
			}

			checkExportCancellation(shouldCancel);
			const arrayBuffer = await asset.file.arrayBuffer();
			checkExportCancellation(shouldCancel);
			const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
			checkExportCancellation(shouldCancel);
			return decoded;
		}

		if (element.buffer) return element.buffer;

		const bytes = await fetchAudioBytes(element.sourceUrl, shouldCancel);
		const decoded = await audioContext.decodeAudioData(bytes);
		checkExportCancellation(shouldCancel);
		return decoded;
	} catch (error) {
		if (strict) throw error;
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForVideoElement({
	mediaAsset,
	audioContext,
	strict = false,
	shouldCancel,
}: {
	mediaAsset: MediaAsset;
	audioContext: AudioContext;
	strict?: boolean;
	shouldCancel?: () => boolean;
}): Promise<AudioBuffer | null> {
	const input = new Input({
		source: new BlobSource(mediaAsset.file),
		formats: ALL_FORMATS,
	});

	try {
		checkExportCancellation(shouldCancel);
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const sink = new AudioBufferSink(audioTrack);
		const targetSampleRate = audioContext.sampleRate;

		const chunks: AudioBuffer[] = [];
		let totalSamples = 0;

		for await (const { buffer } of sink.buffers(0)) {
			checkExportCancellation(shouldCancel);
			chunks.push(buffer);
			totalSamples += buffer.length;
		}

		if (chunks.length === 0) {
			if (strict) throw new Error("Audio track could not be decoded");
			return null;
		}

		const nativeSampleRate = chunks[0].sampleRate;
		const numChannels = Math.min(
			MAX_AUDIO_CHANNELS,
			chunks[0].numberOfChannels,
		);

		const nativeChannels = Array.from(
			{ length: numChannels },
			() => new Float32Array(totalSamples),
		);
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < numChannels; channel++) {
				const sourceData = chunk.getChannelData(
					Math.min(channel, chunk.numberOfChannels - 1),
				);
				nativeChannels[channel].set(sourceData, offset);
			}
			offset += chunk.length;
		}

		// use OfflineAudioContext for high-quality resampling to target rate
		const outputSamples = Math.ceil(
			totalSamples * (targetSampleRate / nativeSampleRate),
		);
		const offlineContext = new OfflineAudioContext(
			numChannels,
			outputSamples,
			targetSampleRate,
		);

		const nativeBuffer = audioContext.createBuffer(
			numChannels,
			totalSamples,
			nativeSampleRate,
		);
		for (let ch = 0; ch < numChannels; ch++) {
			nativeBuffer.copyToChannel(nativeChannels[ch], ch);
		}

		const sourceNode = offlineContext.createBufferSource();
		sourceNode.buffer = nativeBuffer;
		sourceNode.connect(offlineContext.destination);
		sourceNode.start(0);

		checkExportCancellation(shouldCancel);
		const rendered = await offlineContext.startRendering();
		checkExportCancellation(shouldCancel);
		return rendered;
	} catch (error) {
		if (strict) throw error;
		console.warn("Failed to decode video audio:", error);
		return null;
	} finally {
		input.dispose();
	}
}

interface AudioMixSource {
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
}

export interface AudioClipSource {
	id: string;
	sourceKey: string;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	muted: boolean;
	volume: number;
	playbackRate: number;
	animations?: ElementAnimations;
}

async function fetchLibraryAudioSource({
	element,
}: {
	element: LibraryAudioElement;
}): Promise<AudioMixSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	element,
	muted,
}: {
	element: LibraryAudioElement;
	muted: boolean;
}): Promise<AudioClipSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			id: element.id,
			sourceKey: element.id,
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			muted,
			volume: element.volume ?? 1,
			playbackRate: element.playbackRate ?? 1,
			animations: element.animations,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioSource({
	element,
	mediaAsset,
}: {
	element: TimelineElement;
	mediaAsset: MediaAsset;
}): AudioMixSource {
	return {
		file: mediaAsset.file,
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
	};
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
}: {
	element: TimelineElement;
	mediaAsset: MediaAsset;
	muted: boolean;
}): AudioClipSource {
	const vol =
		"volume" in element ? ((element as { volume?: number }).volume ?? 1) : 1;
	return {
		id: element.id,
		sourceKey: mediaAsset.id,
		file: mediaAsset.file,
		startTime: element.startTime,
		duration: element.duration,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		muted,
		volume: vol,
		animations: element.animations,
		playbackRate: "playbackRate" in element ? (element.playbackRate ?? 1) : 1,
	};
}

export async function collectAudioMixSources({
	tracks,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): Promise<AudioMixSource[]> {
	const audioMixSources: AudioMixSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of tracks) {
		if (canTracktHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset }),
					);
				} else {
					pendingLibrarySources.push(fetchLibraryAudioSource({ element }));
				}
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset) continue;

				if (mediaSupportsAudio({ media: mediaAsset })) {
					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset }),
					);
				}
			}
		}
	}

	const resolvedLibrarySources = await Promise.all(pendingLibrarySources);
	for (const source of resolvedLibrarySources) {
		if (source) audioMixSources.push(source);
	}

	return audioMixSources;
}

export async function collectAudioClips({
	tracks,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
}): Promise<AudioClipSource[]> {
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of tracks) {
		const isTrackMuted = canTracktHaveAudio(track) && track.muted;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			const isElementMuted =
				"muted" in element ? (element.muted ?? false) : false;
			const muted = isTrackMuted || isElementMuted;

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
						}),
					);
				} else {
					pendingLibraryClips.push(fetchLibraryAudioClip({ element, muted }));
				}
				continue;
			}

			if (element.type === "video") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset) continue;

				if (mediaSupportsAudio({ media: mediaAsset })) {
					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
						}),
					);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
	shouldCancel,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
	audioContext?: AudioContext;
	shouldCancel?: () => boolean;
}): Promise<AudioBuffer | null> {
	checkExportCancellation(shouldCancel);
	const context = audioContext ?? createAudioContext({ sampleRate });
	try {
		const clips = await collectAudioElements({
			tracks,
			mediaAssets,
			audioContext: context,
			strict: true,
			shouldCancel,
		});
		checkExportCancellation(shouldCancel);
		const rendered = await renderTimelineAudio({
			clips,
			tracks,
			duration,
			sampleRate,
		});
		checkExportCancellation(shouldCancel);
		return rendered;
	} finally {
		if (!audioContext) await context.close();
	}
}
