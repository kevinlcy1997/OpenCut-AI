import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import ts from "typescript";

// Exercise the application's effect implementation in real Web Audio rather
// than a node mock. This module has no imports or runtime dependencies.
const effectModule = ts.transpileModule(
	readFileSync("apps/web/src/lib/audio/audio-effects.ts", "utf8"),
	{
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	},
).outputText;

for (const sampleRate of [44100, 48000]) {
	test(`reverb renders repeatable stereo audio at ${sampleRate} Hz`, async ({
		page,
	}) => {
		const result = await page.evaluate(
			async ({ code, sampleRate }) => {
				const effects = new Function("exports", `${code}; return exports;`)(
					{},
				).AUDIO_EFFECT_DEFINITIONS;
				async function render(params: Record<string, number> = {}) {
					const context = new OfflineAudioContext(2, sampleRate, sampleRate);
					const source = context.createBufferSource();
					const input = context.createBuffer(2, 1, sampleRate);
					input.getChannelData(0)[0] = 1;
					input.getChannelData(1)[0] = 1;
					source.buffer = input;
					const nodes = effects.reverb.createNodes(context, params);
					source.connect(nodes[0]);
					nodes[nodes.length - 1].connect(context.destination);
					source.start();
					const output = await context.startRendering();
					return [output.getChannelData(0), output.getChannelData(1)];
				}
				const first = await render({ wetLevel: 100 });
				const changed = await render({ wetLevel: 100, damping: 90 });
				const repeat = await render({ wetLevel: 100 });
				const dry = await render({ wetLevel: 0 });
				return {
					repeatable: first.every((channel, c) =>
						channel.every((v, i) => v === repeat[c][i]),
					),
					finite: first.every((channel) => channel.every(Number.isFinite)),
					stereo: first[0].some((v, i) => v !== first[1][i]),
					tail: first.every((channel) =>
						channel.slice(sampleRate / 2).some((v) => Math.abs(v) > 1e-6),
					),
					controlChangesAudio: first[0].some(
						(v, i) => Math.abs(v - changed[0][i]) > 1e-6,
					),
					dryIdentity: dry.every(
						(channel) =>
							channel[0] === 1 && channel.slice(1).every((v) => v === 0),
					),
				};
			},
			{ code: effectModule, sampleRate },
		);
		expect(result).toEqual({
			repeatable: true,
			finite: true,
			stereo: true,
			tail: true,
			controlChangesAudio: true,
			dryIdentity: true,
		});
	});

	test(`gate and de-esser process the actual worklet module at ${sampleRate} Hz`, async ({
		page,
	}) => {
		await page.goto("/projects");
		const result = await page.evaluate(
			async ({ code, sampleRate }) => {
				const library = new Function("exports", `${code}; return exports;`)({});
				async function render(
					type: string,
					amplitude: number,
					frequency: number,
					params: Record<string, number>,
				) {
					const context = new OfflineAudioContext(
						2,
						sampleRate / 2,
						sampleRate,
					);
					await library.prepareAudioEffects(context, [
						{ id: "test", type, enabled: true, params },
					]);
					const source = context.createBufferSource();
					const input = context.createBuffer(2, sampleRate / 2, sampleRate);
					for (let c = 0; c < 2; c++) {
						const data = input.getChannelData(c);
						for (let i = 0; i < data.length; i++)
							data[i] =
								amplitude *
								(c === 0 ? 1 : 0.5) *
								Math.sin((2 * Math.PI * frequency * i) / sampleRate);
					}
					source.buffer = input;
					const nodes = library.AUDIO_EFFECT_DEFINITIONS[type].createNodes(
						context,
						params,
					);
					let failed = false;
					nodes[0].onprocessorerror = () => {
						failed = true;
					};
					source.connect(nodes[0]);
					nodes[0].connect(context.destination);
					source.start();
					const output = await context.startRendering();
					library.disposeAudioEffectNodes(nodes);
					if (failed) throw new Error("AudioWorklet processor failed");
					function rms(channel: Float32Array) {
						let sum = 0;
						for (let i = sampleRate / 4; i < channel.length; i++)
							sum += channel[i] ** 2;
						return Math.sqrt(sum / (channel.length - sampleRate / 4));
					}
					return {
						left: rms(output.getChannelData(0)),
						right: rms(output.getChannelData(1)),
						expected: rms(input.getChannelData(0)),
						length: output.length,
					};
				}
				const quiet = await render("noise-gate", 0.001, 1000, {
					threshold: -30,
				});
				const loud = await render("noise-gate", 0.2, 1000, { threshold: -30 });
				const ess = await render("de-esser", 0.5, 6000, {
					threshold: -30,
					frequency: 6000,
					reduction: 10,
				});
				const bass = await render("de-esser", 0.5, 200, {
					threshold: -30,
					frequency: 6000,
					reduction: 10,
				});
				const bypass = await render("de-esser", 0.5, 6000, { reduction: 0 });
				return {
					quiet: quiet.left,
					loudGain: loud.left / loud.expected,
					stereoRatio: loud.right / loud.left,
					deEssDb: 20 * Math.log10(ess.left / ess.expected),
					bassDb: 20 * Math.log10(bass.left / bass.expected),
					bypassGain: bypass.left / bypass.expected,
					length: ess.length,
				};
			},
			{ code: effectModule, sampleRate },
		);
		expect(result.quiet).toBe(0);
		expect(result.loudGain).toBeCloseTo(1, 5);
		expect(result.stereoRatio).toBeCloseTo(0.5, 5);
		expect(result.deEssDb).toBeCloseTo(-10, 1);
		expect(Math.abs(result.bassDb)).toBeLessThan(0.1);
		expect(result.bypassGain).toBe(1);
		expect(result.length).toBe(sampleRate / 2);
	});
}
