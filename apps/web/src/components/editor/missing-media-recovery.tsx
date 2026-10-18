"use client";

import { useState } from "react";
import { toast } from "sonner";
import { storageService } from "@/services/storage/service";
import type { MissingMediaError } from "@/services/storage/media-integrity";

export function MissingMediaRecovery({
	projectId,
	missing,
}: {
	projectId: string;
	missing: MissingMediaError["missing"];
}) {
	const [busy, setBusy] = useState(false);
	const reconnect = async (files: File[]) => {
		setBusy(true);
		try {
			let count = 0;
			for (const entry of missing) {
				const match = files.find(
					(file) => file.name === (entry.originalName ?? entry.name) && file.size === entry.size,
				);
				if (!match) continue;
				await storageService.reconnectMediaFile({
					projectId,
					id: entry.id,
					file: match,
				});
				count++;
			}
			if (!count)
				throw new Error(
					"No matching originals selected. File names and sizes must match the missing originals.",
				);
			toast.success(`Reconnected ${count} original file(s)`);
			window.location.reload();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Reconnect failed");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="max-w-xl space-y-3">
			<p className="text-sm">
				Choose the original files below. Existing timeline edits are preserved.
			</p>
			<ul className="text-xs max-h-48 overflow-auto">
				{missing.map((entry) => (
					<li key={entry.id}>
						{entry.originalName ?? entry.name} · {entry.size.toLocaleString()} bytes
					</li>
				))}
			</ul>
			<label className="block text-sm">
				Reconnect original files
				<input
					type="file"
					multiple
					disabled={busy}
					aria-label="Reconnect original files"
					className="block mt-2"
					onChange={(event) => {
						const files = Array.from(event.target.files ?? []);
						if (files.length) void reconnect(files);
					}}
				/>
			</label>
			{busy && <p role="status">Reconnecting originals…</p>}
		</div>
	);
}
