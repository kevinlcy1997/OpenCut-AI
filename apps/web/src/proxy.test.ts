import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

test("the launcher enables the web boundary without changing non-native deployment", async () => {
	const previous = process.env.OPENCUT_MAC_STATE;
	try {
		const request = new NextRequest("http://evil.example:3000/api/health", {
			headers: { host: "evil.example:3000", origin: "https://evil.example" },
		});
		delete process.env.OPENCUT_MAC_STATE;
		expect((await proxy(request)).headers.get("x-middleware-next")).toBe("1");
		process.env.OPENCUT_MAC_STATE = "/native/runtime";
		const rejected = await proxy(request);
		expect(rejected.status).toBe(403);
		expect(rejected.headers.get("cache-control")).toBe("no-store");
		expect(rejected.headers.get("x-middleware-next")).toBeNull();
		const local = new NextRequest("http://127.0.0.1:3000/api/health", {
			headers: { host: "127.0.0.1:3000" },
		});
		expect((await proxy(local)).headers.get("x-middleware-next")).toBe("1");
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_MAC_STATE;
		else process.env.OPENCUT_MAC_STATE = previous;
	}
});
