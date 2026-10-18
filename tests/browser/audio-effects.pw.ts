import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import ts from "typescript";

// Exercise the application's effect implementation in real Web Audio rather
// than a node mock. This module has no imports or runtime dependencies.
const effectModule = ts.transpileModule(
	readFileSync("apps/web/src/lib/audio/audio-effects.ts", "utf8"),
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

for (const sampleRate of [44100, 48000]) {
	test(`reverb renders repeatable stereo audio at ${sampleRate} Hz`, async ({ page }) => {
		const result = await page.evaluate(async ({ code, sampleRate }) => {
			const effects = new Function("exports", `${code}; return exports;`)({})
				.AUDIO_EFFECT_DEFINITIONS;
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
				repeatable: first.every((channel, c) => channel.every((v, i) => v === repeat[c][i])),
				finite: first.every((channel) => channel.every(Number.isFinite)),
				stereo: first[0].some((v, i) => v !== first[1][i]),
				tail: first.every((channel) => channel.slice(sampleRate / 2).some((v) => Math.abs(v) > 1e-6)),
				controlChangesAudio: first[0].some((v, i) => Math.abs(v - changed[0][i]) > 1e-6),
				dryIdentity: dry.every((channel) => channel[0] === 1 && channel.slice(1).every((v) => v === 0)),
			};
		}, { code: effectModule, sampleRate });
		expect(result).toEqual({
			repeatable: true,
			finite: true,
			stereo: true,
			tail: true,
			controlChangesAudio: true,
			dryIdentity: true,
		});
	});
}
