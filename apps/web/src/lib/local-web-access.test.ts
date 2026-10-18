import { expect, test } from "bun:test";
import { allowsLocalWebRequest } from "./local-web-access";

function allowed(headers: Record<string, string>, method = "GET") {
	return allowsLocalWebRequest({
		headers: new Headers({ host: "127.0.0.1:3000", ...headers }),
		method,
	});
}

test("local navigation, same-origin fetch and local health probes work", () => {
	expect(allowed({})).toBe(true);
	expect(allowed({ "sec-fetch-site": "none" })).toBe(true);
	expect(allowed({ "sec-fetch-site": "same-origin" }, "POST")).toBe(true);
	for (const host of [
		"127.0.0.1:3000",
		"localhost:3000",
		"[::1]:3000",
		"LOCALHOST:3000",
	])
		expect(allowed({ host })).toBe(true);
});

test("DNS rebinding, malformed and wrong-port hosts cannot reach pages or APIs", () => {
	for (const host of [
		"evil.example:3000",
		"127.0.0.1",
		"localhost:80",
		"localhost:3001",
		"localhost:3000@evil.example",
		"localhost:3000.evil.example",
		"",
		"localhost:3000, evil.example",
	])
		expect(allowed({ host })).toBe(false);
	expect(
		allowed({ host: "evil.example:3000", origin: "http://127.0.0.1:3000" }),
	).toBe(false);
});

test("hostile and null origins are denied even on navigation", () => {
	for (const origin of [
		"null",
		"https://evil.example",
		"http://localhost:3001",
		"http://localhost:3000.evil.example",
		"https://localhost:3000",
	])
		expect(
			allowed({
				origin,
				"sec-fetch-mode": "navigate",
				"sec-fetch-dest": "document",
			}),
		).toBe(false);
});

test("cross-site links can navigate but subresources, forms and API calls cannot", () => {
	const navigation = {
		"sec-fetch-site": "cross-site",
		"sec-fetch-mode": "navigate",
		"sec-fetch-dest": "document",
	};
	expect(allowed(navigation)).toBe(true);
	expect(allowed(navigation, "POST")).toBe(false);
	for (const site of ["cross-site", "same-site"]) {
		expect(allowed({ "sec-fetch-site": site })).toBe(false);
		expect(
			allowed({ "sec-fetch-site": site, referer: "http://localhost:3001/" }),
		).toBe(false);
		expect(allowed({ "sec-fetch-site": site, referer: "malformed" })).toBe(
			false,
		);
		expect(
			allowed({
				"sec-fetch-site": site,
				referer: "http://127.0.0.1:3000/editor/x",
			}),
		).toBe(true);
		expect(
			allowed(
				{ "sec-fetch-site": site, origin: "http://localhost:3000" },
				"POST",
			),
		).toBe(true);
	}
});
