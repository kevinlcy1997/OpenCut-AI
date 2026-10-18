export interface MemorySample {
	monotonic: number;
	swap_bytes: number | null;
	available_bytes: number | null;
	browser_rss_bytes: number;
	native_rss_bytes: number;
	browser_processes: number;
	errors: string[];
}

export function analyzeSession({
	samples,
	warmupMinutes,
	minutes,
	elapsedMs,
	workflowCompleted,
	samplerClean,
	cycles,
	operations,
	errors,
}: {
	samples: MemorySample[];
	warmupMinutes: number;
	minutes: number;
	elapsedMs: number;
	workflowCompleted: boolean;
	samplerClean: boolean;
	cycles: number;
	operations: { kind: string; passed: boolean }[];
	errors: string[];
}) {
	const first = samples[0];
	const measured = first
		? samples.filter(
				(sample) => sample.monotonic - first.monotonic >= warmupMinutes * 60,
			)
		: [];
	const validNumber = (value: unknown): value is number =>
		typeof value === "number" && Number.isFinite(value) && value >= 0;
	const validSwap =
		measured.length > 0 &&
		measured.every((sample) => validNumber(sample.swap_bytes));
	const baseline = measured[0]?.swap_bytes;
	const intervals = measured
		.slice(1)
		.map((sample, index) => sample.monotonic - measured[index].monotonic);
	const observedSpan =
		measured.length >= 2
			? measured[measured.length - 1].monotonic - measured[0].monotonic
			: null;
	const maximumGap = intervals.length ? Math.max(...intervals) : null;
	const swapGrowth =
		validSwap && baseline != null
			? Math.max(0, ...measured.map((sample) => sample.swap_bytes! - baseline))
			: null;
	const validRSS =
		measured.length > 0 &&
		measured.every(
			(sample) =>
				validNumber(sample.browser_rss_bytes) &&
				validNumber(sample.native_rss_bytes),
		);
	const median = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
	};
	const quarter = Math.max(1, Math.floor(measured.length / 4));
	const retained = (sample: MemorySample) =>
		sample.browser_rss_bytes + sample.native_rss_bytes;
	const early = validRSS
		? median(measured.slice(0, quarter).map(retained))
		: null;
	const late = validRSS ? median(measured.slice(-quarter).map(retained)) : null;
	const checks = {
		workflow_completed: workflowCompleted,
		sampler_clean: samplerClean,
		duration: minutes >= 30 && elapsedMs - warmupMinutes * 60_000 >= 1_800_000,
		ai_coverage: ["transcribe", "llm", "image"].every((kind) =>
			operations.some(
				(operation) => operation.kind === kind && operation.passed,
			),
		),
		all_operations_passed:
			operations.length > 0 &&
			operations.every((operation) => operation.passed),
		repeated_editing: cycles >= 10,
		no_page_errors: errors.length === 0,
		memory_observed:
			validRSS &&
			validSwap &&
			measured.every(
				(sample) =>
					sample.browser_processes > 0 &&
					validNumber(sample.available_bytes) &&
					sample.errors.length === 0,
			),
		// The sampler runs every two seconds. Allow scheduling jitter, but
		// reject gaps of more than five intervals or a truncated window.
		memory_coverage:
			observedSpan !== null &&
			measured[0].monotonic - first.monotonic - warmupMinutes * 60 <= 5 &&
			observedSpan >= minutes * 60 - 5 &&
			intervals.every((interval) => interval > 0 && interval <= 10),
		post_warmup_swap: swapGrowth !== null && swapGrowth <= 1024 ** 3,
	};
	return {
		checks,
		mixed_session_checks_passed: Object.values(checks).every(Boolean),
		first_quarter_median_process_rss_bytes: early,
		last_quarter_median_process_rss_bytes: late,
		process_rss_growth_bytes:
			early !== null && late !== null ? late - early : null,
		peak_post_warmup_swap_growth_bytes: swapGrowth,
		measured_memory_span_seconds: observedSpan,
		maximum_sample_gap_seconds: maximumGap,
		sampler_errors: samples.flatMap((sample) => sample.errors),
		browser_memory_observed:
			measured.length > 0 &&
			measured.every((sample) => sample.browser_processes > 0),
	};
}
