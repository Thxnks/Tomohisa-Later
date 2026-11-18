import { describe, expect, it, vi } from "vitest";
import type { CollectionCommand } from "../src/materials/collection-command.ts";
import { CollectionError } from "../src/materials/collection-command.ts";
import { XiaohongshuSavedClient } from "../src/materials/saved-client.ts";
import { SavedMaterialImporter, savedImportSummary } from "../src/materials/saved-importer.ts";
import type {
	SavedImport,
	SavedImportItemStatus,
	SavedImportRepository,
	SavedNote,
} from "../src/materials/saved-types.ts";
import type { CollectionResult, MaterialRepository } from "../src/materials/types.ts";

function note(index: number, token = "signed"): SavedNote {
	const id = index.toString(16).padStart(24, "0");
	return {
		id,
		title: `Saved ${index}`,
		url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=${token}`,
		author: "author",
	};
}

function browser(running = true) {
	return {
		code: 0,
		stdout: JSON.stringify({
			schema_version: 1,
			ok: true,
			result: {
				running,
				chrome: "/chrome",
				extension_version: "1",
				opencli_context: "reach-owned",
				opencli_connected: running,
			},
		}),
	};
}

class MemoryImports implements SavedImportRepository {
	readonly jobs = new Map<string, SavedImport>();
	locked = false;
	async withLock<T>(run: () => Promise<T>): Promise<T> {
		if (this.locked) throw new CollectionError("BUSY");
		this.locked = true;
		try {
			return await run();
		} finally {
			this.locked = false;
		}
	}
	async create(notes: SavedNote[], requestedLimit: number): Promise<SavedImport> {
		const job: SavedImport = {
			id: `job-${this.jobs.size}`,
			status: "ready",
			requestedLimit,
			createdAt: 1,
			updatedAt: 1,
			items: notes.map((item, position) => ({ ...item, position, status: "pending", issues: [] })),
		};
		this.jobs.set(job.id, job);
		return structuredClone(job);
	}
	async get(id?: string): Promise<SavedImport | undefined> {
		return structuredClone(id ? this.jobs.get(id) : [...this.jobs.values()].at(-1));
	}
	async setStatus(id: string, status: SavedImport["status"], reason?: string): Promise<void> {
		const job = this.jobs.get(id)!;
		job.status = status;
		job.pauseReason = reason;
	}
	async resolve(item: SavedNote): Promise<string> {
		return `material-${item.id}`;
	}
	async checkpoint(id: string, noteId: string, materialId: string): Promise<void> {
		this.jobs.get(id)!.items.find((item) => item.id === noteId)!.materialId = materialId;
	}
	async finishItem(
		id: string,
		noteId: string,
		status: SavedImportItemStatus,
		result?: CollectionResult & { attemptId: string },
	): Promise<void> {
		const item = this.jobs.get(id)!.items.find((item) => item.id === noteId)!;
		item.status = status;
		item.attemptId = result?.attemptId;
		item.issues = result?.issues ?? [];
	}
}

function fixture() {
	const repository = new MemoryImports();
	const collected = new Map<string, CollectionResult & { attemptId: string }>();
	const materials = {
		get: vi.fn(async (id: string) => {
			const result = collected.get(id);
			return result ? { material: { id }, assets: [], collection: { id: result.attemptId, result } } : undefined;
		}),
	} as unknown as MaterialRepository;
	const collect = vi.fn(async (id: string) => {
		const result: CollectionResult & { attemptId: string } = {
			attemptId: `attempt-${id}`,
			status: "partial",
			sources: [{ materialId: id, snapshotId: `snapshot-${id}`, url: "https://example.com" }],
			imageCount: 1,
			images: [{ assetId: `image-${id}`, position: 0 }],
			issues: ["IMAGES_NOT_ANALYZED"],
		};
		collected.set(id, result);
		return result;
	});
	const client = { list: vi.fn(async () => [note(1), note(2), note(3)]) };
	const importer = new SavedMaterialImporter(repository, materials, { collect }, client, async () => {});
	return { repository, materials, collect, collected, client, importer };
}

describe("saved list protocol", () => {
	it("uses the bound profile, validates signed note identity and deduplicates changing signatures", async () => {
		const command = vi
			.fn<CollectionCommand>()
			.mockResolvedValueOnce(browser())
			.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([note(1), note(1, "different"), note(2)]) });
		const notes = await new XiaohongshuSavedClient(command).list(20);
		expect(notes).toEqual([note(1), note(2)]);
		expect(command.mock.calls[1][1]).toEqual(["xiaohongshu", "saved", "--limit", "20", "-f", "json"]);
		expect(command.mock.calls[1][3]).toMatchObject({
			OPENCLI_PROFILE: "reach-owned",
			OPENCLI_CDP_ENDPOINT: "",
			OPENCLI_CDP_TARGET: "",
		});
	});
	it("starts an already prepared Reach browser once and never guesses another profile", async () => {
		const command = vi
			.fn<CollectionCommand>()
			.mockResolvedValueOnce(browser(false))
			.mockResolvedValueOnce(browser())
			.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([note(1)]) });
		await new XiaohongshuSavedClient(command).list(20);
		expect(command.mock.calls[1][1]).toEqual(["browser", "setup"]);
		expect(command).toHaveBeenCalledTimes(3);
	});
	it.each([
		{ ...note(1), url: note(2).url },
		{ ...note(1), url: note(1).url.split("?")[0] },
		{ ...note(1), url: "https://evil.test/explore/123?xsec_token=secret" },
	])("rejects malformed or mismatched note links", async (item) => {
		const command = vi
			.fn<CollectionCommand>()
			.mockResolvedValueOnce(browser())
			.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([item]) });
		await expect(new XiaohongshuSavedClient(command).list(20)).rejects.toMatchObject({ code: "INVALID_SAVED_NOTE" });
	});
	it("does not infer an empty library from an empty result or retry an auth error", async () => {
		for (const [stdout, code] of [
			["[]", "EMPTY_LIST_UNVERIFIED"],
			["ok: false\nerror:\n  code: AUTH_REQUIRED\n  message: private cookie error", "NEED_LOGIN"],
		]) {
			const command = vi
				.fn<CollectionCommand>()
				.mockResolvedValueOnce(browser())
				.mockResolvedValueOnce({ code: 0, stdout });
			await expect(new XiaohongshuSavedClient(command).list(20)).rejects.toMatchObject({ code });
			expect(command).toHaveBeenCalledTimes(2);
		}
	});
});

describe("durable saved imports", () => {
	it("checkpoints batches, resumes from repository state and skips the same note under another signed URL", async () => {
		const { repository, materials, collect, client, importer } = fixture();
		const job = await importer.start(20);
		expect(collect).not.toHaveBeenCalled();
		expect(savedImportSummary(job)).toMatchObject({
			enumeratedCount: 3,
			requestedLimit: 20,
			reachedRequestedLimit: false,
			libraryCoverage: "unknown",
		});
		const first = await importer.run(job.id, 1);
		expect(first.status).toBe("ready");
		expect(first.items.map((item) => item.status)).toEqual(["imported", "pending", "pending"]);
		const restarted = new SavedMaterialImporter(repository, materials, { collect }, client, async () => {});
		const completed = await restarted.run(job.id, 3);
		expect(completed.status).toBe("completed");
		expect(collect).toHaveBeenCalledTimes(3);
		await restarted.run(job.id);
		expect(collect).toHaveBeenCalledTimes(3);
		client.list.mockResolvedValue([note(1, "new-token")]);
		const next = await restarted.start(20);
		const duplicate = await restarted.run(next.id);
		expect(duplicate.items[0].status).toBe("skipped");
		expect(collect).toHaveBeenCalledTimes(3);
	});
	it.each(["NEED_LOGIN", "RATE_LIMITED", "PLATFORM_BLOCKED", "BUSY", "TIMEOUT", "UPSTREAM_BROKEN"])(
		"pauses on %s without requesting later notes or retrying",
		async (code) => {
			const { collect, importer } = fixture();
			collect.mockResolvedValueOnce({
				attemptId: "failed-attempt",
				status: "needs_login",
				sources: [],
				images: [],
				imageCount: 0,
				issues: [code],
			});
			const job = await importer.start();
			const paused = await importer.run(job.id);
			expect(paused).toMatchObject({ status: "paused", pauseReason: code });
			expect(paused.items.every((item) => item.status === "pending")).toBe(true);
			expect(paused.items[0].attemptId).toBe("failed-attempt");
			expect(collect).toHaveBeenCalledOnce();
			await expect(importer.run(job.id)).rejects.toThrow("paused");
			expect(collect).toHaveBeenCalledOnce();
			expect((await importer.run(job.id, 3, true)).status).toBe("completed");
			expect(collect).toHaveBeenCalledTimes(4);
		},
	);
	it("retains saved evidence at a blocked step and keeps the item pending for explicit recovery", async () => {
		const { collect, importer } = fixture();
		const job = await importer.start();
		const saved = await collect("material");
		collect.mockClear();
		collect.mockResolvedValueOnce({ ...saved, issues: ["NEED_LOGIN"] });
		const paused = await importer.run(job.id);
		expect(paused.status).toBe("paused");
		expect(paused.items[0]).toMatchObject({
			status: "pending",
			materialId: `material-${note(1).id}`,
			issues: ["NEED_LOGIN"],
		});
		expect(collect).toHaveBeenCalledOnce();
	});
	it("cancels after a completed note without losing it or automatically processing the rest", async () => {
		const { collect, importer } = fixture();
		const job = await importer.start();
		const controller = new AbortController();
		const result = await importer.run(job.id, 3, false, controller.signal, () => controller.abort());
		expect(result).toMatchObject({ status: "paused", pauseReason: "CANCELLED" });
		expect(result.items.map((item) => item.status)).toEqual(["imported", "pending", "pending"]);
		expect(collect).toHaveBeenCalledOnce();
		expect((await importer.run(job.id, 3, true)).status).toBe("completed");
	});
	it("releases the import lock if listing fails and does not create a false manifest", async () => {
		const { repository, client, importer } = fixture();
		client.list.mockRejectedValue(new CollectionError("NEED_LOGIN"));
		await expect(importer.start()).rejects.toMatchObject({ code: "NEED_LOGIN" });
		expect(repository.locked).toBe(false);
		expect(repository.jobs.size).toBe(0);
	});
});
