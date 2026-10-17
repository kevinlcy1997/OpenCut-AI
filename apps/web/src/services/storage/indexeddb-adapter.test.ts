import { afterEach, describe, expect, test } from "bun:test";
import { IndexedDBAdapter } from "./indexeddb-adapter";

const original = globalThis.indexedDB;
afterEach(() => {
	globalThis.indexedDB = original;
});
function database() {
	const request: any = {};
	const transaction: any = {
		error: null,
		objectStore: () => ({ put: () => request }),
	};
	let closed = false;
	const db: any = {
		transaction: () => transaction,
		close: () => {
			closed = true;
		},
	};
	globalThis.indexedDB = {
		open: () => {
			const opening: any = { result: db };
			queueMicrotask(() => opening.onsuccess());
			return opening;
		},
	} as unknown as IDBFactory;
	return { request, transaction, closed: () => closed };
}

describe("IndexedDB durability", () => {
	test("does not report saved until the transaction commits and closes its connection", async () => {
		const fake = database();
		let saved = false;
		const writing = new IndexedDBAdapter("test", "projects")
			.set("key", {})
			.then(() => {
				saved = true;
			});
		await new Promise((done) => setTimeout(done, 0));
		fake.request.onsuccess();
		await Promise.resolve();
		expect(saved).toBe(false);
		fake.transaction.oncomplete();
		await writing;
		expect(saved).toBe(true);
		expect(fake.closed()).toBe(true);
	});
	test("a transaction abort after a successful request rejects the save", async () => {
		const fake = database();
		const writing = new IndexedDBAdapter("test", "projects").set("key", {});
		const outcome = writing.catch((error: Error) => error);
		await new Promise((done) => setTimeout(done, 0));
		fake.request.onsuccess();
		fake.transaction.error = new Error("Quota exceeded");
		fake.transaction.onabort();
		expect(((await outcome) as Error).message).toBe("Quota exceeded");
		expect(fake.closed()).toBe(true);
	});
});
