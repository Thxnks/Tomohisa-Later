import { setTimeout } from "node:timers/promises";
import { CollectionError } from "./collection-command.ts";
import type { MaterialCollector } from "./collector.ts";
import { XiaohongshuSavedClient } from "./saved-client.ts";
import type { SavedImport, SavedImportItemStatus, SavedImportRepository } from "./saved-types.ts";
import type { CollectionResult, MaterialRepository } from "./types.ts";

const PAUSE_CODES = new Set([
	"NEED_LOGIN",
	"NEED_SETUP",
	"PLATFORM_BLOCKED",
	"RATE_LIMITED",
	"BUSY",
	"TIMEOUT",
	"CANCELLED",
	"INVALID_RESPONSE",
	"UPSTREAM_BROKEN",
	"SOURCE_MISMATCH",
	"TARGET_NOT_RETURNED",
	"STORAGE_ERROR",
]);
const REUSABLE_GAPS = new Set(["IMAGES_NOT_ANALYZED", "VIDEO_NOT_IMPORTED"]);

export function reusableCollection(result: CollectionResult): boolean {
	return (
		(result.sources.length > 0 || result.imageCount > 0) &&
		(result.status === "success" || result.status === "partial") &&
		result.issues.every((code) => REUSABLE_GAPS.has(code))
	);
}

export function savedImportSummary(job: SavedImport) {
	const counts: Record<SavedImportItemStatus, number> = { pending: 0, imported: 0, partial: 0, skipped: 0, failed: 0 };
	for (const item of job.items) counts[item.status]++;
	return {
		importId: job.id,
		status: job.status,
		requestedLimit: job.requestedLimit,
		enumeratedCount: job.items.length,
		reachedRequestedLimit: job.items.length >= job.requestedLimit,
		libraryCoverage: "unknown",
		pauseReason: job.pauseReason,
		counts,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		items: job.items.slice(0, 20).map(({ url: _url, ...item }) => item),
		displayedItems: Math.min(20, job.items.length),
	};
}

export class SavedMaterialImporter {
	private readonly repository: SavedImportRepository;
	private readonly materials: MaterialRepository;
	private readonly collector: Pick<MaterialCollector, "collect">;
	private readonly client: Pick<XiaohongshuSavedClient, "list">;
	private readonly wait: (signal?: AbortSignal) => Promise<void>;

	constructor(
		repository: SavedImportRepository,
		materials: MaterialRepository,
		collector: Pick<MaterialCollector, "collect">,
		client: Pick<XiaohongshuSavedClient, "list"> = new XiaohongshuSavedClient(),
		wait: (signal?: AbortSignal) => Promise<void> = async (signal) => {
			await setTimeout(5000, undefined, { signal });
		},
	) {
		this.repository = repository;
		this.materials = materials;
		this.collector = collector;
		this.client = client;
		this.wait = wait;
	}

	async start(limit = 20, signal?: AbortSignal): Promise<SavedImport> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Saved limit must be between 1 and 100");
		return this.repository.withLock(async () => {
			signal?.throwIfAborted();
			const notes = await this.client.list(limit, signal);
			signal?.throwIfAborted();
			return this.repository.create(notes, limit);
		});
	}

	async run(
		id: string,
		batchSize = 3,
		resume = false,
		signal?: AbortSignal,
		progress?: (noteId: string, status: SavedImportItemStatus) => void,
	): Promise<SavedImport> {
		if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5)
			throw new Error("batchSize must be between 1 and 5");
		return this.repository.withLock(async () => {
			const job = await this.repository.get(id);
			if (!job) throw new Error("Saved import not found");
			if (job.status === "completed") return job;
			if (job.status === "paused" && !resume)
				throw new Error("Import is paused. Resolve its pause reason before explicitly resuming it.");
			await this.repository.setStatus(id, "running");
			let pauseReason: string | undefined;
			try {
				for (const note of job.items.filter((item) => item.status === "pending").slice(0, batchSize)) {
					signal?.throwIfAborted();
					const materialId = await this.repository.resolve(note);
					await this.repository.checkpoint(id, note.id, materialId);
					const previous = (await this.materials.get(materialId))?.collection;
					if (previous?.result && reusableCollection(previous.result)) {
						await this.repository.finishItem(id, note.id, "skipped", {
							...previous.result,
							attemptId: previous.id,
						});
						progress?.(note.id, "skipped");
						continue;
					}
					await this.wait(signal);
					const result = await this.collector.collect(materialId, signal, note.url);
					pauseReason = result.issues.find((code) => PAUSE_CODES.has(code));
					if (pauseReason) {
						await this.repository.finishItem(id, note.id, "pending", result);
						break;
					}
					const state: SavedImportItemStatus =
						result.sources.length || result.imageCount
							? reusableCollection(result)
								? "imported"
								: "partial"
							: "failed";
					await this.repository.finishItem(id, note.id, state, result);
					progress?.(note.id, state);
				}
			} catch (error) {
				pauseReason = signal?.aborted
					? "CANCELLED"
					: error instanceof CollectionError
						? error.code
						: "STORAGE_ERROR";
			}
			const updated = await this.repository.get(id);
			if (!updated) throw new Error("Saved import disappeared");
			const status = pauseReason
				? "paused"
				: updated.items.some((item) => item.status === "pending")
					? "ready"
					: "completed";
			await this.repository.setStatus(id, status, pauseReason);
			const finished = await this.repository.get(id);
			if (!finished) throw new Error("Saved import disappeared");
			return finished;
		});
	}
}
