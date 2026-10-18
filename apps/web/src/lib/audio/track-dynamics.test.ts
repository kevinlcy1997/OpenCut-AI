import { expect, test } from "bun:test";
import { NoiseGate, DeEsser } from "../../../public/audio/track-dynamics.js";

function tone(
	rate: number,
	frequency: number,
	amplitude: number,
	seconds = 0.5,
) {
	return Float32Array.from(
		{ length: rate * seconds },
		(_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate),
	);
}
function render(
	processor: { process(input: Float32Array[], output: Float32Array[]): void },
	channels: Float32Array[],
	block = 128,
) {
	const output = channels.map((channel) => new Float32Array(channel.length));
	for (let start = 0; start < channels[0].length; start += block) {
		processor.process(
			channels.map((c) => c.subarray(start, start + block)),
			output.map((c) => c.subarray(start, start + block)),
		);
	}
	return output;
}
function rms(data: Float32Array, start = Math.floor(data.length / 2)) {
	return Math.sqrt(
		data.slice(start).reduce((sum, sample) => sum + sample * sample, 0) /
			(data.length - start),
	);
}

for (const rate of [44100, 48000]) {
	test(`noise gate suppresses quiet noise and preserves loud signal at ${rate} Hz`, () => {
		const quiet = tone(rate, 1000, 0.001);
		const loud = tone(rate, 1000, 0.2);
		expect(
			rms(render(new NoiseGate({ threshold: -30 }, rate), [quiet, quiet])[0]),
		).toBe(0);
		const output = render(new NoiseGate({ threshold: -30 }, rate), [
			loud,
			quiet,
		]);
		expect(rms(output[0]) / rms(loud)).toBeCloseTo(1, 5);
		// The loud channel opens both sides, preserving their balance.
		expect(rms(output[1]) / rms(quiet)).toBeCloseTo(1, 5);
	});
	test(`noise gate release attenuates noise after a loud passage at ${rate} Hz`, () => {
		const input = tone(rate, 1000, 0.001, 1);
		input.set(tone(rate, 1000, 0.2, 0.25));
		const fast = render(new NoiseGate({ threshold: -30, release: 10 }, rate), [
			input,
			input,
		])[0];
		const slow = render(new NoiseGate({ threshold: -30, release: 500 }, rate), [
			input,
			input,
		])[0];
		expect(rms(fast, rate * 0.75)).toBeLessThan(1e-8);
		expect(rms(slow, rate * 0.75)).toBeGreaterThan(1e-4);
	});
	test(`de-esser reduces selected sibilance without broadband compression at ${rate} Hz`, () => {
		const sibilance = tone(rate, 6000, 0.5);
		const bass = tone(rate, 200, 0.5);
		const params = { frequency: 6000, threshold: -30, reduction: 10 };
		const reduced = render(new DeEsser(params, rate), [
			sibilance,
			sibilance,
		])[0];
		expect(20 * Math.log10(rms(reduced) / rms(sibilance))).toBeCloseTo(-10, 1);
		const low = render(new DeEsser(params, rate), [bass, bass])[0];
		expect(Math.abs(20 * Math.log10(rms(low) / rms(bass)))).toBeLessThan(0.1);
		const elsewhere = render(
			new DeEsser({ ...params, frequency: 2000 }, rate),
			[sibilance, sibilance],
		)[0];
		expect(rms(elsewhere)).toBeGreaterThan(rms(reduced) * 2);
	});
	test(`de-esser zero reduction and below-threshold audio are exact bypass at ${rate} Hz`, () => {
		const input = tone(rate, 6000, 0.5);
		for (const params of [{ reduction: 0 }, { threshold: 0 }]) {
			expect(render(new DeEsser(params, rate), [input, input])[0]).toEqual(
				input,
			);
		}
	});
	test(`dynamics state and stereo output survive arbitrary render block boundaries at ${rate} Hz`, () => {
		const input = [tone(rate, 6000, 0.5), tone(rate, 200, 0.2)];
		for (const DSP of [NoiseGate, DeEsser]) {
			const a = render(new DSP({}, rate), input, 128);
			const b = render(new DSP({}, rate), input, 97);
			expect(a).toEqual(b);
			expect(a.every((channel) => channel.every(Number.isFinite))).toBe(true);
		}
	});
}
