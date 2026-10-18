import { expect, test } from "bun:test";
import { analyzeSession, type MemorySample } from "./session-analysis";

function fixture() {
	const samples: MemorySample[] = Array.from({ length: 991 }, (_, i) => ({
		monotonic: i * 2,
		swap_bytes: 1000 + i,
		available_bytes: 5e9,
		browser_rss_bytes: 1e9,
		native_rss_bytes: 1e9,
		browser_processes: 3,
		errors: [],
	}));
	return {
		samples,
		warmupMinutes: 2,
		minutes: 30,
		elapsedMs: 33 * 60_000,
		workflowCompleted: true,
		samplerClean: true,
		cycles: 10,
		operations: [
			"transcribe",
			"llm",
			"image",
			"editing_playback_export_reload",
		].map((kind) => ({ kind, passed: true })),
		errors: [] as string[],
	};
}

test("completed mixed observations retain measured swap and process memory", () => {
	const result = analyzeSession(fixture());
	expect(result.mixed_session_checks_passed).toBe(true);
	expect(result.peak_post_warmup_swap_growth_bytes).toBe(930);
	expect(result.process_rss_growth_bytes).toBe(0);
});

test("an exception after the duration expires cannot mark the workflow complete", () => {
	const result = analyzeSession({ ...fixture(), workflowCompleted: false });
	expect(result.checks.duration).toBe(true);
	expect(result.checks.workflow_completed).toBe(false);
	expect(result.mixed_session_checks_passed).toBe(false);
});

test("sampler shutdown failure rejects acceptance even with previously valid samples", () => {
	expect(
		analyzeSession({ ...fixture(), samplerClean: false })
			.mixed_session_checks_passed,
	).toBe(false);
});

test("large sampling gaps and truncated telemetry windows reject acceptance", () => {
	const data = fixture();
	data.samples.splice(300, 20);
	expect(analyzeSession(data).checks.memory_observed).toBe(true);
	expect(analyzeSession(data).checks.memory_coverage).toBe(false);
	expect(
		analyzeSession({ ...fixture(), samples: fixture().samples.slice(0, 300) })
			.checks.memory_coverage,
	).toBe(false);
});

test("missing swap is unknown rather than zero or a passing budget", () => {
	const data = fixture();
	data.samples[100].swap_bytes = null;
	const result = analyzeSession(data);
	expect(result.peak_post_warmup_swap_growth_bytes).toBeNull();
	expect(result.checks.post_warmup_swap).toBe(false);
	expect(result.checks.memory_observed).toBe(false);
});

test("empty samples and missing process observations cannot pass", () => {
	expect(
		analyzeSession({ ...fixture(), samples: [] }).mixed_session_checks_passed,
	).toBe(false);
	const data = fixture();
	data.samples[100].browser_processes = 0;
	expect(analyzeSession(data).checks.memory_observed).toBe(false);
});

test("permission errors and nonfinite measurements cannot pass memory checks", () => {
	const data = fixture();
	data.samples[100].errors = ["permission denied"];
	expect(analyzeSession(data).mixed_session_checks_passed).toBe(false);
	data.samples[100].native_rss_bytes = Number.NaN;
	expect(analyzeSession(data).process_rss_growth_bytes).toBeNull();
	data.samples[100].swap_bytes = Number.POSITIVE_INFINITY;
	expect(analyzeSession(data).peak_post_warmup_swap_growth_bytes).toBeNull();
});

test("failed operations, missing AI coverage and excess swap remain failed gates", () => {
	const data = fixture();
	data.operations[0].passed = false;
	expect(analyzeSession(data).checks.all_operations_passed).toBe(false);
	expect(analyzeSession(data).checks.ai_coverage).toBe(false);
	data.samples[990].swap_bytes = 2 * 1024 ** 3;
	expect(analyzeSession(data).checks.post_warmup_swap).toBe(false);
});
