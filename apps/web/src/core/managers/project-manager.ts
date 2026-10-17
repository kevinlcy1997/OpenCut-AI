import { assertMediaReferences } from "@/services/storage/media-integrity";
import { projectAccess } from "@/services/storage/project-access";
import type { EditorCore } from "@/core";
import type {
	TProject,
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
	TProjectSettings,
	TTimelineViewState,
} from "@/types/project";
import type { ExportOptions, ExportResult, ExportState } from "@/types/export";
import { storageService } from "@/services/storage/service";
import { VersionStorage } from "@/services/storage/version-storage";
import { toast } from "sonner";
import { generateUUID } from "@/utils/id";
import { UpdateProjectSettingsCommand } from "@/lib/commands/project";
import {
	DEFAULT_FPS,
	DEFAULT_CANVAS_SIZE,
	DEFAULT_COLOR,
} from "@/constants/project-constants";
import { buildDefaultScene, getProjectDurationFromScenes } from "@/lib/scenes";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import {
	CURRENT_PROJECT_VERSION,
	migrations,
	runStorageMigrations,
	type MigrationProgress,
} from "@/services/storage/migrations";
import { DEFAULT_TIMELINE_VIEW_STATE } from "@/constants/timeline-constants";
import { loadFonts } from "@/lib/fonts/google-fonts";
import { collectFontFamilies } from "@/lib/timeline/element-utils";

export interface MigrationState {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

export class ProjectManager {
	private active: TProject | null = null;
	private savedProjects: TProjectMetadata[] = [];
	private isLoading = true;
	private isInitialized = false;
	private projectListError: string | null = null;
	private projectListLoad: Promise<void> | null = null;
	private invalidProjectIds = new Set<string>();
	private loadQueue: Promise<void> = Promise.resolve();
	private storageMigrationPromise: Promise<void> | null = null;
	private listeners = new Set<() => void>();
	private migrationState: MigrationState = {
		isMigrating: false,
		fromVersion: null,
		toVersion: null,
		projectName: null,
	};
	private exportState: ExportState = {
		isExporting: false,
		progress: 0,
		result: null,
	};
	private exportCancelRequested = false;
	private exportDone: Promise<void> | null = null;

	constructor(private editor: EditorCore) {}

	private async ensureStorageMigrations(): Promise<void> {
		if (this.storageMigrationPromise) {
			await this.storageMigrationPromise;
			return;
		}

		this.storageMigrationPromise = (async () => {
			await runStorageMigrations({
				migrations,
				onProgress: (progress: MigrationProgress) => {
					this.migrationState = progress;
					this.notify();
				},
			});
		})().catch((error) => {
			this.storageMigrationPromise = null;
			throw error;
		});

		await this.storageMigrationPromise;
	}

	createNewProject({ name }: { name: string }): Promise<string> {
		return this.transition(() => this.createNewProjectNow({ name }));
	}

	private async createNewProjectNow({ name }: { name: string }): Promise<string> {
		await this.stopExportBeforeNavigation();
		if (this.active) await this.editor.save.flush();
		const mainScene = buildDefaultScene({ name: "Main scene", isMain: true });
		const newProject: TProject = {
			metadata: {
				id: generateUUID(),
				name,
				duration: getProjectDurationFromScenes({ scenes: [mainScene] }),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			scenes: [mainScene],
			currentSceneId: mainScene.id,
			settings: {
				fps: DEFAULT_FPS,
				canvasSize: DEFAULT_CANVAS_SIZE,
				originalCanvasSize: null,
				background: {
					type: "color",
					color: DEFAULT_COLOR,
				},
			},
			version: CURRENT_PROJECT_VERSION,
		};

		try {
			await storageService.saveProject({ project: newProject });
		} catch (error) {
			toast.error("Failed to save new project");
			throw error;
		}
		if (this.active) projectAccess.release(this.active.metadata.id);
		this.active = newProject;
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.scenes.initializeScenes({
			scenes: newProject.scenes,
			currentSceneId: newProject.currentSceneId,
		});

		this.updateMetadata(newProject);
		return newProject.metadata.id;
	}

	private transition<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.loadQueue.then(operation);
		this.loadQueue = result.then(() => {}, () => {});
		return result;
	}

