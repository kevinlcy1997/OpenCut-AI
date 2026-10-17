/** LRU ownership of async resources. Byte sizes are estimates, not allocations. */
export class AsyncResourceCache<T> {
	private entries = new Map<string, { promise: Promise<T>; bytes: number }>();
	private bytes = 0;

	constructor(
		private maxEntries: number,
		private maxBytes: number,
		private sizeOf: (value: T) => number,
	) {
		if (
			!Number.isInteger(maxEntries) ||
			maxEntries < 1 ||
			!Number.isFinite(maxBytes) ||
			maxBytes < 0
		)
			throw new Error("Invalid resource cache budget");
	}

	get(key: string, load: () => Promise<T>): Promise<T> {
		const existing = this.entries.get(key);
		if (existing) {
			this.entries.delete(key);
			this.entries.set(key, existing);
			return existing.promise;
		}
		let entry: { promise: Promise<T>; bytes: number };
		const promise = Promise.resolve()
			.then(load)
			.then(
				(value) => {
					if (this.entries.get(key) === entry) {
						const bytes = this.sizeOf(value);
						if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxBytes)
							this.remove(key);
						else {
							entry.bytes = bytes;
							this.bytes += bytes;
							this.trim();
						}
					}
					return value;
				},
				(error) => {
					if (this.entries.get(key) === entry) this.remove(key);
					throw error;
				},
			);
		entry = { promise, bytes: 0 };
		this.entries.set(key, entry);
		this.trim();
		return promise;
	}

	clear(): void {
		this.entries.clear();
		this.bytes = 0;
	}
	getStats(): { entries: number; estimatedBytes: number } {
		return { entries: this.entries.size, estimatedBytes: this.bytes };
	}
	private remove(key: string): void {
		const entry = this.entries.get(key);
		if (entry) {
			this.bytes -= entry.bytes;
			this.entries.delete(key);
		}
	}
	private trim(): void {
		while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
			const key = this.entries.keys().next().value;
			if (key === undefined) break;
			this.remove(key);
		}
	}
}
