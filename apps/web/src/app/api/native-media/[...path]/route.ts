import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxy(
	request: NextRequest,
	context: { params: Promise<{ path: string[] }> },
) {
	const token = process.env.OPENCUT_MEDIA_TOKEN;
	if (!process.env.OPENCUT_MAC_STATE || !token)
		return new Response("Native runtime inactive", { status: 404 });
	const origin = request.headers.get("origin");
	const allowed = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
	if (origin && !allowed.has(origin))
		return new Response("Origin denied", { status: 403 });
	if (request.headers.get("authorization") !== `Bearer ${token}`)
		return new Response("Runtime token required", { status: 401 });
	const { path } = await context.params;
	const target = `http://127.0.0.1:8428/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
	const headers = new Headers({ Authorization: `Bearer ${token}` });
	const contentType = request.headers.get("content-type");
	if (contentType) headers.set("content-type", contentType);
	const init: RequestInit & { duplex?: "half" } = {
		method: request.method,
		headers,
		signal: request.signal,
	};
	if (!["GET", "HEAD"].includes(request.method)) {
		init.body = request.body;
		init.duplex = "half";
	}
	try {
		const upstream = await fetch(target, init);
		const responseHeaders = new Headers();
		for (const key of [
			"content-type",
			"content-length",
			"content-disposition",
		]) {
			const value = upstream.headers.get(key);
			if (value) responseHeaders.set(key, value);
		}
		return new Response(upstream.body, {
			status: upstream.status,
			headers: responseHeaders,
		});
	} catch {
		return new Response("Native media worker unavailable", { status: 503 });
	}
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