	loadProject({ id }: { id: string }): Promise<void> {
		return this.transition(() => this.loadProjectNow({ id }));
	}

	private async loadProjectNow({ id }: { id: string }): Promise<void> {
		await this.stopExportBeforeNavigation();
		// Acquire before clearing the current project or reading a stale snapshot.
		await projectAccess.hold(id);
		const previousId = this.active?.metadata.id;
		try {
			if (this.active && !this.isLoading) await this.editor.save.flush();
		} catch (error) {
			if (id !== previousId) projectAccess.release(id);
			throw error;
		}
		if (previousId && previousId !== id) projectAccess.release(previousId);
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		this.editor.save.pause();

		try {
			await this.ensureStorageMigrations();
			this.editor.media.clearAllAssets();
			this.editor.scenes.clearScenes();
			const result = await storageService.loadProject({ id });
			if (!result) {
				throw new Error(`Project with id ${id} not found`);
			}

			const project = result.project;

			this.active = project;
			this.notify();

			if (project.scenes && project.scenes.length > 0) {
				this.editor.scenes.initializeScenes({
					scenes: project.scenes,
					currentSceneId: project.currentSceneId,
				});
			}

			await this.editor.media.loadProjectMedia({ projectId: id });
			assertMediaReferences(project.scenes, new Set(this.editor.media.getAssets().map((asset) => asset.id)));

			const allTracks = (project.scenes ?? []).flatMap((scene) => scene.tracks);
			await loadFonts({ families: collectFontFamilies({ tracks: allTracks }) });

			if (!project.metadata.thumbnail) {
				const didUpdateThumbnail = await this.updateThumbnailFromTimeline();
				if (didUpdateThumbnail) {
					await this.saveCurrentProject();
				}
			}
		} catch (error) {
			console.error("Failed to load project:", error);
			this.active = null;
			this.editor.media.clearAllAssets();
			this.editor.scenes.clearScenes();
			projectAccess.release(id);
			throw error;
		} finally {
			this.isLoading = false;
			this.notify();
			this.editor.save.resume();
		}
	}

	async saveCurrentProject(): Promise<void> {
		if (!this.active) return;

		try {
			const active = this.active;
			const scenes = this.editor.scenes.getScenes();
			const updatedProject = {
				...this.active,
				scenes,
				metadata: {
					...this.active.metadata,
					duration: getProjectDurationFromScenes({ scenes }),
					updatedAt: new Date(),
				},
			};

			await storageService.saveProject({ project: updatedProject });
			// Keep settings/metadata changed while this snapshot was being written.
			if (this.active === active) {
				this.active = updatedProject;
				this.updateMetadata(updatedProject);
			}
		} catch (error) {
			console.error("Failed to save project:", error);
			throw error;
		}
	}

	async export({ options }: { options: ExportOptions }): Promise<ExportResult> {
		if (this.exportState.isExporting) return { success: false, error: "An export is already running" };
		let finish!: () => void;
		this.exportDone = new Promise<void>((resolve) => { finish = resolve; });
		this.exportCancelRequested = false;
		this.exportState = { isExporting: true, progress: 0, result: null };
		this.notify();
		let result: ExportResult = { success: false, error: "Export did not finish" };
		try {
			result = await this.editor.renderer.exportProject({
				options,
				onProgress: ({ progress }) => {
					this.exportState = { ...this.exportState, progress };
					this.notify();
				},
				onCancel: () => this.exportCancelRequested,
			});
			if (this.exportCancelRequested) result = { success: false, cancelled: true };
		} catch (error) {
			result = this.exportCancelRequested ? { success: false, cancelled: true } : { success: false, error: error instanceof Error ? error.message : "Export failed" };
		} finally {
			this.exportDone = null;
			finish();
			this.exportState = { isExporting: false, progress: this.exportState.progress, result };
			this.notify();
		}
		return result;
	}

