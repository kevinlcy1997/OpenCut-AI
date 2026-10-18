import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/browser",
	testMatch: "**/*.pw.ts",
	workers: 1,
	retries: 0,
	expect: { timeout: 20_000 },
	timeout: 60_000,
	outputDir: ".mac-runtime/browser-test-results",
	reporter: [
		["line"],
		["json", { outputFile: ".mac-runtime/browser-integration-report.json" }],
	],
	use: {
		baseURL: "http://127.0.0.1:3000",
		browserName: "chromium",
		channel: "chromium",
		headless: true,
		trace: "retain-on-failure",
		screenshot: "on",
	},
});
