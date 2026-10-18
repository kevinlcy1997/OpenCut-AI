/** Browser boundary for the loopback launcher; not authentication of local processes. */
const hosts = new Set(["127.0.0.1:3000", "localhost:3000", "[::1]:3000"]);
const origins = new Set([
	"http://127.0.0.1:3000",
	"http://localhost:3000",
	"http://[::1]:3000",
]);

export function allowsLocalWebRequest(
	request: Pick<Request, "headers" | "method">,
): boolean {
	if (!hosts.has((request.headers.get("host") ?? "").toLowerCase()))
		return false;
	const origin = request.headers.get("origin");
	if (origin !== null && !origins.has(origin)) return false;
	const site = request.headers.get("sec-fetch-site");
	if (site !== "cross-site" && site !== "same-site") return true;
	// A link/bookmark may open the editor, but cannot make a cross-site API request.
	if (
		request.method === "GET" &&
		request.headers.get("sec-fetch-mode") === "navigate" &&
		request.headers.get("sec-fetch-dest") === "document"
	)
		return true;
	if (origin !== null) return true;
	try {
		const referer = request.headers.get("referer");
		return referer !== null && origins.has(new URL(referer).origin);
	} catch {
		return false;
	}
}
