import { canEncodeVideo, type Quality, type VideoCodec } from "mediabunny";

export async function hardwarePreference(
	codec: VideoCodec,
	width: number,
	height: number,
	bitrate: number | Quality,
) {
	try {
		if (
			await canEncodeVideo(codec, {
				width,
				height,
				bitrate,
				hardwareAcceleration: "prefer-hardware",
			})
		)
			return "prefer-hardware" as const;
	} catch {
		/* Existing browser codec selection remains the fallback. */
	}
	return "no-preference" as const;
}
