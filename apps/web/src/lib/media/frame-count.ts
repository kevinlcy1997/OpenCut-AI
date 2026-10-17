/** Count frame starts in [0, duration), allowing only floating-point roundoff. */
export function frameCountForDuration(duration: number, fps: number): number {
	if (
		!Number.isFinite(duration) ||
		duration < 0 ||
		!Number.isFinite(fps) ||
		fps <= 0
	)
		throw new Error(
			"Frame timing requires a finite duration and positive frame rate",
		);
	const frames = duration * fps;
	if (!Number.isSafeInteger(Math.ceil(frames)))
		throw new Error("Frame count exceeds the supported numeric range");
	const nearest = Math.round(frames);
	// Division/multiplication and summed clip boundaries can straddle an integer
	// by a few ULPs. A genuine partial frame must still be included.
	const tolerance = Number.EPSILON * Math.max(1, frames) * 8;
	return Math.max(
		duration > 0 ? 1 : 0,
		Math.abs(frames - nearest) <= tolerance ? nearest : Math.ceil(frames),
	);
}
