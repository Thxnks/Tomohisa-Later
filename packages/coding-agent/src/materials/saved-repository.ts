import { randomUUID } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { CollectionError } from "./collection-command.ts";
import type { MySqlMaterialRepository } from "./repository.ts";
import { validateSavedNote } from "./saved-client.ts";
import type { SavedImport, SavedImportItemStatus, SavedImportRepository, SavedNote } from "./saved-types.ts";
import { socialTarget } from "./social-source.ts";
import type { CollectionResult } from "./types.ts";

interface ImportRow extends RowDataPacket {
	id: string;
	status: SavedImport["status"];
	requested_limit: number;
	pause_reason: string | null;
	created_at: number;
	updated_at: number;
}

interface ItemRow extends RowDataPacket {
	note_id: string;
	position: number;
	url: string;
	title: string;
	author: string | null;
	status: SavedImportItemStatus;
	material_id: string | null;
	attempt_id: string | null;
	issues_json: string;
}

export class MySqlSavedImportRepository implements SavedImportRepository {
	private readonly pool: Pool;
	private readonly initialize: () => Promise<void>;
	private readonly materials: MySqlMaterialRepository;

	constructor(pool: Pool, initialize: () => Promise<void>, materials: MySqlMaterialRepository) {
		this.pool = pool;
		this.initialize = initialize;
		this.materials = materials;
	}

	async withLock<T>(run: () => Promise<T>): Promise<T> {
		await this.initialize();
		const connection = await this.pool.getConnection();
		let locked = false;
		try {
			const [rows] = await connection.execute<(RowDataPacket & { acquired: number })[]>(
				"SELECT GET_LOCK('pi_saved_imports', 0) AS acquired",
			);
			if (rows[0]?.acquired !== 1) throw new CollectionError("BUSY");
			locked = true;
			return await run();
		} finally {
			try {
				if (locked) await connection.execute("SELECT RELEASE_LOCK('pi_saved_imports')");
			} finally {
				connection.release();
			}
		}
	}

	async create(notes: SavedNote[], requestedLimit: number): Promise<SavedImport> {
		if (
			!Number.isInteger(requestedLimit) ||
			requestedLimit < 1 ||
			requestedLimit > 100 ||
			!notes.length ||
			notes.length > requestedLimit ||
			new Set(notes.map((note) => note.id)).size !== notes.length
		)
			throw new Error("Invalid saved import manifest");
		for (const note of notes) validateSavedNote(note);
		await this.initialize();
		const id = randomUUID();
		const now = Date.now();
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			await connection.execute(
				"INSERT INTO material_saved_imports (id, status, requested_limit, created_at, updated_at) VALUES (?, 'ready', ?, ?, ?)",
				[id, requestedLimit, now, now],
			);
			for (const [position, note] of notes.entries())
				await connection.execute(
					"INSERT INTO material_saved_import_items (import_id, note_id, position, url, title, author, status, issues_json) VALUES (?, ?, ?, ?, ?, ?, 'pending', '[]')",
					[id, note.id, position, note.url, note.title, note.author ?? null],
				);
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
		return {
			id,
			status: "ready",
			requestedLimit,
			createdAt: now,
			updatedAt: now,
			items: notes.map((note, position) => ({ ...note, position, status: "pending", issues: [] })),
		};
	}

	async get(id?: string): Promise<SavedImport | undefined> {
		await this.initialize();
		const [jobs] = await this.pool.execute<ImportRow[]>(
			id
				? "SELECT * FROM material_saved_imports WHERE id = ?"
				: "SELECT * FROM material_saved_imports ORDER BY created_at DESC, id DESC LIMIT 1",
			id ? [id] : [],
		);
		const job = jobs[0];
		if (!job) return undefined;
		const [items] = await this.pool.execute<ItemRow[]>(
			"SELECT * FROM material_saved_import_items WHERE import_id = ? ORDER BY position",
			[job.id],
		);
		return {
			id: job.id,
			status: job.status,
			requestedLimit: job.requested_limit,
			createdAt: job.created_at,
			updatedAt: job.updated_at,
			pauseReason: job.pause_reason ?? undefined,
			items: items.map((row) => ({
				id: row.note_id,
				position: row.position,
				url: row.url,
				title: row.title,
				author: row.author ?? undefined,
				status: row.status,
				materialId: row.material_id ?? undefined,
				attemptId: row.attempt_id ?? undefined,
				issues: JSON.parse(row.issues_json) as string[],
			})),
		};
	}

	async setStatus(id: string, status: SavedImport["status"], reason?: string): Promise<void> {
		await this.initialize();
		const [result] = await this.pool.execute<ResultSetHeader>(
			"UPDATE material_saved_imports SET status = ?, pause_reason = ?, updated_at = ? WHERE id = ?",
			[status, reason ?? null, Date.now(), id],
		);
		if (result.affectedRows !== 1) throw new Error("Saved import not found");
	}

	/** Call under the import lock, including when recovering an interrupted batch. */
	async resolve(note: SavedNote): Promise<string> {
		validateSavedNote(note);
		await this.initialize();
		const [known] = await this.pool.execute<(RowDataPacket & { material_id: string })[]>(
			"SELECT material_id FROM material_social_sources WHERE platform = 'xiaohongshu' AND post_id = ?",
			[note.id],
		);
		if (known[0]) return known[0].material_id;
		const [candidates] = await this.pool.execute<(RowDataPacket & { id: string; url: string })[]>(
			"SELECT m.id, l.url FROM material_links l JOIN materials m ON m.id = l.material_id WHERE l.url LIKE ? ORDER BY (m.latest_snapshot_id IS NOT NULL) DESC, m.created_at, m.id",
			[`%/${note.id}%`],
		);
		const existing = candidates.find((candidate) => {
			try {
				const target = socialTarget(candidate.url);
				return target.platform === "xiaohongshu" && target.postId?.toLowerCase() === note.id;
			} catch {
				return false;
			}
		});
		const id =
			existing?.id ??
			(await this.materials.save({ kind: "link", title: note.title, sourceType: "xiaohongshu", url: note.url })).id;
		await this.pool.execute(
			"INSERT INTO material_social_sources (platform, post_id, material_id) VALUES ('xiaohongshu', ?, ?)",
			[note.id, id],
		);
		return id;
	}

	async checkpoint(id: string, noteId: string, materialId: string): Promise<void> {
		await this.initialize();
		const [result] = await this.pool.execute<ResultSetHeader>(
			"UPDATE material_saved_import_items SET material_id = ? WHERE import_id = ? AND note_id = ? AND status = 'pending'",
			[materialId, id, noteId],
		);
		if (result.affectedRows !== 1) throw new Error("Pending import item not found");
	}

	async finishItem(
		id: string,
		noteId: string,
		status: SavedImportItemStatus,
		result?: CollectionResult & { attemptId: string },
	): Promise<void> {
		await this.initialize();
		const [updated] = await this.pool.execute<ResultSetHeader>(
			"UPDATE material_saved_import_items SET status = ?, attempt_id = ?, issues_json = ? WHERE import_id = ? AND note_id = ? AND status = 'pending'",
			[status, result?.attemptId ?? null, JSON.stringify(result?.issues ?? []), id, noteId],
		);
		if (updated.affectedRows !== 1) throw new Error("Pending import item not found");
	}
}
