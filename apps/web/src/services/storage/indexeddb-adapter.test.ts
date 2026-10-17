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

function updateDatabase() {
	const request: any = {};
	let written: unknown,
		closed = false;
	const store = {
		get: () => request,
		put: (value: unknown) => {
			written = value;
			return {};
		},
	};
	const transaction: any = {
		error: null,
		objectStore: () => store,
		abort: () => queueMicrotask(() => transaction.onabort()),
	};
	globalThis.indexedDB = {
		open: () => {
			const opening: any = {
				result: {
					transaction: (_stores: unknown, mode: string) => {
						expect(mode).toBe("readwrite");
						return transaction;
					},
					close: () => {
						closed = true;
					},
				},
			};
			queueMicrotask(() => opening.onsuccess());
			return opening;
		},
	} as unknown as IDBFactory;
	return { request, transaction, written: () => written, closed: () => closed };
}
test("metadata update reads and writes in the same transaction and waits for commit", async () => {
	const f = updateDatabase();
	let settled = false;
	const pending = new IndexedDBAdapter<{
		id: string;
		label: string;
		proxy: string;
	}>("test", "metadata")
		.update("key", (value) => ({ ...value, label: "new" }))
		.then((value) => {
			settled = true;
			return value;
		});
	await new Promise((done) => setTimeout(done, 0));
	f.request.result = { id: "key", label: "old", proxy: "keep" };
	f.request.onsuccess();
	expect(f.written()).toEqual({ id: "key", label: "new", proxy: "keep" });
	expect(settled).toBe(false);
	f.transaction.oncomplete();
	expect((await pending).label).toBe("new");
	expect(f.closed()).toBe(true);
});
test("an aborted metadata update never reports success", async () => {
	const f = updateDatabase();
	const failure = new Error("quota exceeded");
	const pending = new IndexedDBAdapter<{ label: string }>("test", "metadata")
		.update("key", (value) => ({ ...value, label: "new" }))
		.catch((error: Error) => error);
	await new Promise((done) => setTimeout(done, 0));
	f.request.result = { label: "old" };
	f.request.onsuccess();
	f.transaction.error = failure;
	f.transaction.onabort();
	expect(await pending).toBe(failure);
	expect(f.closed()).toBe(true);
});
test("an update of missing metadata aborts without recreating the asset", async () => {
	const f = updateDatabase();
	const pending = new IndexedDBAdapter("test", "metadata")
		.update("missing", (value) => value)
		.catch((error: Error) => error);
	await new Promise((done) => setTimeout(done, 0));
	f.request.result = undefined;
	f.request.onsuccess();
	expect(((await pending) as Error).message).toContain("missing");
	expect(f.written()).toBeUndefined();
	expect(f.closed()).toBe(true);
});
