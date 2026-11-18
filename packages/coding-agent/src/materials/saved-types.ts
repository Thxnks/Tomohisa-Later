import type { CollectionResult } from "./types.ts";

export interface SavedNote {
	id: string;
	url: string;
	title: string;
	author?: string;
}

export type SavedImportItemStatus = "pending" | "imported" | "partial" | "skipped" | "failed";

export interface SavedImportItem extends SavedNote {
	position: number;
	status: SavedImportItemStatus;
	materialId?: string;
	attemptId?: string;
	issues: string[];
}

export interface SavedImport {
	id: string;
	status: "ready" | "running" | "paused" | "completed";
	requestedLimit: number;
	createdAt: number;
	updatedAt: number;
	pauseReason?: string;
	items: SavedImportItem[];
}

export interface SavedImportRepository {
	withLock<T>(run: () => Promise<T>): Promise<T>;
	create(notes: SavedNote[], requestedLimit: number): Promise<SavedImport>;
	get(id?: string): Promise<SavedImport | undefined>;
	setStatus(id: string, status: SavedImport["status"], reason?: string): Promise<void>;
	resolve(note: SavedNote): Promise<string>;
	checkpoint(id: string, noteId: string, materialId: string): Promise<void>;
	finishItem(
		id: string,
		noteId: string,
		status: SavedImportItemStatus,
		result?: CollectionResult & { attemptId: string },
	): Promise<void>;
}
