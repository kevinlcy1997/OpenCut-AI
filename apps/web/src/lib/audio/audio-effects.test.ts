import { expect, test } from "bun:test";
import {
	AUDIO_EFFECT_DEFINITIONS,
	prepareAudioEffects,
	disposeAudioEffectNodes,
	type TrackAudioEffect,
} from "./audio-effects";

function roomResponse(sampleRate: number, params: Record<string, number> = {}) {
	let impulse: { channels: Float32Array[] } | undefined;
	const node = () => ({ gain: { value: 1 }, connect() {} });
	const context = {
		sampleRate,
		createGain: node,
		createConvolver: () => ({ connect() {}, buffer: null }),
		createBuffer: (channels: number, length: number) => {
			impulse = {
				channels: Array.from(
					{ length: channels },
					() => new Float32Array(length),
				),
			};
			return {
				getChannelData: (channel: number) => impulse!.channels[channel],
			};
		},
	} as unknown as BaseAudioContext;
	AUDIO_EFFECT_DEFINITIONS.reverb.createNodes(context, params);
	return impulse!.channels;
}

test("reverb reconstructs identical stereo responses across unrelated graph creation", () => {
	const preview = roomResponse(48000);
	roomResponse(44100, { roomSize: 80, damping: 10 });
	const exported = roomResponse(48000);
	for (let channel = 0; channel < 2; channel++) {
		expect(exported[channel]).toEqual(preview[channel]);
		expect(preview[channel].some((sample) => sample !== 0)).toBe(true);
		expect(preview[channel].every(Number.isFinite)).toBe(true);
	}
	expect(preview[0]).not.toEqual(preview[1]);
});

test("room and damping controls still change the response at both export sample rates", () => {
	for (const sampleRate of [44100, 48000]) {
		const normal = roomResponse(sampleRate);
		const larger = roomResponse(sampleRate, { roomSize: 80 });
		const damped = roomResponse(sampleRate, { damping: 100 });
		expect(larger[0].length).toBeGreaterThan(normal[0].length);
		expect(damped[0][0]).toBe(normal[0][0]);
		expect(damped[0].slice(1).every((sample) => sample === 0)).toBe(true);
		expect(normal[0].slice(1).some((sample) => sample !== 0)).toBe(true);
	}
});

const gate: TrackAudioEffect = {
	id: "gate",
	type: "noise-gate",
	enabled: true,
	params: {},
};

test("custom DSP modules load once per context, retry failures and do not load for other effects", async () => {
	let calls = 0;
	let complete!: () => void;
	const context = {
		audioWorklet: {
			addModule: () => {
				calls++;
				return new Promise<void>((resolve) => {
					complete = resolve;
				});
			},
		},
	} as unknown as BaseAudioContext;
	const first = prepareAudioEffects(context, [gate]);
	const second = prepareAudioEffects(context, [gate]);
	expect(calls).toBe(1);
	complete();
	await Promise.all([first, second]);
	await prepareAudioEffects(context, [gate]);
	expect(calls).toBe(1);
	await prepareAudioEffects({} as BaseAudioContext, [
		{ ...gate, enabled: false },
	]);
	await prepareAudioEffects({} as BaseAudioContext, [{ ...gate, type: "eq" }]);
	await expect(
		prepareAudioEffects({} as BaseAudioContext, [gate]),
	).rejects.toThrow("AudioWorklet");
	let fail = true;
	let retries = 0;
	const retryContext = {
		audioWorklet: {
			addModule: async () => {
				retries++;
				if (fail) throw new Error("network interrupted");
			},
		},
	} as unknown as BaseAudioContext;
	await expect(prepareAudioEffects(retryContext, [gate])).rejects.toThrow(
		"network interrupted",
	);
	fail = false;
	await prepareAudioEffects(retryContext, [gate]);
	expect(retries).toBe(2);
});

test("effect disposal stops processor lifetime, closes its port and disconnects all nodes", () => {
	const events: string[] = [];
	const worklet = {
		port: {
			postMessage: (message: string) => events.push(message),
			close: () => events.push("close"),
		},
		disconnect: () => events.push("disconnect-worklet"),
	};
	const gain = { disconnect: () => events.push("disconnect-gain") };
	disposeAudioEffectNodes([worklet, gain] as unknown as AudioNode[]);
	expect(events).toEqual([
		"dispose",
		"close",
		"disconnect-worklet",
		"disconnect-gain",
	]);
});
