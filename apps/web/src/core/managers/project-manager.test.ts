import { SaveManager } from "./save-manager";
import { projectAccess } from "@/services/storage/project-access";
import { VersionStorage } from "@/services/storage/version-storage";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { ExportResult } from "@/types/export";
import type { TProject } from "@/types/project";
import { ProjectManager } from "./project-manager";
import { storageService } from "@/services/storage/service";

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const options = { format: "mp4" as const, quality: "high" as const };

describe("project failure recovery", () => {
	test("a renderer exception leaves export idle and retryable", async () => {
		let fail = true;
		const editor = {
			renderer: {
				exportProject: async () => {
					if (fail) throw new Error("Encoder crashed");
					return { success: true, buffer: new ArrayBuffer(1) };
				},
			},
		} as unknown as EditorCore;
		const manager = new ProjectManager(editor);
		expect(await manager.export({ options })).toEqual({
			success: false,
			error: "Encoder crashed",
		});
		expect(manager.getExportState().isExporting).toBe(false);
		fail = false;
		expect((await manager.export({ options })).success).toBe(true);
	});
	test("rejects overlapping exports without resetting the active cancellation flag", async () => {
		const output = deferred<ExportResult>();
		let cancel!: () => boolean;
		const editor = {
			renderer: {
				exportProject: ({ onCancel }: { onCancel: () => boolean }) => {
					cancel = onCancel;
					return output.promise;
				},
			},
		} as unknown as EditorCore;
		const manager = new ProjectManager(editor);
		const exporting = manager.export({ options });
		manager.cancelExport();
		expect((await manager.export({ options })).error).toContain(
			"already running",
		);
		expect(cancel()).toBe(true);
		expect(manager.getExportState().isExporting).toBe(true);
		output.resolve({ success: false, cancelled: true });
		await exporting;
		expect(manager.getExportState().isExporting).toBe(false);
	});
	test("a late save never overwrites settings changed while storage was writing", async () => {
		const output = deferred<void>();
		const saving = spyOn(storageService, "saveProject").mockImplementation(
			() => output.promise,
		);
		restores.push(() => saving.mockRestore());
		const editor = { scenes: { getScenes: () => [] } } as unknown as EditorCore;
		const manager = new ProjectManager(editor);
		const project = {
			metadata: { id: "project", name: "Original", duration: 0 },
			settings: { fps: 30 },
			scenes: [],
		} as unknown as TProject;
		manager.setActiveProject({ project });
		const pending = manager.saveCurrentProject();
		const changed = { ...project, settings: { ...project.settings, fps: 60 } };
		manager.setActiveProject({ project: changed });
		output.resolve();
		await pending;
		expect(manager.getActive().settings.fps).toBe(60);
		expect(manager.getActive()).toBe(changed);
	});
});

test("closing the popup cannot clear a running export or permit a competing retry", async () => {
	const output = deferred<ExportResult>();
	const manager = new ProjectManager({
		renderer: { exportProject: () => output.promise },
	} as unknown as EditorCore);
	const active = manager.export({ options });
	manager.cancelExport();
	manager.clearExportState();
	expect(manager.getExportState().isExporting).toBe(true);
	expect(manager.getExportState().cancelRequested).toBe(true);
	expect((await manager.export({ options })).error).toContain(
		"already running",
	);
	// A completion racing the encoder poll must still honour the user's cancel.
	output.resolve({ success: true, buffer: new ArrayBuffer(1) });
	expect(await active).toEqual({ success: false, cancelled: true });
	expect(manager.getExportState().isExporting).toBe(false);
	manager.clearExportState();
	expect(manager.getExportState().result).toBeNull();
});

test("deleting the active project waits for autosave and cannot resurrect it", async () => {
	const writing = deferred<void>();
	const events: string[] = [];
	const spies = [
		spyOn(storageService, "saveProject").mockImplementation(async () => {
			events.push("save-start");
			await writing.promise;
			events.push("save-finished");
		}),
		spyOn(storageService, "deleteProjectMedia").mockImplementation(async () => {
			events.push("media-delete");
		}),
		spyOn(storageService, "deleteProject").mockImplementation(async () => {
			events.push("project-delete");
		}),
		spyOn(projectAccess, "hold").mockResolvedValue(),
		spyOn(projectAccess, "release").mockImplementation(() => {}),
		spyOn(VersionStorage.prototype, "deleteDatabase").mockResolvedValue(),
	];
	for (const spy of spies) restores.push(() => spy.mockRestore());
	let manager!: ProjectManager;
	let save!: SaveManager;
	const editor = {
		get project() {
			return manager;
		},
		get save() {
			return save;
		},
		scenes: { getScenes: () => [], clearScenes: () => {} },
		media: { clearAllAssets: () => {} },
	} as unknown as EditorCore;
	manager = new ProjectManager(editor);
	save = new SaveManager(editor, { debounceMs: 1 });
	const loading = spyOn(manager, "getIsLoading").mockReturnValue(false);
	restores.push(() => loading.mockRestore());
	manager.setActiveProject({
		project: {
			metadata: { id: "project", name: "Test", duration: 0 },
			scenes: [],
			settings: {},
		} as unknown as TProject,
	});
	save.markDirty();
	await new Promise((done) => setTimeout(done, 5));
	save.markDirty();
	const deleting = manager.deleteProjects({ ids: ["project"] });
	await new Promise((done) => setTimeout(done, 5));
	expect(events).toEqual(["save-start"]);
	writing.resolve();
	await deleting;
	await new Promise((done) => setTimeout(done, 10));
	expect(events).toEqual([
		"save-start",
		"save-finished",
		"media-delete",
		"project-delete",
	]);
	expect(manager.getActiveOrNull()).toBeNull();
	expect(save.getIsDirty()).toBe(false);
	save.stop();
});

