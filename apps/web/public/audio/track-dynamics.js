// Shared DSP for live AudioContext and OfflineAudioContext. No main-thread
// timers, lookahead delay, external dependencies or per-sample allocations.
function setting(value, fallback, min, max) {
	return Number.isFinite(value)
		? Math.max(min, Math.min(max, value))
		: fallback;
}
function smoothing(milliseconds, rate) {
	return milliseconds <= 0 ? 0 : Math.exp(-1 / (milliseconds * 0.001 * rate));
}

export class NoiseGate {
	constructor(params, rate) {
		this.threshold = 10 ** (setting(params.threshold, -40, -80, 0) / 20);
		this.attack = smoothing(setting(params.attack, 5, 0, 100), rate);
		this.release = smoothing(setting(params.release, 50, 10, 500), rate);
		this.detectorRelease = smoothing(10, rate);
		this.envelope = 0;
		this.gain = 0;
		this.open = false;
	}
	process(input, output) {
		for (let i = 0; i < output[0].length; i++) {
			let peak = 0;
			for (let c = 0; c < input.length; c++)
				peak = Math.max(peak, Math.abs(input[c][i] ?? 0));
			this.envelope = Math.max(peak, this.envelope * this.detectorRelease);
			// Six dB hysteresis avoids chatter near the threshold. Link the
			// detector across channels so gating preserves the stereo image.
			if (this.envelope >= this.threshold) this.open = true;
			else if (this.envelope < this.threshold * 0.5) this.open = false;
			const target = this.open ? 1 : 0;
			const coefficient = target > this.gain ? this.attack : this.release;
			this.gain = target + coefficient * (this.gain - target);
			for (let c = 0; c < output.length; c++)
				output[c][i] = (input[c]?.[i] ?? 0) * this.gain;
		}
	}
}

export class DeEsser {
	constructor(params, rate) {
		const frequency = Math.min(
			setting(params.frequency, 6000, 2000, 12000),
			rate * 0.45,
		);
		const omega = (2 * Math.PI * frequency) / rate;
		const alpha = Math.sin(omega) / 4; // band-pass, Q=2, unity peak
		const a0 = 1 + alpha;
		this.b0 = alpha / a0;
		this.b2 = -this.b0;
		this.a1 = (-2 * Math.cos(omega)) / a0;
		this.a2 = (1 - alpha) / a0;
		this.z1 = new Float64Array(2);
		this.z2 = new Float64Array(2);
		this.band = new Float64Array(2);
		this.threshold = setting(params.threshold, -30, -60, 0);
		this.reduction = setting(params.reduction, 10, 0, 30);
		this.release = smoothing(50, rate);
		this.attack = smoothing(1, rate);
		this.envelope = 0;
	}
	process(input, output) {
		for (let i = 0; i < output[0].length; i++) {
			let peak = 0;
			for (let c = 0; c < output.length; c++) {
				const x = input[c]?.[i] ?? 0;
				const band = this.b0 * x + this.z1[c];
				this.z1[c] = -this.a1 * band + this.z2[c];
				this.z2[c] = this.b2 * x - this.a2 * band;
				this.band[c] = band;
				peak = Math.max(peak, Math.abs(band));
			}
			const coefficient = peak > this.envelope ? this.attack : this.release;
			this.envelope = peak + coefficient * (this.envelope - peak);
			const aboveThreshold = Math.max(
				0,
				20 * Math.log10(Math.max(this.envelope, 1e-12)) - this.threshold,
			);
			const attenuation = Math.min(
				this.reduction,
				aboveThreshold * (1 - 1 / 12),
			);
			const bandGain = 10 ** (-attenuation / 20);
			for (let c = 0; c < output.length; c++) {
				// Attenuate the detected sibilance band, leaving the rest of
				// the signal intact. Zero reduction is an exact bypass.
				output[c][i] = (input[c]?.[i] ?? 0) + (bandGain - 1) * this.band[c];
			}
		}
	}
}

if (typeof registerProcessor === "function") {
	for (const [name, DSP] of [
		["opencut-noise-gate", NoiseGate],
		["opencut-de-esser", DeEsser],
	]) {
		registerProcessor(
			name,
			class extends AudioWorkletProcessor {
				constructor(options) {
					super();
					this.dsp = new DSP(options.processorOptions ?? {}, sampleRate);
					this.active = true;
					this.port.onmessage = (event) => {
						if (event.data === "dispose") this.active = false;
					};
				}
				process(inputs, outputs) {
					if (!this.active || !outputs[0]?.length) return false;
					this.dsp.process(inputs[0] ?? [], outputs[0]);
					// Stay alive while asynchronous media decoding connects sources.
					// The graph owner explicitly disposes live processors on rebuild.
					return true;
				}
			},
		);
	}
}
