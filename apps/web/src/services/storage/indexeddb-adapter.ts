import type { StorageAdapter } from "./types";

export class IndexedDBAdapter<T> implements StorageAdapter<T> {
	private dbName: string;
	private storeName: string;
	private version: number;

	constructor(dbName: string, storeName: string, version = 1) {
		this.dbName = dbName;
		this.storeName = storeName;
		this.version = version;
	}

	private async getDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, this.version);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				request.result.onversionchange = () => request.result.close();
				resolve(request.result);
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName, { keyPath: "id" });
				}
			};
		});
	}

	private async transact<R>(
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore) => IDBRequest<R>,
	): Promise<R> {
		const db = await this.getDB();
		return new Promise<R>((resolve, reject) => {
			let transaction: IDBTransaction;
			let result: R;
			try {
				transaction = db.transaction([this.storeName], mode);
				transaction.oncomplete = () => {
					db.close();
					resolve(result);
				};
				transaction.onabort = () => {
					db.close();
					reject(transaction.error ?? new Error("Storage transaction aborted"));
				};
				const request = operation(transaction.objectStore(this.storeName));
				request.onsuccess = () => {
					result = request.result;
				};
				// Request success precedes commit. Only oncomplete proves durability.
				// Request errors bubble to the transaction and cause an abort.
			} catch (error) {
				db.close();
				reject(error);
			}
		});
	}

	async get(key: string): Promise<T | null> {
		return (
			(await this.transact<T | undefined>("readonly", (store) =>
				store.get(key),
			)) ?? null
		);
	}

	async set(key: string, value: T): Promise<void> {
		await this.transact("readwrite", (store) =>
			store.put({ ...value, id: key }),
		);
	}

	/** Synchronous read/modify/write in one transaction, resolved only on commit. */
	async update(key: string, change: (value: T) => T): Promise<T> {
		const db = await this.getDB();
		return new Promise<T>((resolve, reject) => {
			let result: T;
			let failure: unknown;
			try {
				const transaction = db.transaction([this.storeName], "readwrite");
				transaction.oncomplete = () => {
					db.close();
					resolve(result);
				};
				transaction.onabort = () => {
					db.close();
					reject(
						failure ??
							transaction.error ??
							new Error("Storage transaction aborted"),
					);
				};
				const store = transaction.objectStore(this.storeName);
				const request = store.get(key);
				request.onsuccess = () => {
					try {
						if (request.result === undefined)
							throw new Error("Stored record is missing");
						result = change(request.result);
						store.put({ ...result, id: key });
					} catch (error) {
						failure = error;
						transaction.abort();
					}
				};
			} catch (error) {
				db.close();
				reject(error);
			}
		});
	}

	async remove(key: string): Promise<void> {
		await this.transact("readwrite", (store) => store.delete(key));
	}

	async list(): Promise<string[]> {
		return (await this.transact("readonly", (store) =>
			store.getAllKeys(),
		)) as string[];
	}

	async getAll(): Promise<T[]> {
		return await this.transact("readonly", (store) => store.getAll());
	}

	async clear(): Promise<void> {
		await this.transact("readwrite", (store) => store.clear());
	}
}

export async function deleteDatabase({
	dbName,
}: {
	dbName: string;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(dbName);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}
