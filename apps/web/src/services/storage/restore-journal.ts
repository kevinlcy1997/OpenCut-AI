import { IndexedDBAdapter } from "./indexeddb-adapter";
import type { StorageAdapter } from "./types";

type Entry = { id: string };
export type RestoreSession = {
	run<T>(id: string, operation: () => Promise<T>): Promise<T>;
};

/** A separate lease distinguishes a live restore in another tab from an abandoned one. */
export class RestoreJournal implements RestoreSession {
	constructor(
		private entries: StorageAdapter<Entry>,
		private locks: () => LockManager = () => navigator.locks,
	) {}

	async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
		return this.locks().request(
			`opencut-restore:${id}`,
			{ mode: "exclusive" },
			async () => {
				// Durably register before any original bytes can be written.
				await this.entries.set(id, { id });
				const result = await operation();
				// If this fails, recovery will see the published project and retain it.
				try {
					await this.entries.remove(id);
				} catch (error) {
					console.warn("Restore completed; journal cleanup will retry", error);
				}
				return result;
			},
		);
	}

	async recover(options: {
		projectExists: (id: string) => Promise<boolean>;
		deleteMedia: (id: string) => Promise<void>;
	}): Promise<void> {
		const errors: unknown[] = [];
		for (const id of await this.entries.list()) {
			try {
				await this.locks().request(
					`opencut-restore:${id}`,
					{ mode: "exclusive", ifAvailable: true },
					async (lock) => {
						if (!lock || !(await this.entries.get(id))) return;
						// Project publication is the commit point. Never delete its originals.
						if (!(await options.projectExists(id)))
							await options.deleteMedia(id);
						await this.entries.remove(id);
					},
				);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length)
			throw new AggregateError(
				errors,
				"Some interrupted restores could not be cleaned up. Existing projects are preserved; retry after resolving browser storage access.",
			);
	}
}

export const restoreJournal = new RestoreJournal(
	new IndexedDBAdapter<Entry>("video-editor-restore-journal", "restores"),
);
