import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AIStatusIndicator, type AIStatusInfo } from "./ai-status-indicator";
import { getAIConnectionState } from "@/lib/ai-connection";
const status: AIStatusInfo = {
	connected: false,
	modelsLoaded: [],
	memoryUsageMb: 0,
	memoryTotalMb: 0,
	gpuAvailable: false,
};

test("an unchecked backend is checking rather than a confirmed failure", () => {
	expect(getAIConnectionState(null)).toBe("checking");
	expect(
		getAIConnectionState({ available: true, models: [], gpuAvailable: false }),
	).toBe("connected");
	expect(
		getAIConnectionState({
			available: false,
			models: [],
			gpuAvailable: false,
			error: "offline",
		}),
	).toBe("disconnected");
});
test("initial status has a checking label without an offline claim", () => {
	const html = renderToStaticMarkup(
		<AIStatusIndicator status={{ ...status, checking: true }} />,
	);
	expect(html).toContain('aria-label="AI backend checking"');
	expect(html).not.toContain("AI Off");
	expect(html).not.toContain("AI backend disconnected");
});
test("confirmed failure and success retain their distinct labels", () => {
	expect(renderToStaticMarkup(<AIStatusIndicator status={status} />)).toContain(
		'aria-label="AI backend disconnected"',
	);
	expect(
		renderToStaticMarkup(
			<AIStatusIndicator status={{ ...status, connected: true }} />,
		),
	).toContain('aria-label="AI backend connected"');
});