test("failed new-project persistence leaves the previous project active", async () => {
	const previous = { metadata: { id: "old" } } as unknown as TProject;
	let cleared = false;
	const manager = new ProjectManager({
		save: { flush: async () => {} },
		scenes: { initializeScenes: () => {} },
		media: {
			clearAllAssets: () => {
				cleared = true;
			},
		},
	} as unknown as EditorCore);
	manager.setActiveProject({ project: previous });
	const saving = spyOn(storageService, "saveProject").mockRejectedValue(
		new Error("Storage full"),
	);
	restores.push(() => saving.mockRestore());
	await expect(manager.createNewProject({ name: "New" })).rejects.toThrow(
		"Storage full",
	);
	expect(manager.getActive()).toBe(previous);
	expect(cleared).toBe(false);
	saving.mockResolvedValue();
	await manager.createNewProject({ name: "Retry" });
	expect(manager.getActive().metadata.name).toBe("Retry");
	expect(cleared).toBe(true);
});

test("project creation waits for the active export to release its media", async () => {
 const output = deferred<ExportResult>();
 const saved: string[] = [];
 const saving = spyOn(storageService, "saveProject").mockImplementation(async ({project}) => { saved.push(project.metadata.name); });
 restores.push(() => saving.mockRestore());
 const manager = new ProjectManager({ renderer: { exportProject: () => output.promise }, save: { flush: async () => {} }, media: { clearAllAssets: () => {} }, scenes: { initializeScenes: () => {} } } as unknown as EditorCore);
 const exporting = manager.export({options});
 const creating = manager.createNewProject({name:"Next project"});
 await new Promise((done) => setTimeout(done, 0));
 expect(manager.getExportState().cancelRequested).toBe(true);
 expect(saved).toEqual([]);
 output.resolve({success:false,cancelled:true});
 await exporting; await creating;
 expect(saved).toEqual(["Next project"]);
});

test("project list read failures remain visible and a retry restores the list", async () => {
	const manager = new ProjectManager({} as EditorCore);
	const migration = spyOn(manager as unknown as { ensureStorageMigrations(): Promise<void> }, "ensureStorageMigrations").mockResolvedValue();
	const recovery = spyOn(storageService, "recoverInterruptedRestores").mockResolvedValue();
	const listing = spyOn(storageService, "loadAllProjectsMetadata").mockRejectedValue(new Error("storage unavailable"));
	restores.push(() => migration.mockRestore(), () => recovery.mockRestore(), () => listing.mockRestore());
	await manager.loadAllProjects();
	expect(manager.getIsLoading()).toBe(false);
	expect(manager.getIsInitialized()).toBe(false);
	expect(manager.getProjectListError()).toBe("storage unavailable");
	const metadata = { id: "saved", name: "Saved" } as TProject["metadata"];
	listing.mockResolvedValue([metadata]);
	await manager.loadAllProjects();
	expect(manager.getSavedProjects()).toEqual([metadata]);
	expect(manager.getProjectListError()).toBeNull();
	expect(manager.getIsInitialized()).toBe(true);
	listing.mockRejectedValue(new Error("refresh failed"));
	await manager.loadAllProjects();
	expect(manager.getSavedProjects()).toEqual([metadata]);
	expect(manager.getProjectListError()).toBe("refresh failed");
});

test("migration failure settles project loading and permits retry", async () => {
	const manager = new ProjectManager({} as EditorCore);
	const migration = spyOn(manager as unknown as { ensureStorageMigrations(): Promise<void> }, "ensureStorageMigrations").mockRejectedValue(new Error("migration read failed"));
	const recovery = spyOn(storageService, "recoverInterruptedRestores").mockResolvedValue();
	const listing = spyOn(storageService, "loadAllProjectsMetadata").mockResolvedValue([]);
	restores.push(() => migration.mockRestore(), () => recovery.mockRestore(), () => listing.mockRestore());
	await manager.loadAllProjects();
	expect(manager.getIsLoading()).toBe(false);
	expect(manager.getProjectListError()).toBe("migration read failed");
	expect(listing).not.toHaveBeenCalled();
	migration.mockResolvedValue();
	const first = manager.loadAllProjects();
	const second = manager.loadAllProjects();
	expect(first).toBe(second);
	await first;
	expect(listing).toHaveBeenCalledTimes(1);
	expect(manager.getProjectListError()).toBeNull();
});
