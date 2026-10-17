import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export function DeleteProjectDialog({
	isOpen,
	onOpenChange,
	onConfirm,
	projectNames,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void | Promise<void>;
	projectNames: string[];
}) {
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!isOpen) setConfirmation("");
	}, [isOpen]);
	const confirm = async () => {
		if (confirmation !== "DELETE" || busy) return;
		setBusy(true);
		try {
			await onConfirm();
		} finally {
			setBusy(false);
		}
	};
	const count = projectNames.length;
	const isSingle = count === 1;
	const singleName = isSingle ? projectNames[0] : null;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
			<DialogContent
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{singleName ? (
							<>
								{"Delete '"}
								<span className="inline-block max-w-[300px] truncate align-bottom">
									{singleName}
								</span>
								{"'?"}
							</>
						) : (
							`Delete ${count} projects?`
						)}
					</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<Alert variant="destructive">
						<AlertTitle>Warning</AlertTitle>
						<AlertDescription>
							This will permanently delete{" "}
							{singleName ? `"${singleName}"` : `${count} projects`} and all
							associated files.
						</AlertDescription>
					</Alert>
					<div className="flex flex-col gap-3">
						<Label className="text-xs font-semibold text-slate-500">
							Type "DELETE" to confirm
						</Label>
						<Input
							type="text"
							placeholder="DELETE"
							value={confirmation}
							onChange={(event) => setConfirmation(event.target.value)}
							disabled={busy}
							size="lg"
							variant="destructive"
						/>
					</div>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						disabled={confirmation !== "DELETE" || busy}
						onClick={() => {
							void confirm().catch(() => {});
						}}
					>
						{busy ? "Deleting…" : "Delete project"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
