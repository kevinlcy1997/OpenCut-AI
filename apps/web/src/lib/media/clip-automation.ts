import type { ElementAnimations } from "@/types/animation";
import {
	resolvePlaybackRateAtTime,
	resolveVolumeAtTime,
} from "@/lib/animation/resolve";
import { getNumberChannelForPath } from "@/lib/animation/number-channel";

export function sourceOffsetAt(
	localTime: number,
	rate = 1,
	animations?: ElementAnimations,
): number {
	const end = Math.max(0, localTime);
	const channel =
		animations &&
		getNumberChannelForPath({ animations, propertyPath: "playbackRate" });
	if (!channel?.keyframes.length) return end * rate;
	const keys = [...channel.keyframes].sort((a, b) => a.time - b.time);
	const points = [
		0,
		...keys.map((key) => key.time).filter((time) => time > 0 && time < end),
		end,
	];
	let area = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1],
			b = points[i];
		const previous = keys.filter((key) => key.time <= a).at(-1);
		const start = resolvePlaybackRateAtTime({
			basePlaybackRate: rate,
			animations,
			localTime: a,
		});
		const finish =
			previous?.interpolation === "hold"
				? start
				: resolvePlaybackRateAtTime({
						basePlaybackRate: rate,
						animations,
						localTime: b,
					});
		if (start <= 0 || finish <= 0 || !Number.isFinite(start + finish))
			throw new Error("Invalid speed keyframe");
		area += ((b - a) * (start + finish)) / 2;
	}
	return area;
}

export function timelineOffsetAt(
	sourceOffset: number,
	duration: number,
	rate = 1,
	animations?: ElementAnimations,
): number {
	if (sourceOffset <= 0) return 0;
	let low = 0,
		high = duration;
	for (let i = 0; i < 48; i++) {
		const mid = (low + high) / 2;
		if (sourceOffsetAt(mid, rate, animations) < sourceOffset) low = mid;
		else high = mid;
	}
	return (low + high) / 2;
}

/** Schedule exactly the editor's linear/hold channels, including a seek into a ramp. */
export function scheduleClipParameter(
	param: AudioParam,
	property: "volume" | "playbackRate",
	base: number,
	animations: ElementAnimations | undefined,
	localStart: number,
	localEnd: number,
	contextStart: number,
): void {
	const channel =
		animations &&
		getNumberChannelForPath({ animations, propertyPath: property });
	const resolve = (localTime: number) =>
		property === "volume"
			? resolveVolumeAtTime({ baseVolume: base, animations, localTime })
			: resolvePlaybackRateAtTime({
					basePlaybackRate: base,
					animations,
					localTime,
				});
	param.setValueAtTime(resolve(localStart), contextStart);
	if (!channel?.keyframes.length) return;
	const keys = [...channel.keyframes].sort((a, b) => a.time - b.time);
	const times = [
		...keys
			.map((key) => key.time)
			.filter((time) => time > localStart && time < localEnd),
		localEnd,
	];
	let previousTime = localStart;
	for (const time of times) {
		const previousKey = keys.filter((key) => key.time <= previousTime).at(-1);
		const at = contextStart + time - localStart;
		if (previousKey && previousKey.interpolation !== "hold")
			param.linearRampToValueAtTime(resolve(time), at);
		else param.setValueAtTime(resolve(time), at);
		previousTime = time;
	}
}
