import { loadImageSource } from "../image-source-cache";
import type { CanvasRenderer } from "../canvas-renderer";
import { VisualNode, type VisualNodeParams } from "./visual-node";

export interface ImageNodeParams extends VisualNodeParams {
	url: string;
	maxSourceSize?: number;
}

export class ImageNode extends VisualNode<ImageNodeParams> {
	async render({ renderer, time }: { renderer: CanvasRenderer; time: number }) {
		await super.render({ renderer, time });

		if (!this.isInRange({ time })) {
			return;
		}

		const { source, width, height } = await loadImageSource(
			this.params.url,
			this.params.maxSourceSize,
		);

		this.renderVisual({
			renderer,
			source,
			sourceWidth: width || renderer.width,
			sourceHeight: height || renderer.height,
			timelineTime: time,
		});
	}
}
