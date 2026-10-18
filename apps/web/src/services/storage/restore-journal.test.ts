import { expect, test } from "bun:test";
import { RestoreJournal } from "./restore-journal";
import type { StorageAdapter } from "./types";

function fixture() {
	const entries = new Map<string, { id: string }>();
	const held = new Set<string>();
	const adapter: StorageAdapter<{ id: string }> = {
		get: async (id) => entries.get(id) ?? null,
		set: async (id, value) => {
			entries.set(id, value);
		},
		remove: async (id) => {
			entries.delete(id);
		},
		list: async () => [...entries.keys()],
		clear: async () => {
			entries.clear();
		},
	};
	const locks = {
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
	const journal = new RestoreJournal(adapter, () => locks);
	const deleted: string[] = [],
		published = new Set<string>();
	const recovery = {
		projectExists: async (id: string) => published.has(id),
		deleteMedia: async (id: string) => {
			deleted.push(id);
		},
	};
	return { entries, adapter, locks, journal, recovery, deleted, published };
}

test("journal is durable before writing; successful restore removes it", async () => {
	const f = fixture();
	await f.journal.run("new", async () => {
		expect(f.entries.has("new")).toBe(true);
		f.published.add("new");
	});
	expect(f.entries.size).toBe(0);
});
test("failure leaves a journal recoverable by a later session", async () => {
	const f = fixture();
	await expect(
		f.journal.run("partial", async () => {
			throw new Error("tab lost");
		}),
	).rejects.toThrow("tab lost");
	const laterSession = new RestoreJournal(f.adapter, () => f.locks);
	await laterSession.recover(f.recovery);
	expect(f.deleted).toEqual(["partial"]);
	expect(f.entries.size).toBe(0);
});
test("recovery never removes originals from a committed project", async () => {
	const f = fixture();
	f.entries.set("committed", { id: "committed" });
	f.published.add("committed");
	await f.journal.recover(f.recovery);
	expect(f.deleted).toEqual([]);
	expect(f.entries.size).toBe(0);
});
test("another tab's live restore is skipped until its lease releases", async () => {
	const f = fixture();
	let release!: () => void, entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const running = f.journal.run("live", async () => {
		entered();
		await gate;
		f.published.add("live");
	});
	await started;
	await new RestoreJournal(f.adapter, () => f.locks).recover(f.recovery);
	expect(f.deleted).toEqual([]);
	expect(f.entries.has("live")).toBe(true);
	release();
	await running;
	expect(f.entries.size).toBe(0);
});
test("cleanup failure retains its journal and does not prevent other recovery", async () => {
	const f = fixture();
	f.entries.set("bad", { id: "bad" });
	f.entries.set("good", { id: "good" });
	await expect(
		f.journal.recover({
			...f.recovery,
			deleteMedia: async (id) => {
				if (id === "bad") throw new Error("storage offline");
				f.deleted.push(id);
			},
		}),
	).rejects.toThrow("could not be cleaned up");
	expect(f.entries.has("bad")).toBe(true);
	expect(f.entries.has("good")).toBe(false);
	await f.journal.recover(f.recovery);
	expect(f.entries.size).toBe(0);
});
test("a failed journal registration cannot begin media writes", async () => {
	const f = fixture();
	let wrote = false;
	f.adapter.set = async () => {
		throw new Error("journal quota");
	};
	await expect(
		f.journal.run("new", async () => {
			wrote = true;
		}),
	).rejects.toThrow("journal quota");
	expect(wrote).toBe(false);
});

test("journal removal failure after commit cannot turn a successful restore into data loss", async () => {
	const f = fixture();
	const remove = f.adapter.remove;
	f.adapter.remove = async () => {
		throw new Error("journal removal aborted");
	};
	const result = await f.journal.run("committed", async () => {
		f.published.add("committed");
		return "success";
	});
	expect(result).toBe("success");
	expect(f.entries.has("committed")).toBe(true);
	f.adapter.remove = remove;
	await f.journal.recover(f.recovery);
	expect(f.deleted).toEqual([]);
	expect(f.entries.size).toBe(0);
});
