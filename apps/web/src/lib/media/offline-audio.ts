import type { ElementAnimations } from "@/types/animation";
import { sourceOffsetAt, scheduleClipParameter } from "./clip-automation";
import type { TimelineTrack } from "@/types/timeline";
import {
	getAudioEffectDefinition,
	prepareAudioEffects,
	disposeAudioEffectNodes,
} from "@/lib/audio/audio-effects";

export interface DecodedTimelineAudio {
	buffer: AudioBuffer;
	trackId: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	muted?: boolean;
	volume: number;
	playbackRate: number;
	animations?: ElementAnimations;
}

/** Uses the same gain → effect → pan ordering as live playback. */
export async function renderTimelineAudio({
	clips,
	tracks,
	duration,
	sampleRate,
	createContext = (length, rate) => new OfflineAudioContext(2, length, rate),
}: {
	clips: DecodedTimelineAudio[];
	tracks: TimelineTrack[];
	duration: number;
	sampleRate: number;
	createContext?: (length: number, sampleRate: number) => OfflineAudioContext;
}): Promise<AudioBuffer | null> {
	if (!clips.length) return null;
	const context = createContext(Math.ceil(duration * sampleRate), sampleRate);
	await prepareAudioEffects(
		context,
		tracks.flatMap((track) =>
			"audioEffects" in track ? (track.audioEffects ?? []) : [],
		),
	);
	const effectNodes: AudioNode[] = [];
	let processorFailed = false;
	try {
		const inputs = new Map<string, GainNode>();
		const solo = tracks.some((track) => "solo" in track && track.solo);
		for (const track of tracks) {
			if (track.type !== "video" && track.type !== "audio") continue;
			const gain = context.createGain();
			gain.gain.value =
				track.muted || (solo && !track.solo) ? 0 : (track.volume ?? 1);
			inputs.set(track.id, gain);
			let output: AudioNode = gain;
			for (const effect of track.audioEffects ?? []) {
				if (!effect.enabled) continue;
				const definition = getAudioEffectDefinition(effect.type);
				if (!definition)
					throw new Error(`Unsupported audio effect: ${effect.type}`);
				const nodes = definition.createNodes(context, effect.params);
				effectNodes.push(...nodes);
				for (const node of nodes) {
					if ("port" in node)
						(node as AudioWorkletNode).onprocessorerror = () => {
							processorFailed = true;
						};
				}
				if (!nodes.length) continue;
				output.connect(nodes[0]);
				output = nodes[nodes.length - 1];
			}
			const panner = context.createStereoPanner();
			panner.pan.value = track.type === "audio" ? (track.pan ?? 0) : 0;
			output.connect(panner);
			panner.connect(context.destination);
		}
		for (const clip of clips) {
			if (clip.muted || clip.duration <= 0 || clip.startTime >= duration)
				continue;
			if (!Number.isFinite(clip.playbackRate) || clip.playbackRate <= 0)
				throw new Error("Invalid audio playback speed");
			const destination = inputs.get(clip.trackId);
			if (!destination) throw new Error("Audio clip track is missing");
			const node = context.createBufferSource();
			node.buffer = clip.buffer;
			node.playbackRate.value = clip.playbackRate;
			const gain = context.createGain();
			gain.gain.value = clip.volume;
			node.connect(gain);
			gain.connect(destination);
			const start = Math.max(0, clip.startTime);
			const offset =
				clip.trimStart +
				sourceOffsetAt(
					start - clip.startTime,
					clip.playbackRate,
					clip.animations,
				);
			scheduleClipParameter(
				node.playbackRate,
				"playbackRate",
				clip.playbackRate,
				clip.animations,
				start - clip.startTime,
				clip.duration,
				start,
			);
			scheduleClipParameter(
				gain.gain,
				"volume",
				clip.volume,
				clip.animations,
				start - clip.startTime,
				clip.duration,
				start,
			);
			node.start(start, offset);
			node.stop(Math.min(duration, clip.startTime + clip.duration));
		}
		const rendered = await context.startRendering();
		if (processorFailed)
			throw new Error("Audio effect processing failed during export");
		return rendered;
	} finally {
		disposeAudioEffectNodes(effectNodes);
	}
}

export function audioTimelineTime(
	sourceTime: number,
	trimStart: number,
	startTime: number,
	rate: number,
): number {
	return startTime + (sourceTime - trimStart) / rate;
}
export function audioSourceTime(
	timelineTime: number,
	trimStart: number,
	startTime: number,
	rate: number,
): number {
	return trimStart + (timelineTime - startTime) * rate;
}
