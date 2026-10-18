import type { AIBackendStatus } from "@/types/ai";

/** Absence of a completed health check is not a connection failure. */
export function getAIConnectionState(
	status: AIBackendStatus | null,
): "checking" | "connected" | "disconnected" {
	return status === null
		? "checking"
		: status.available
			? "connected"
			: "disconnected";
}
