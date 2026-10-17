export type CancellationCheck = (() => boolean) | undefined;

export function checkExportCancellation(cancelled: CancellationCheck): void {
	if (cancelled?.()) throw new DOMException("Export cancelled", "AbortError");
}

export async function fetchAudioBytes(
	url: string,
	cancelled?: () => boolean,
): Promise<ArrayBuffer> {
	checkExportCancellation(cancelled);
	const controller = new AbortController();
	const timer = cancelled
		? setInterval(() => {
				if (cancelled()) controller.abort();
			}, 50)
		: undefined;
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok)
			throw new Error(`Library audio fetch failed: ${response.status}`);
		const bytes = await response.arrayBuffer();
		checkExportCancellation(cancelled);
		return bytes;
	} finally {
		if (timer !== undefined) clearInterval(timer);
	}
}
