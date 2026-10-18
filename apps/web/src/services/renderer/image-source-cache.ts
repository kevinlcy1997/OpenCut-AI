import { AsyncResourceCache } from "@/utils/async-resource-cache";

interface CachedImageSource {
	source: HTMLImageElement | OffscreenCanvas;
	width: number;
	height: number;
}

const imageSourceCache = new AsyncResourceCache<CachedImageSource>(
	32,
	128 * 1024 * 1024,
	(value) => value.width * value.height * 4,
);

export function clearImageSourceCache(): void {
	imageSourceCache.clear();
}

export function loadImageSource(
	url: string,
	maxSourceSize?: number,
): Promise<CachedImageSource> {
	return imageSourceCache.get(
		JSON.stringify([url, maxSourceSize ?? null]),
		async () => {
			const image = new Image();

			await new Promise<void>((resolve, reject) => {
				image.onload = () => resolve();
				image.onerror = () => reject(new Error("Image load failed"));
				image.src = url;
			});

			const naturalWidth = image.naturalWidth;
			const naturalHeight = image.naturalHeight;
			const exceedsLimit =
				maxSourceSize &&
				(naturalWidth > maxSourceSize || naturalHeight > maxSourceSize);

			if (exceedsLimit) {
				const scale = Math.min(
					maxSourceSize / naturalWidth,
					maxSourceSize / naturalHeight,
				);
				const scaledWidth = Math.max(1, Math.round(naturalWidth * scale));
				const scaledHeight = Math.max(1, Math.round(naturalHeight * scale));

				const offscreen = new OffscreenCanvas(scaledWidth, scaledHeight);
				const ctx = offscreen.getContext("2d");

				if (ctx) {
					ctx.drawImage(image, 0, 0, scaledWidth, scaledHeight);
					return {
						source: offscreen,
						width: scaledWidth,
						height: scaledHeight,
					};
				}
			}

			return { source: image, width: naturalWidth, height: naturalHeight };
		},
	);
}
