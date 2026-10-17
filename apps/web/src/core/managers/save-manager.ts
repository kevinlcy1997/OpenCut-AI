import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
};

export class SaveManager {
	private debounceMs: number;
	private isPaused = false;
	private isSaving = false;
	private inFlight: Promise<void> | null = null;
	private lastError: string | null = null;
	private hasPendingSave = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];
	private _lastSavedAt: number | null = null;
	private statusListeners = new Set<() => void>();

	constructor(
		private editor: EditorCore,
		{ debounceMs = 800 }: SaveManagerOptions = {},
	) {
		this.debounceMs = debounceMs;
	}

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
		this.clearTimer();
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.hasPendingSave = true;
		this.notifyStatus();
		this.queueSave();
	}

	async suspend(): Promise<() => void> {
		const wasPaused = this.isPaused;
		this.pause();
		try {
			await this.inFlight;
		} catch (error) {
			if (!wasPaused) this.resume();
			throw error;
		}
		return () => {
			if (!wasPaused) this.resume();
		};
	}

	reset(): void {
		if (this.inFlight || this.isSaving)
			throw new Error("Cannot reset an active save");
		this.clearTimer();
		this.hasPendingSave = false;
		this.lastError = null;
		this._lastSavedAt = null;
		this.notifyStatus();
	}

	async flush(): Promise<void> {
		if (this.isPaused) throw new Error("Project saves are paused");
		this.hasPendingSave = true;
		this.clearTimer();
		while (this.hasPendingSave || this.inFlight) {
			if (this.isPaused) throw new Error("Project saves are paused");
			await this.saveNow();
		}
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	getIsSaving(): boolean {
		return this.isSaving;
	}

	getLastError(): string | null {
		return this.lastError;
	}

	getLastSavedAt(): number | null {
		return this._lastSavedAt;
	}

	subscribeStatus(listener: () => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	private notifyStatus(): void {
		for (const listener of this.statusListeners) listener();
	}

	private queueSave(): void {
		if (this.isSaving || this.isPaused) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			void this.saveNow().catch(() => {
				// Keep the project dirty; a later edit or explicit retry can save it.
			});
		}, this.debounceMs);
	}

	private saveNow(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		const operation = this.writePending();
		this.inFlight = operation;
		void operation
			.finally(() => {
				if (this.inFlight === operation) this.inFlight = null;
			})
			.catch(() => {});
		return operation;
	}

	private async writePending(): Promise<void> {
		if (this.isPaused) return;
		if (!this.hasPendingSave) return;

		const activeProject = this.editor.project.getActiveOrNull();
		if (!activeProject) {
			this.hasPendingSave = false;
			return;
		}
		if (this.editor.project.getIsLoading())
			throw new Error("Project is still loading");
		if (this.editor.project.getMigrationState().isMigrating)
			throw new Error("Project migration is in progress");

		this.isSaving = true;
		this.hasPendingSave = false;
		this.clearTimer();
		this.notifyStatus();

		try {
			await this.editor.project.saveCurrentProject();
			this._lastSavedAt = Date.now();
			this.lastError = null;
		} catch (error) {
			this.hasPendingSave = true;
			this.lastError =
				error instanceof Error ? error.message : "Project could not be saved";
			throw error;
		} finally {
			this.isSaving = false;
			this.notifyStatus();
			if (this.hasPendingSave && !this.lastError) {
				this.queueSave();
			}
		}
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
