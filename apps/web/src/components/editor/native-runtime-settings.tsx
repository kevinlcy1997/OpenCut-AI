"use client";
import { useEffect, useState } from "react";
import {
	nativeRuntimeStatus,
	selectWhisperBackend,
	selectImageDevice,
	cancelNativeTicket,
} from "@/services/native/client";

interface RuntimeStatus {
	services: Record<
		string,
		{
			status: string;
			model?: {
				name?: string;
				backend?: string;
				device?: string;
				loaded?: boolean;
				requested_backend?: string;
				requested_device?: string;
			};
		}
	>;
	coordination: {
		service?: string;
		queued?: number;
		estimated_mb?: number;
		measured_process_rss_mb?: number | null;
		measured_mps_tensor_mb?: number;
		measured_mps_driver_mb?: number;
		mps_memory_measured_at?: number;
		reserved_mb?: number;
		busy?: boolean;
		queue_entries?: Array<{ id: string; service: string; model?: string }>;
	};
}

export function NativeRuntimeSettings() {
	const [status, setStatus] = useState<RuntimeStatus | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [imageDevice, setImageDevice] = useState("auto");
	useEffect(() => {
		let active = true;
		const refresh = () =>
			nativeRuntimeStatus()
				.then((value) => {
					if (active) setStatus(value);
				})
				.catch(() => {});
		void refresh();
		const timer = setInterval(refresh, 5000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, []);
	if (!status) return null;
	const whisper = status.services.whisper?.model;
	return (
		<div className="flex flex-col gap-2 text-xs">
			<p>
				Native Mac runtime · {status.coordination.queued ?? 0} waiting ·{" "}
				{status.coordination.busy ? "working" : "idle"}
			</p>
			<p className="text-muted-foreground">
				Estimated active model: {status.coordination.estimated_mb ?? 0} MB.
				Reserved for editing: {status.coordination.reserved_mb ?? 4096} MB.
			</p>
			{status.coordination.measured_process_rss_mb != null && (
				<p className="text-muted-foreground">
					Measured process memory:{" "}
					{Math.round(status.coordination.measured_process_rss_mb)} MB. This
					does not measure total GPU allocation.
				</p>
			)}
			{status.coordination.measured_mps_tensor_mb != null && (
				<p className="text-muted-foreground">
					Measured Metal tensors:{" "}
					{Math.round(status.coordination.measured_mps_tensor_mb)} MB
					{status.coordination.measured_mps_driver_mb != null && (
						<>
							; driver including caches:{" "}
							{Math.round(status.coordination.measured_mps_driver_mb)} MB
						</>
					)}
					. These figures overlap process memory and should not be added.
					{status.coordination.mps_memory_measured_at != null && (
						<>
							{" "}
							Last sampled{" "}
							{new Date(
								status.coordination.mps_memory_measured_at * 1000,
							).toLocaleTimeString()}
							.
						</>
					)}
				</p>
			)}
			<label className="flex items-center justify-between gap-2">
				Transcription backend
				<select
					disabled={busy}
					value={whisper?.requested_backend ?? "auto"}
					onChange={async (event) => {
						setBusy(true);
						setError("");
						try {
							await selectWhisperBackend(event.target.value);
							setStatus(await nativeRuntimeStatus());
						} catch (failure) {
							setError(
								failure instanceof Error
									? failure.message
									: "Backend change failed",
							);
						} finally {
							setBusy(false);
						}
					}}
					className="rounded border bg-background p-1"
				>
					<option value="auto">Auto</option>
					<option value="mlx">MLX (Apple GPU)</option>
					<option value="faster-whisper">faster-whisper</option>
				</select>
			</label>
			<label className="flex items-center justify-between gap-2">
				Image processing device
				<select
					disabled={busy}
					value={status.services.image?.model?.requested_device ?? imageDevice}
					onChange={async (event) => {
						const value = event.target.value;
						setBusy(true);
						setError("");
						try {
							await selectImageDevice(value);
							setImageDevice(value);
							setStatus(await nativeRuntimeStatus());
						} catch (failure) {
							setError(
								failure instanceof Error
									? failure.message
									: "Device change failed",
							);
						} finally {
							setBusy(false);
						}
					}}
					className="rounded border bg-background p-1"
				>
					<option value="auto">Auto</option>
					<option value="mps">Metal (Apple GPU)</option>
					<option value="cpu">CPU</option>
				</select>
			</label>
			{Object.entries(status.services).map(([name, service]) => (
				<p key={name} className="text-muted-foreground">
					{name}:{" "}
					{service.status === "unavailable"
						? "unavailable"
						: service.model?.loaded
							? `${service.model.name ?? "model"} · ${service.model.backend ?? "native"} · ${service.model.device ?? "unknown"}`
							: "not loaded"}
				</p>
			))}
			{status.coordination.queue_entries?.map((ticket) => (
				<p key={ticket.id}>
					{ticket.service} · {ticket.model ?? "queued"}
					<button
						type="button"
						className="ml-2 underline"
						onClick={async () => {
							try {
								await cancelNativeTicket(ticket.id);
								setStatus(await nativeRuntimeStatus());
							} catch (failure) {
								setError(
									failure instanceof Error
										? failure.message
										: "Cancellation failed",
								);
							}
						}}
					>
						Cancel queued job
					</button>
				</p>
			))}
			{error && <p className="text-destructive">{error}</p>}
		</div>
	);
}
