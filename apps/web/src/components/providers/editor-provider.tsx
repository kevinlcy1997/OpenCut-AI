"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MissingMediaError } from "@/services/storage/media-integrity";
import { MissingMediaRecovery } from "@/components/editor/missing-media-recovery";
import { ProjectBackupControls } from "@/components/editor/project-backup-controls";
import { Loader2 } from "lucide-react";
import { useEditor } from "@/hooks/use-editor";
import {
	useKeybindingsListener,
	useKeybindingDisabler,
} from "@/hooks/use-keybindings";
import { useEditorActions } from "@/hooks/actions/use-editor-actions";
import { useEmbeddingIndexer } from "@/hooks/use-embedding-indexer";
import { prefetchFontAtlas } from "@/lib/fonts/google-fonts";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const editor = useEditor();
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [missingMedia, setMissingMedia] = useState<MissingMediaError["missing"]>([]);
	const [error, setError] = useState<string | null>(null);
	const { disableKeybindings, enableKeybindings } = useKeybindingDisabler();
	const activeProject = editor.project.getActiveOrNull();

	useEffect(() => {
		if (isLoading) {
			disableKeybindings();
		} else {
			enableKeybindings();
		}
	}, [isLoading, disableKeybindings, enableKeybindings]);

	useEffect(() => {
		let cancelled = false;

		const loadProject = async () => {
			try {
				setIsLoading(true);
				setError(null);
				await editor.project.loadProject({ id: projectId });

				if (cancelled) return;

				setIsLoading(false);
				prefetchFontAtlas();
			} catch (err) {
				if (cancelled) return;

				setMissingMedia(err instanceof MissingMediaError ? err.missing : []);
				setError(err instanceof Error ? err.message : "Failed to load project");
				setIsLoading(false);
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [projectId, editor, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm max-w-xl text-center">{error}</p>
					{missingMedia.length > 0 && <MissingMediaRecovery projectId={projectId} missing={missingMedia} />}
					<ProjectBackupControls />
					<button type="button" className="underline" onClick={() => window.location.reload()}>Retry loading project</button>
					<button type="button" className="underline" onClick={() => router.push("/projects")}>Back to projects</button>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Loading project...</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			{children}
		</>
	);
}

function EditorRuntimeBindings() {

	useEditorActions();
	useKeybindingsListener();
	useEmbeddingIndexer();
	return null;
}
