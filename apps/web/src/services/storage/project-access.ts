/** A browser-owned lease is released automatically when its tab closes/crashes. */
export class ProjectAccess {
	private leases = new Map<
		string,
		{ release: () => void; writes: number; closing: boolean }
	>();
	constructor(
		private locks: () => LockManager | undefined = () => navigator.locks,
	) {}

	private manager(): LockManager {
		const locks = this.locks();
		if (!locks)
			throw new Error(
				"Safe project editing requires browser Web Locks. Use a current desktop browser on localhost or HTTPS.",
			);
		return locks;
	}

	async hold(id: string): Promise<void> {
		const existing = this.leases.get(id);
		if (existing?.closing)
			throw new Error(
				"A project storage write is finishing. Retry loading shortly.",
			);
		if (existing) return;
		const locks = this.manager();
		await new Promise<void>((resolve, reject) => {
			void locks
				.request(
					`opencut-project:${id}`,
					{ mode: "exclusive", ifAvailable: true },
					async (lock) => {
						if (!lock) {
							reject(
								new Error(
									"This project is open in another tab. Close it there, then retry here.",
								),
							);
							return;
						}
						await new Promise<void>((release) => {
							this.leases.set(id, { release, writes: 0, closing: false });
							resolve();
						});
					},
				)
				.catch(reject);
		});
	}

	release(id: string): void {
		const lease = this.leases.get(id);
		if (!lease) return;
		lease.closing = true;
		if (lease.writes === 0) {
			this.leases.delete(id);
			lease.release();
		}
	}

	async write<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const lease = this.leases.get(id);
		if (lease && !lease.closing) {
			lease.writes++;
			try {
				return await operation();
			} finally {
				lease.writes--;
				if (lease.closing) this.release(id);
			}
		}
		return this.manager().request(
			`opencut-project:${id}`,
			{ mode: "exclusive", ifAvailable: true },
			async (lock) => {
				if (!lock)
					throw new Error(
						"This project is open in another tab. Close it there before changing or deleting it.",
					);
				return operation();
			},
		);
	}
}

export const projectAccess = new ProjectAccess();
