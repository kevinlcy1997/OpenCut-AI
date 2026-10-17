import { describe, expect, test } from "bun:test";
import { ProjectAccess } from "./project-access";

function manager(): LockManager {
	const held = new Set<string>();
	return {
		request: async (
			name: string,
			_options: unknown,
			callback: (lock: object | null) => unknown,
		) => {
			if (held.has(name)) return callback(null);
			held.add(name);
			try {
				return await callback({ name });
			} finally {
				held.delete(name);
			}
		},
	} as unknown as LockManager;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("exclusive local project editing", () => {
	test("another tab cannot open or modify an owned project, but can edit a different one", async () => {
		const locks = manager();
		const first = new ProjectAccess(() => locks);
		const second = new ProjectAccess(() => locks);
		await first.hold("a");
		await expect(second.hold("a")).rejects.toThrow("another tab");
		let changed = false;
		await expect(
			second.write("a", async () => {
				changed = true;
			}),
		).rejects.toThrow("another tab");
		expect(changed).toBe(false);
		await second.hold("b");
		await first.write("a", async () => {
			changed = true;
		});
		expect(changed).toBe(true);
		first.release("a");
		second.release("b");
	});
	test("closing a project lets another tab recover it", async () => {
		const locks = manager();
		const first = new ProjectAccess(() => locks);
		const second = new ProjectAccess(() => locks);
		await first.hold("a");
		first.release("a");
		await new Promise((done) => setTimeout(done, 0));
		await second.hold("a");
		second.release("a");
	});
	test("temporary writes release ownership even on failure", async () => {
		const locks = manager();
		const first = new ProjectAccess(() => locks);
		const second = new ProjectAccess(() => locks);
		await expect(
			first.write("a", async () => {
				throw new Error("storage full");
			}),
		).rejects.toThrow("storage full");
		await second.hold("a");
		second.release("a");
	});
	test("release waits for a pending storage write to finish", async () => {
		const locks = manager();
		const first = new ProjectAccess(() => locks);
		const second = new ProjectAccess(() => locks);
		const write = deferred();
		await first.hold("a");
		const saving = first.write("a", () => write.promise);
		first.release("a");
		await expect(second.hold("a")).rejects.toThrow("another tab");
		write.resolve();
		await saving;
		await new Promise((done) => setTimeout(done, 0));
		await second.hold("a");
		second.release("a");
	});
	test("fails clearly if safe browser locking is unavailable", async () => {
		const access = new ProjectAccess(() => undefined);
		await expect(access.hold("a")).rejects.toThrow("Web Locks");
	});
});
