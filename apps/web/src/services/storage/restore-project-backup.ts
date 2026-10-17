import { restoreJournal, type RestoreSession } from "./restore-journal";
import type { storageService } from "./service";
import { readProjectBackup } from "./project-backup";
import { generateUUID } from "@/utils/id";

type RestoreStorage = Pick<
	typeof storageService,
	"saveMediaAsset" | "saveProject" | "deleteProjectMedia"
>;

/** Publish the project only after every original has been durably stored. */
export async function restoreProjectBackup(
	file: Blob,
	options: {
		storage: RestoreStorage;
		journal?: RestoreSession;
		estimate: () => Promise<StorageEstimate>;
		beforeWrite: () => Promise<void>;
	},
): Promise<string> {
	// Never modify storage for a corrupt or incompatible archive.
	const { project, assets } = await readProjectBackup(file);
	const estimate = await options.estimate();
	const required = assets.reduce((sum, asset) => sum + asset.file.size, 0);
	if (
		estimate.quota !== undefined &&
		required > estimate.quota - (estimate.usage ?? 0)
	)
		throw new Error("Insufficient browser storage to restore this backup");
	await options.beforeWrite();
	const importedId = generateUUID();
	project.metadata = {
		...project.metadata,
		id: importedId,
		name: `${project.metadata.name} (restored)`,
		updatedAt: new Date(),
	};
	await (options.journal ?? restoreJournal).run(importedId, async () => {
		try {
			for (const asset of assets)
				await options.storage.saveMediaAsset({
					projectId: importedId,
					mediaAsset: asset,
				});
			await options.storage.saveProject({ project });
		} catch (error) {
			try {
				await options.storage.deleteProjectMedia({ projectId: importedId });
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Restore failed and temporary media cleanup failed. Browser storage may still contain incomplete restore data; your existing projects are unchanged.",
				);
			}
			throw error;
		}
	});
	return importedId;
}
