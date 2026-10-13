"use client";
import { useState } from "react";
import { PlaybackSoak } from "./playback-soak";
import { registerDefaultEffects } from "@/lib/effects";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { ColorNode } from "@/services/renderer/nodes/color-node";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { generateProxy } from "@/services/proxy/proxy-generator";
import { eligibleNativeClips, audioWav } from "@/services/native/export";
import {
	nativeSession,
	nativeRequest,
	uploadNative,
	runNativeJob,
	releaseNative,
} from "@/services/native/client";

export default function MacBenchmark() {
	const [message, setMessage] = useState(
		"Requires the native runtime with OPENCUT_NATIVE_BENCHMARK=1 and prepared public fixtures.",
	);
	const [running, setRunning] = useState(false);
	async function benchmark(proxyOnly = false) {
		setRunning(true);
		try {
			registerDefaultEffects();
			const session = await nativeSession();
			if (!session) throw new Error("Native runtime unavailable");
			const fixtures = proxyOnly
				? [["video-4k-60s.mp4", 1280, 720, 60, false] as const]
				: ([
						["video-1080p-120s.mp4", 1920, 1080, 120, true],
						["video-4k-60s.mp4", 3840, 2160, 60, false],
					] as const);
			for (const [name, width, height, duration, effects] of fixtures) {
				const blob = await (
					await nativeRequest(session, `/benchmark/fixtures/${name}`)
				).blob();
				const file = new File([blob], name, { type: "video/mp4" });
				const url = URL.createObjectURL(file);
				const root = new RootNode({ duration })
					.add(new ColorNode({ color: "black" }))
					.add(
						new VideoNode({
							file,
							url,
							mediaId: name,
							duration,
							timeOffset: 0,
							trimStart: 0,
							trimEnd: 0,
							opacity: 1,
							transform: { scale: 1, rotate: 0, position: { x: 0, y: 0 } },
							effects: effects
								? [
										{
											id: "benchmark-grayscale",
											type: "color-adjust",
											enabled: true,
											params: {
												brightness: 0,
												contrast: 1,
												saturation: 0,
												temperature: 0,
												vignette: 0,
											},
										},
									]
								: [],
						}),
					);
				const ids: string[] = [];
				const runs: Array<Record<string, unknown>> = [];
				try {
					const context = new AudioContext();
					const decoded = await context.decodeAudioData(
						await file.arrayBuffer(),
					);
					const mixer = new OfflineAudioContext(
						2,
						decoded.length,
						decoded.sampleRate,
					);
					const track = mixer.createBufferSource();
					track.buffer = decoded;
					track.connect(mixer.destination);
					track.start();
					const audio = await mixer.startRendering();
					await context.close();
					for (let index = 0; index < 4; index++) {
						setMessage(
							`${name}: browser ${index === 0 ? "cold" : `warm ${index}/3`}`,
						);
						const exporter = new SceneExporter({
							width,
							height,
							fps: 30,
							format: "mp4",
							quality: proxyOnly ? "low" : "high",
							encoder: "browser",
							watermark: false,
							shouldIncludeAudio: !proxyOnly,
							audioBuffer: proxyOnly ? undefined : audio,
						});
						let metrics: object = {};
						exporter.on("metrics", (value) => {
							metrics = value;
						});
						const start = performance.now();
						const output = proxyOnly
							? await (
									await generateProxy({
										file,
										resolution: "720p",
										encoder: "browser",
									})
								).file.arrayBuffer()
							: await exporter.export({ rootNode: root });
						if (!output) throw new Error("Browser export failed");
						const seconds = (performance.now() - start) / 1000;
						const id = await uploadNative(
							session,
							new Blob([output], { type: "video/mp4" }),
						);
						ids.push(id);
						runs.push({
							backend: "browser",
							kind: index === 0 ? "cold" : "warm",
							seconds,
							metrics,
							asset_id: id,
							native_eligible: !!eligibleNativeClips(root, 30),
						});
					}
					if (!effects) {
						const source = await uploadNative(session, file);
						ids.push(source);
						const audioId = await uploadNative(session, audioWav(audio));
						ids.push(audioId);
						for (let index = 0; index < 4; index++) {
							setMessage(
								`${name}: VideoToolbox ${index === 0 ? "cold" : `warm ${index}/3`}`,
							);
							const start = performance.now();
							const output = await runNativeJob(session, {
								kind: proxyOnly ? "proxy" : "export",
								clips: [{ asset_id: source, start: 0, duration }],
								width,
								height,
								fps: 30,
								bitrate: proxyOnly ? 2_000_000 : 32_000_000,
								audio_asset_id: proxyOnly ? undefined : audioId,
							});
							const seconds = (performance.now() - start) / 1000;
							const id = await uploadNative(session, output);
							ids.push(id);
							runs.push({
								backend: "videotoolbox",
								kind: index === 0 ? "cold" : "warm",
								seconds,
								asset_id: id,
							});
						}
					}
					await nativeRequest(session, "/benchmark/results", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							fixture: proxyOnly ? "proxy-720p-60s" : name,
							browser_version: navigator.userAgent,
							runs,
						}),
					});
				} finally {
					await releaseNative(session, ids);
					URL.revokeObjectURL(url);
				}
			}
			setMessage(
				"Finished. Reports are in .mac-runtime/browser-benchmarks. Automatic gates remain disabled until parity verification.",
			);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Benchmark failed");
		} finally {
			setRunning(false);
		}
	}
	return (
		<main className="mx-auto max-w-2xl p-8">
			<h1 className="text-2xl">Mac export benchmark</h1>
			<p className="my-4">{message}</p>
			<button
				type="button"
				className="rounded border p-3"
				disabled={running}
				onClick={() => benchmark()}
			>
				Run fixed benchmarks
			</button>
			<button
				type="button"
				className="ml-3 rounded border p-3"
				disabled={running}
				onClick={() => benchmark(true)}
			>
				Run proxy benchmarks
			</button>
			<PlaybackSoak />
		</main>
	);
}
