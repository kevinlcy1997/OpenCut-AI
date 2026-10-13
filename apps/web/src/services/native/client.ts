const backend =
	process.env.NEXT_PUBLIC_AI_BACKEND_URL || "http://localhost:8420";

export interface NativeSession {
	media_url: string;
	token: string;
}
export interface NativeCapabilities {
	hardware_available: boolean;
	automatic: { proxy: boolean; export: boolean };
}

export async function nativeSession(): Promise<NativeSession | null> {
	try {
		const response = await fetch(`${backend}/api/native/runtime`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) return null;
		const session = await response.json();
		return { ...session, media_url: "/api/native-media" };
	} catch {
		return null;
	}
}

export async function nativeRequest(
	session: NativeSession,
	path: string,
	init?: RequestInit,
) {
	const headers = new Headers(init?.headers);
	headers.set("Authorization", `Bearer ${session.token}`);
	const response = await fetch(`${session.media_url}${path}`, {
		...init,
		credentials: "omit",
		headers,
	});
	if (!response.ok) throw new Error(`Native media: ${await response.text()}`);
	return response;
}

export async function uploadNative(
	session: NativeSession,
	file: Blob,
	signal?: AbortSignal,
): Promise<string> {
	const form = new FormData();
	form.append("file", file);
	const response = await nativeRequest(session, "/assets", {
		method: "POST",
		body: form,
		signal,
	});
	return (await response.json()).asset_id;
}

export async function runNativeJob(
	session: NativeSession,
	specification: object,
	onProgress?: (progress: number) => void,
	signal?: AbortSignal,
): Promise<Blob> {
	const response = await nativeRequest(session, "/jobs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(specification),
		signal,
	});
	const { job_id } = await response.json();
	try {
		while (true) {
			signal?.throwIfAborted();
			const status = await (
				await nativeRequest(session, `/jobs/${job_id}`, { signal })
			).json();
			onProgress?.(status.progress);
			if (status.state === "complete")
				return await (
					await nativeRequest(session, `/jobs/${job_id}/download`, { signal })
				).blob();
			if (status.state === "failed" || status.state === "cancelled")
				throw new Error(status.error || "Native media job cancelled");
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	} catch (error) {
		await nativeRequest(session, `/jobs/${job_id}`, { method: "DELETE" }).catch(
			() => {},
		);
		throw error;
	}
}

export async function releaseNative(session: NativeSession, assets: string[]) {
	await Promise.allSettled(
		assets.map((id) =>
			nativeRequest(session, `/assets/${id}`, { method: "DELETE" }),
		),
	);
}

export async function nativeRuntimeStatus() {
	const response = await fetch(`${backend}/api/native/status`, {
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) return null;
	return response.json();
}

export async function selectWhisperBackend(value: string) {
	const response = await fetch(`${backend}/api/native/whisper/backend`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ backend: value }),
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function selectImageDevice(device: string) {
	const response = await fetch(`${backend}/api/native/image/device`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ device }),
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function cancelNativeTicket(ticket_id: string) {
	const response = await fetch(`${backend}/api/native/cancel`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ticket_id }),
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}
