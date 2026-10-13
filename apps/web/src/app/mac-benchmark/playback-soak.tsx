"use client";
import { useRef, useState } from "react";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { ColorNode } from "@/services/renderer/nodes/color-node";
import { VideoCache } from "@/services/video-cache/service";
import { registerDefaultEffects } from "@/lib/effects";
import { nativeSession, nativeRequest } from "@/services/native/client";

export function PlaybackSoak() {
	const canvas = useRef<HTMLCanvasElement>(null);
	const stopped = useRef(false);
	const [running, setRunning] = useState(false);
	const [message, setMessage] = useState(
		"31-minute effects playback; run the native AI/media soak concurrently.",
	);
	async function run() {
		setRunning(true);
		stopped.current = false;
		let url = "";
		const cache = new VideoCache();
		try {
			registerDefaultEffects();
			const session = await nativeSession();
			if (!session) throw new Error("Native runtime unavailable");
			const blob = await (
				await nativeRequest(session, "/benchmark/fixtures/video-4k-60s.mp4")
			).blob();
			const file = new File([blob], "playback-4k.mp4", { type: "video/mp4" });
			url = URL.createObjectURL(file);
			const root = new RootNode({ duration: 60 })
				.add(new ColorNode({ color: "black" }))
				.add(
					new VideoNode({
						file,
						url,
						mediaId: "playback-4k",
						duration: 60,
						timeOffset: 0,
						trimStart: 0,
						trimEnd: 0,
						opacity: 1,
						transform: { scale: 1, rotate: 0, position: { x: 0, y: 0 } },
						effects: [
							{
								id: "soak-grayscale",
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
						],
					}),
				);
			const renderer = new CanvasRenderer({
				width: 1920,
				height: 1080,
				fps: 30,
				videoCache: cache,
			});
			const context = canvas.current?.getContext("2d");
			if (!context) throw new Error("Playback canvas unavailable");
			const start = performance.now(),
				budget = 1000 / 30;
			let next = start,
				frames = 0,
				dropped = 0,
				renderMs = 0,
				minute = -1;
			const samples: number[] = [];
			while (!stopped.current && performance.now() - start < 31 * 60_000) {
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => resolve()),
				);
				const now = performance.now();
				if (now < next) continue;
				dropped += Math.max(0, Math.floor((now - next) / budget));
				next += (1 + Math.max(0, Math.floor((now - next) / budget))) * budget;
				const before = performance.now();
				await renderer.render({
					node: root,
					time: ((now - start) / 1000) % 60,
				});
				context.drawImage(renderer.canvas, 0, 0);
				const elapsed = performance.now() - before;
				renderMs += elapsed;
				frames++;
				if (frames % 12 === 0) samples.push(elapsed);
				const currentMinute = Math.floor((now - start) / 60_000);
				if (currentMinute !== minute) {
					minute = currentMinute;
					setMessage(
						`Playback ${minute}/31 minutes · ${frames} frames · ${dropped} missed frame intervals`,
					);
				}
			}
			samples.sort((a, b) => a - b);
			const metrics = {
				elapsed_seconds: (performance.now() - start) / 1000,
				frames,
				dropped_intervals: dropped,
				mean_render_ms: renderMs / Math.max(1, frames),
				p95_render_ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
				cancelled: stopped.current,
				...renderer.metrics,
			};
			await nativeRequest(session, "/benchmark/results", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					fixture: "playback-31m",
					browser_version: navigator.userAgent,
					runs: [],
					metrics,
				}),
			});
			setMessage(
				`Playback ${stopped.current ? "cancelled" : "completed"}; report saved.`,
			);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Playback failed");
		} finally {
			cache.clearAll();
			if (url) URL.revokeObjectURL(url);
			setRunning(false);
		}
	}
	return (
		<section className="mt-8">
			<p>{message}</p>
			<button
				type="button"
				className="my-3 rounded border p-3"
				disabled={running}
				onClick={run}
			>
				Run playback soak
			</button>
			<button
				type="button"
				className="ml-3 underline"
				disabled={!running}
				onClick={() => {
					stopped.current = true;
				}}
			>
				Stop playback
			</button>
			<canvas ref={canvas} width={1920} height={1080} className="w-full" />
		</section>
	);
}