	private async stopExportBeforeNavigation(): Promise<void> {
		const done = this.exportDone;
		if (!done) return;
		this.cancelExport();
		await done;
	}

	cancelExport(): void {
		if (!this.exportState.isExporting) return;
		this.exportCancelRequested = true;
		this.exportState = { ...this.exportState, cancelRequested: true };
		this.notify();
	}

	clearExportState(): void {
		if (this.exportState.isExporting) return;
		this.exportState = { isExporting: false, progress: 0, result: null };
		this.notify();
	}

	getExportState(): ExportState {
		return this.exportState;
	}

	loadAllProjects(): Promise<void> {
		if (this.projectListLoad) return this.projectListLoad;
		this.projectListLoad = Promise.resolve().then(() => this.loadProjectList()).finally(() => {
			this.projectListLoad = null;
		});
		return this.projectListLoad;
	}

	private async loadProjectList(): Promise<void> {
		this.isLoading = true;
		this.projectListError = null;
		this.notify();
		try {
			await this.ensureStorageMigrations();
			try {
				await storageService.recoverInterruptedRestores();
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Interrupted restore cleanup failed");
			}
			const metadata = await storageService.loadAllProjectsMetadata();
			this.savedProjects = metadata;
			this.isInitialized = true;
		} catch (error) {
			this.projectListError = error instanceof Error ? error.message : "Browser storage could not be read";
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	getProjectListError(): string | null {
		return this.projectListError;
	}

	deleteProjects({ ids }: { ids: string[] }): Promise<void> {
		return this.transition(() => this.deleteProjectsNow({ ids }));
	}

	private async deleteProjectsNow({ ids }: { ids: string[] }): Promise<void> {
		await this.stopExportBeforeNavigation();
		const uniqueIds = Array.from(new Set(ids));
		if (!uniqueIds.length) return;
		const deletingActive = !!this.active && uniqueIds.includes(this.active.metadata.id);
		const resume = deletingActive ? await this.editor.save.suspend() : () => {};
		try {
			for (const id of uniqueIds) {
				const keepLease = this.active?.metadata.id === id;
				await projectAccess.hold(id);
				try {
					// Finish file removal before removing the project record. A failure
					// keeps the record available for backup-based recovery.
					await storageService.deleteProjectMedia({ projectId: id });
					await storageService.deleteProject({ id });
					await new VersionStorage(id).deleteDatabase().catch(() => {});
					this.savedProjects = this.savedProjects.filter((project) => project.id !== id);
					if (this.active?.metadata.id === id) {
						this.active = null;
						this.editor.media.clearAllAssets();
						this.editor.scenes.clearScenes();
						this.editor.save.reset();
						projectAccess.release(id);
					}
					this.notify();
				} finally {
					if (!keepLease) projectAccess.release(id);
				}
			}
		} catch (error) {
			console.error("Failed to delete projects:", error);
			toast.error(error instanceof Error ? error.message : "Failed to delete projects");
			throw error;
		} finally {
			resume();
		}
	}

	closeProject(): void {
		if (this.active) projectAccess.release(this.active.metadata.id);
		this.active = null;
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.scenes.clearScenes();
	}

	async renameProject({
		id,
		name,
	}: {
		id: string;
		name: string;
	}): Promise<void> {
		try {
			const result = await storageService.loadProject({ id });
			if (!result) {
				toast.error("Project not found", {
					description: "Please try again",
				});
				return;
			}

			const updatedProject: TProject = {
				...result.project,
				metadata: {
					...result.project.metadata,
					name,
					updatedAt: new Date(),
				},
			};

			await storageService.saveProject({ project: updatedProject });

			if (this.active?.metadata.id === id) {
				this.active = updatedProject;
				this.notify();
			}

			this.updateMetadata(updatedProject);
		} catch (error) {
			console.error("Failed to rename project:", error);
			toast.error("Failed to rename project", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
		}
	}

	async duplicateProjects({ ids }: { ids: string[] }): Promise<string[]> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return [];

		try {
			const getDuplicateBaseName = ({ name }: { name: string }) => {
				const match = name.match(/^\((\d+)\)\s+(.+)$/);
				const number = match ? Number.parseInt(match[1], 10) : null;
				const baseName = match ? match[2] : name;
				return { baseName, number };
			};

			const loadResults = await Promise.all(
				uniqueIds.map(async (projectId) => {
					const result = await storageService.loadProject({ id: projectId });
					return { projectId, project: result?.project ?? null };
				}),
			);

			const missingProjectIds = loadResults
				.filter((result) => !result.project)
				.map((result) => result.projectId);

			if (missingProjectIds.length > 0) {
				toast.error(
					missingProjectIds.length === 1
						? "Project not found"
						: "Projects not found",
					{
						description:
							missingProjectIds.length === 1
								? "Please try again"
								: "Some projects could not be found",
					},
				);
				throw new Error(`Projects not found: ${missingProjectIds.join(", ")}`);
			}

			const projectsToDuplicate = loadResults.flatMap((result) =>
				result.project ? [result.project] : [],
			);

			const maxNumberByBaseName = new Map<string, number>();

			for (const project of this.savedProjects) {
				const { baseName, number } = getDuplicateBaseName({
					name: project.name,
				});

				if (number === null) continue;

				const currentMax = maxNumberByBaseName.get(baseName);
				if (currentMax === undefined || number > currentMax) {
					maxNumberByBaseName.set(baseName, number);
				}
			}

			const nextNumberByBaseName = new Map<string, number>();
			for (const [baseName, maxNumber] of maxNumberByBaseName) {
				nextNumberByBaseName.set(baseName, maxNumber + 1);
			}

			const duplicationPlans = projectsToDuplicate.map((project) => {
				const { baseName } = getDuplicateBaseName({
					name: project.metadata.name,
				});
				const nextNumber = nextNumberByBaseName.get(baseName) ?? 1;
				nextNumberByBaseName.set(baseName, nextNumber + 1);

				const newProjectId = generateUUID();
				const newProject: TProject = {
					...project,
					metadata: {
						...project.metadata,
						id: newProjectId,
						name: `(${nextNumber}) ${baseName}`,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				};

				return {
					newProjectId,
					newProject,
					sourceProjectId: project.metadata.id,
				};
			});

			await Promise.all(
				duplicationPlans.map(({ newProject }) =>
					storageService.saveProject({ project: newProject }),
				),
			);

			await Promise.all(
				duplicationPlans.map(async ({ sourceProjectId, newProjectId }) => {
					const sourceMediaAssets = await storageService.loadAllMediaAssets({
						projectId: sourceProjectId,
					});

					await Promise.all(
						sourceMediaAssets.map((mediaAsset) =>
							storageService.saveMediaAsset({
								projectId: newProjectId,
								mediaAsset,
							}),
						),
					);
				}),
			);

			for (const { newProject } of duplicationPlans) {
				this.updateMetadata(newProject);
			}

			return duplicationPlans.map((plan) => plan.newProjectId);
		} catch (error) {
			console.error("Failed to duplicate projects:", error);
			toast.error("Failed to duplicate projects", {
				description:
					error instanceof Error ? error.message : "Please try again",
			});
			throw error;
		}
	}

	async updateSettings({
		settings,
		pushHistory = true,
	}: {
		settings: Partial<TProjectSettings>;
		pushHistory?: boolean;
	}): Promise<void> {
		if (!this.active) return;

		const command = new UpdateProjectSettingsCommand(settings);
		if (pushHistory) {
			this.editor.command.execute({ command });
			return;
		}

		command.execute();
	}

	async updateThumbnail({ thumbnail }: { thumbnail: string }): Promise<void> {
		if (!this.active) return;

		const updatedProject: TProject = {
			...this.active,
			metadata: { ...this.active.metadata, thumbnail, updatedAt: new Date() },
		};
		this.active = updatedProject;
		this.notify();
		this.updateMetadata(updatedProject);
		this.editor.save.markDirty();
	}

	async prepareExit(): Promise<void> {
		await this.stopExportBeforeNavigation();
		if (!this.active) return;

		try {
			await this.updateThumbnailFromTimeline();
		} catch (error) {
			console.error("Failed to generate project thumbnail on exit:", error);
		}
		await this.editor.save.flush();
	}

	getFilteredAndSortedProjects({
		searchQuery,
		sortOption,
	}: {
		searchQuery: string;
		sortOption: TProjectSortOption;
	}): TProjectMetadata[] {
		const filteredProjects = this.savedProjects.filter((project) =>
			project.name.toLowerCase().includes(searchQuery.toLowerCase()),
		);

		const [key, order] = sortOption.split("-") as [
			TProjectSortKey,
			"asc" | "desc",
		];

		const sortedProjects = [...filteredProjects].sort((a, b) => {
			const aValue = a[key];
			const bValue = b[key];

			if (order === "asc") {
				if (aValue < bValue) return -1;
				if (aValue > bValue) return 1;
				return 0;
			}
			if (aValue > bValue) return -1;
			if (aValue < bValue) return 1;
			return 0;
		});

		return sortedProjects;
	}

	isInvalidProjectId({ id }: { id: string }): boolean {
		return this.invalidProjectIds.has(id);
	}

	markProjectIdAsInvalid({ id }: { id: string }): void {
		this.invalidProjectIds.add(id);
		this.notify();
	}

	clearInvalidProjectIds(): void {
		this.invalidProjectIds.clear();
		this.notify();
	}

	getActive(): TProject {
		if (!this.active) {
			throw new Error("No active project");
		}
		return this.active;
	}

	/**
	 * for agents:
	 * in most cases, the project is guaranteed to be active, in which getActive() should be used instead.
	 * for very rare cases, this function may be used.
	 */
	getActiveOrNull(): TProject | null {
		return this.active;
	}

	getTimelineViewState(): TTimelineViewState {
		return this.active?.timelineViewState ?? DEFAULT_TIMELINE_VIEW_STATE;
	}

	setTimelineViewState({ viewState }: { viewState: TTimelineViewState }): void {
		if (!this.active) return;
		this.active = {
			...this.active,
			timelineViewState: viewState ?? undefined,
		};
		this.editor.save.markDirty();
	}

	getSavedProjects(): TProjectMetadata[] {
		return this.savedProjects;
	}

	getIsLoading(): boolean {
		return this.isLoading;
	}

	getIsInitialized(): boolean {
		return this.isInitialized;
	}

	getMigrationState(): MigrationState {
		return this.migrationState;
	}

	setActiveProject({ project }: { project: TProject }): void {
		this.active = project;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async updateThumbnailFromTimeline(): Promise<boolean> {
		if (!this.active) return false;

		const tracks = this.editor.timeline.getTracks();
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();

		if (duration === 0) return false;

		const { canvasSize, background } = this.active.settings;

		const scene = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize,
			background,
		});

		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps: this.active.settings.fps,
		});

		const tempCanvas = document.createElement("canvas");
		tempCanvas.width = canvasSize.width;
		tempCanvas.height = canvasSize.height;

		await renderer.renderToCanvas({
			node: scene,
			time: 0,
			targetCanvas: tempCanvas,
		});

		const thumbnailDataUrl = tempCanvas.toDataURL("image/png");

		await this.updateThumbnail({ thumbnail: thumbnailDataUrl });
		return true;
	}

	private updateMetadata(project: TProject): void {
		const index = this.savedProjects.findIndex(
			(p) => p.id === project.metadata.id,
		);

		if (index !== -1) {
			this.savedProjects[index] = project.metadata;
		} else {
			this.savedProjects = [project.metadata, ...this.savedProjects];
		}

		this.notify();
	}

	private notify(): void {
		this.listeners.forEach((fn) => fn());
	}
}
