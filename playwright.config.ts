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
	webServer: process.env.OPENCUT_BROWSER_START_SERVER === "1" ? {
		command: "bun run start --hostname 127.0.0.1 --port 3000",
		cwd: "./apps/web",
		url: "http://127.0.0.1:3000/projects",
		reuseExistingServer: false,
		timeout: 60_000,
	} : undefined,
	use: {
		baseURL: "http://127.0.0.1:3000",
		browserName: "chromium",
		channel: "chromium",
		headless: true,
		trace: "retain-on-failure",
		screenshot: "on",
	},
});
