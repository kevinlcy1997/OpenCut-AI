import { expect, test } from "bun:test";
import { AsyncResourceCache } from "./async-resource-cache";
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("deduplicates pending loads and evicts least recently used entries", async () => {
	const cache = new AsyncResourceCache<number>(2, 100, (value) => value);
	let loads = 0;
	const pending = deferred<number>();
	const first = cache.get("a", () => {
		loads++;
		return pending.promise;
	});
	expect(cache.get("a", async () => 99)).toBe(first);
	pending.resolve(10);
	await first;
	await cache.get("b", async () => 10);
	await cache.get("a", async () => 99);
	await cache.get("c", async () => 10);
	await cache.get("a", async () => {
		throw new Error("a should be retained");
	});
	expect(await cache.get("b", async () => 20)).toBe(20);
	expect(loads).toBe(1);
	expect(cache.getStats()).toEqual({ entries: 2, estimatedBytes: 30 });
});
test("pixel estimates bound retained resources and oversized values are not retained", async () => {
	const cache = new AsyncResourceCache<number>(10, 20, (value) => value);
	await cache.get("a", async () => 12);
	await cache.get("b", async () => 12);
	expect(cache.getStats()).toEqual({ entries: 1, estimatedBytes: 12 });
	expect(await cache.get("large", async () => 100)).toBe(100);
	expect(cache.getStats()).toEqual({ entries: 1, estimatedBytes: 12 });
});
test("clear prevents pending completions from repopulating an earlier session", async () => {
	const cache = new AsyncResourceCache<number>(2, 100, (value) => value);
	const old = deferred<number>();
	const first = cache.get("same", () => old.promise);
	await Promise.resolve();
	cache.clear();
	await cache.get("same", async () => 20);
	old.resolve(90);
	await first;
	expect(cache.getStats()).toEqual({ entries: 1, estimatedBytes: 20 });
	expect(await cache.get("same", async () => 99)).toBe(20);
});
test("a failed load can be retried without poisoning cache identity", async () => {
	const cache = new AsyncResourceCache<number>(2, 100, (value) => value);
	await expect(
		cache.get("bad", async () => {
			throw new Error("load failed");
		}),
	).rejects.toThrow("load failed");
	expect(cache.getStats().entries).toBe(0);
	expect(await cache.get("bad", async () => 10)).toBe(10);
});
