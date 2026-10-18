"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/hooks/use-editor";
import { storageService } from "@/services/storage/service";
import { createProjectBackup } from "@/services/storage/project-backup";
import { restoreProjectBackup } from "@/services/storage/restore-project-backup";

export function ProjectBackupControls({
	allowDownload = false,
}: {
	allowDownload?: boolean;
}) {
	const editor = useEditor();
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const download = async () => {
		setBusy(true);
		try {
			await editor.save.flush();
			const project = editor.project.getActive();
			const assets = await storageService.loadAllMediaAssets({
				projectId: project.metadata.id,
			});
			try {
				const blob = await createProjectBackup(project, assets);
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = `${project.metadata.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.ocbackup`;
				link.click();
				setTimeout(() => URL.revokeObjectURL(url), 60_000);
			} finally {
				for (const asset of assets) {
					if (asset.url) URL.revokeObjectURL(asset.url);
					if (asset.thumbnailUrl?.startsWith("blob:"))
						URL.revokeObjectURL(asset.thumbnailUrl);
				}
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Backup failed");
		} finally {
			setBusy(false);
		}
	};
	const restore = async (file: File) => {
		setBusy(true);
		try {
			const importedId = await restoreProjectBackup(file, {
				storage: storageService,
				estimate: () => navigator.storage.estimate(),
				beforeWrite: () => editor.save.flush(),
			});
			await editor.project.loadAllProjects();
			router.push(`/editor/${importedId}`);
			toast.success("Backup restored as a new project");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Restore failed");
		} finally {
			setBusy(false);
			if (input.current) input.current.value = "";
		}
	};
	return (
		<div className="flex flex-wrap gap-2">
			{allowDownload && (
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => {
						void download();
					}}
				>
					Download project backup
				</Button>
			)}
			<Button
				variant="outline"
				size="sm"
				disabled={busy}
				onClick={() => input.current?.click()}
			>
				{busy ? "Processing backup…" : "Restore project backup"}
			</Button>
			<input
				ref={input}
				type="file"
				accept=".ocbackup"
				className="hidden"
				aria-label="Project backup file"
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) void restore(file);
				}}
			/>
		</div>
	);
}
