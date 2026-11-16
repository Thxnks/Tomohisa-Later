import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { type DebtItem, type DebtRow, rowToItem } from "../extensions/info-debt/types.ts";
import { MATERIAL_SCHEMA, MATERIAL_SCHEMA_VERSION } from "./schema.ts";
import type {
	AssetRole,
	ContentType,
	Material,
	MaterialAsset,
	MaterialDetail,
	MaterialKind,
	MaterialRepository,
	MaterialSnapshot,
	SaveMaterialInput,
	SaveSnapshotInput,
} from "./types.ts";

interface MaterialRow extends RowDataPacket {
	id: string;
	kind: MaterialKind;
	title: string;
	source_type: string;
	created_at: number;
	updated_at: number;
	url: string | null;
	text_content: string | null;
	latest_snapshot_id: string | null;
}

interface SnapshotRow extends RowDataPacket {
	id: string;
	material_id: string;
	content: string;
	content_type: ContentType;
	content_hash: string;
	extractor: string;
	created_at: number;
}

interface AssetRow extends RowDataPacket {
	id: string;
	material_id: string;
	sha256: string;
	byte_size: number;
	content_type: string;
	file_name: string;
	role: AssetRole;
	position: number;
	source_url: string | null;
	created_at: number;
}

const SELECT_MATERIAL = `SELECT m.*, l.url, t.content AS text_content FROM materials m
	LEFT JOIN material_links l ON l.material_id = m.id
	LEFT JOIN material_texts t ON t.material_id = m.id`;

function toMaterial(row: MaterialRow): Material {
	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		sourceType: row.source_type,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		url: row.url ?? undefined,
		text: row.text_content ?? undefined,
		latestSnapshotId: row.latest_snapshot_id ?? undefined,
	};
}

function toSnapshot(row: SnapshotRow): MaterialSnapshot {
	return {
		id: row.id,
		materialId: row.material_id,
		content: row.content,
		contentType: row.content_type,
		contentHash: row.content_hash,
		extractor: row.extractor,
		createdAt: row.created_at,
	};
}

function toAsset(row: AssetRow): MaterialAsset {
	return {
		id: row.id,
		materialId: row.material_id,
		sha256: row.sha256,
		size: row.byte_size,
		contentType: row.content_type,
		fileName: row.file_name,
		role: row.role,
		position: row.position,
		sourceUrl: row.source_url ?? undefined,
		createdAt: row.created_at,
	};
}

export function normalizeMaterial(
	input: SaveMaterialInput,
): SaveMaterialInput & { sourceType: string; identityHash: string } {
	const title = input.title.trim();
	const sourceType = input.sourceType ?? "manual";
	if (!title || title.length > 512) throw new Error("title must contain 1 to 512 characters");
	if (!sourceType.trim() || sourceType.length > 64) throw new Error("sourceType must contain 1 to 64 characters");
	let identity: string;
	let url: string | undefined;
	if (input.kind === "link") {
		const parsed = new URL(input.url ?? "");
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
			throw new Error("url must be an HTTP or HTTPS URL without credentials");
		}
		// Keep query parameters and fragments: signed links and article anchors matter.
		url = parsed.toString();
		if (url.length > 8192) throw new Error("url must not exceed 8192 characters");
		identity = `link:${url}`;
	} else if (input.kind === "text") {
		if (!input.text?.trim()) throw new Error("text must not be empty");
		identity = `text:${input.text}`;
	} else {
		throw new Error("kind must be link or text");
	}
	return { ...input, title, sourceType, url, identityHash: createHash("sha256").update(identity).digest("hex") };
}

export async function migrateMaterials(pool: Pool): Promise<void> {
	const connection = await pool.getConnection();
	let locked = false;
	try {
		const [locks] = await connection.execute<(RowDataPacket & { acquired: number })[]>(
			"SELECT GET_LOCK('pi_material_schema', 30) AS acquired",
		);
		if (locks[0]?.acquired !== 1) throw new Error("Material schema migration lock is unavailable");
		locked = true;
		await connection.execute(MATERIAL_SCHEMA[0]);
		const [versions] = await connection.execute<(RowDataPacket & { value: string })[]>(
			"SELECT `value` FROM material_meta WHERE `key` = 'schema_version'",
		);
		const version = Number(versions[0]?.value ?? 0);
		if (!Number.isInteger(version) || version < 0 || version > MATERIAL_SCHEMA_VERSION) {
			throw new Error(`Unsupported material schema version: ${version}`);
		}
		if (version === MATERIAL_SCHEMA_VERSION) return;
		// MySQL DDL commits implicitly. Every statement is safe to repeat after failure.
		for (const statement of MATERIAL_SCHEMA.slice(1)) await connection.execute(statement);
		await connection.execute(
			"INSERT INTO material_meta (`key`, `value`) VALUES ('schema_version', ?) ON DUPLICATE KEY UPDATE `value` = ?",
			[String(MATERIAL_SCHEMA_VERSION), String(MATERIAL_SCHEMA_VERSION)],
		);
	} finally {
		try {
			if (locked) await connection.execute("SELECT RELEASE_LOCK('pi_material_schema')");
		} finally {
			connection.release();
		}
	}
}

export class MySqlMaterialRepository implements MaterialRepository {
	private readonly pool: Pool;
	private readonly initialize: () => Promise<void>;

	constructor(pool: Pool, initialize: () => Promise<void>) {
		this.pool = pool;
		this.initialize = initialize;
	}

	private async transaction<T>(run: (connection: PoolConnection) => Promise<T>): Promise<T> {
		await this.initialize();
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			const result = await run(connection);
			await connection.commit();
			return result;
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async save(input: SaveMaterialInput): Promise<Material> {
		return this.transaction((connection) => this.saveInTransaction(connection, input));
	}

	private async saveInTransaction(connection: PoolConnection, input: SaveMaterialInput): Promise<Material> {
		const normalized = normalizeMaterial(input);
		const now = Date.now();
		await connection.execute(
			`INSERT INTO materials (id, kind, title, source_type, identity_hash, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
			[randomUUID(), normalized.kind, normalized.title, normalized.sourceType, normalized.identityHash, now, now],
		);
		const [rows] = await connection.execute<MaterialRow[]>(
			"SELECT * FROM materials WHERE identity_hash = ? FOR UPDATE",
			[normalized.identityHash],
		);
		const material = toMaterial(rows[0]);
		if (normalized.kind === "link") {
			await connection.execute(
				"INSERT INTO material_links (material_id, url) VALUES (?, ?) ON DUPLICATE KEY UPDATE material_id = material_id",
				[material.id, normalized.url!],
			);
			material.url = normalized.url;
			if (normalized.text?.trim()) {
				const snapshot = await this.snapshotInTransaction(connection, material.id, {
					content: normalized.text,
					contentType: "text/plain",
					extractor: "capture",
				});
				material.latestSnapshotId = snapshot.id;
			}
		} else {
			await connection.execute(
				"INSERT INTO material_texts (material_id, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE material_id = material_id",
				[material.id, normalized.text!],
			);
			material.text = normalized.text;
			const snapshot = await this.snapshotInTransaction(connection, material.id, {
				content: normalized.text!,
				contentType: "text/plain",
				extractor: "manual",
			});
			material.latestSnapshotId = snapshot.id;
		}
		return material;
	}

	/** Called by the debt repository inside the same transaction as debt creation. */
	async captureDebt(connection: PoolConnection, item: DebtItem): Promise<void> {
		// Debt also accepts non-web references. Those remain in debt_items.
		const parsed = item.sourceUrl && URL.canParse(item.sourceUrl) ? new URL(item.sourceUrl) : undefined;
		const url =
			parsed && ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password
				? parsed.toString()
				: undefined;
		if (!url && !item.rawContent?.trim()) return;
		const material = await this.saveInTransaction(connection, {
			kind: url ? "link" : "text",
			title: item.title.trim() || "Untitled source",
			sourceType: item.sourceType,
			url,
			text: item.rawContent,
		});
		await connection.execute(
			"INSERT INTO material_debts (debt_id, material_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE debt_id = debt_id",
			[item.id, material.id],
		);
	}

	async get(id: string): Promise<MaterialDetail | undefined> {
		await this.initialize();
		const [rows] = await this.pool.execute<MaterialRow[]>(`${SELECT_MATERIAL} WHERE m.id = ?`, [id]);
		if (!rows[0]) return undefined;
		const [assets] = await this.pool.execute<AssetRow[]>(
			"SELECT * FROM material_assets WHERE material_id = ? ORDER BY role, position, id",
			[id],
		);
		return { material: toMaterial(rows[0]), assets: assets.map(toAsset) };
	}

	async list(limit: number, beforeId?: string): Promise<Material[]> {
		await this.initialize();
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
		const [rows] = await this.pool.execute<MaterialRow[]>(
			`${SELECT_MATERIAL} ${beforeId ? "WHERE (m.created_at, m.id) < (SELECT created_at, id FROM materials WHERE id = ?)" : ""}
			 ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
			beforeId ? [beforeId, limit] : [limit],
		);
		return rows.map(toMaterial);
	}

	async findForDebt(debtId: string): Promise<Material[]> {
		await this.initialize();
		const [rows] = await this.pool.execute<MaterialRow[]>(
			`${SELECT_MATERIAL} JOIN material_debts d ON d.material_id = m.id WHERE d.debt_id = ? ORDER BY m.id`,
			[debtId],
		);
		return rows.map(toMaterial);
	}

	async importDebt(debtId: string): Promise<void> {
		await this.transaction(async (connection) => {
			const [rows] = await connection.execute<(DebtRow & RowDataPacket)[]>(
				"SELECT * FROM debt_items WHERE id = ? FOR UPDATE",
				[debtId],
			);
			if (!rows[0]) throw new Error(`Debt not found: ${debtId}`);
			await this.captureDebt(connection, rowToItem(rows[0]));
		});
	}

	async saveSnapshot(materialId: string, input: SaveSnapshotInput): Promise<MaterialSnapshot> {
		return this.transaction((connection) => this.snapshotInTransaction(connection, materialId, input));
	}

	private async snapshotInTransaction(
		connection: PoolConnection,
		materialId: string,
		input: SaveSnapshotInput,
	): Promise<MaterialSnapshot> {
		if (!input.content.trim()) throw new Error("Snapshot content must not be empty");
		if (!["text/plain", "text/markdown", "text/html"].includes(input.contentType))
			throw new Error("Unsupported snapshot content type");
		if (!input.extractor.trim() || input.extractor.length > 191)
			throw new Error("extractor must contain 1 to 191 characters");
		const [materials] = await connection.execute<RowDataPacket[]>(
			"SELECT id FROM materials WHERE id = ? FOR UPDATE",
			[materialId],
		);
		if (!materials.length) throw new Error(`Material not found: ${materialId}`);
		const hash = createHash("sha256").update(input.content).digest("hex");
		await connection.execute(
			`INSERT INTO material_snapshots (id, material_id, content, content_type, content_hash, extractor, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
			[randomUUID(), materialId, input.content, input.contentType, hash, input.extractor, Date.now()],
		);
		const [rows] = await connection.execute<SnapshotRow[]>(
			"SELECT * FROM material_snapshots WHERE material_id = ? AND content_hash = ? AND content_type = ? AND extractor = ?",
			[materialId, hash, input.contentType, input.extractor],
		);
		await connection.execute(
			"UPDATE materials SET latest_snapshot_id = ?, updated_at = ? WHERE id = ? AND (latest_snapshot_id IS NULL OR latest_snapshot_id <> ?)",
			[rows[0].id, Date.now(), materialId, rows[0].id],
		);
		return toSnapshot(rows[0]);
	}

	async getSnapshot(materialId: string, snapshotId?: string): Promise<MaterialSnapshot | undefined> {
		await this.initialize();
		const [rows] = await this.pool.execute<SnapshotRow[]>(
			`SELECT s.* FROM material_snapshots s WHERE s.material_id = ? AND s.id = ${snapshotId ? "?" : "(SELECT latest_snapshot_id FROM materials WHERE id = ?)"}`,
			[materialId, snapshotId ?? materialId],
		);
		return rows[0] ? toSnapshot(rows[0]) : undefined;
	}

	async createAssetMaterial(
		title: string,
		sourceType: string,
		asset: MaterialAsset,
	): Promise<{ material: Material; asset: MaterialAsset }> {
		return this.transaction(async (connection) => {
			const now = Date.now();
			const identity = createHash("sha256").update(`asset:${asset.sha256}:${asset.contentType}`).digest("hex");
			await connection.execute(
				`INSERT INTO materials (id, kind, title, source_type, identity_hash, created_at, updated_at) VALUES (?, 'asset', ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
				[asset.materialId, title, sourceType, identity, now, now],
			);
			const [rows] = await connection.execute<MaterialRow[]>(
				"SELECT * FROM materials WHERE identity_hash = ? FOR UPDATE",
				[identity],
			);
			const material = toMaterial(rows[0]);
			const savedAsset = await this.assetInTransaction(connection, { ...asset, materialId: material.id });
			return { material, asset: savedAsset };
		});
	}

	async attachAsset(asset: MaterialAsset): Promise<MaterialAsset> {
		return this.transaction((connection) => this.assetInTransaction(connection, asset));
	}

	private async assetInTransaction(connection: PoolConnection, asset: MaterialAsset): Promise<MaterialAsset> {
		const [parents] = await connection.execute<RowDataPacket[]>("SELECT id FROM materials WHERE id = ? FOR UPDATE", [
			asset.materialId,
		]);
		if (!parents.length) throw new Error(`Material not found: ${asset.materialId}`);
		const [existing] = await connection.execute<AssetRow[]>(
			"SELECT * FROM material_assets WHERE material_id = ? AND role = ? AND position = ?",
			[asset.materialId, asset.role, asset.position],
		);
		if (existing[0]) {
			if (existing[0].sha256 !== asset.sha256 || existing[0].content_type !== asset.contentType) {
				throw new Error("An immutable asset already occupies this role and position");
			}
			return toAsset(existing[0]);
		}
		await connection.execute(
			`INSERT INTO material_assets (id, material_id, sha256, byte_size, content_type, file_name, role, position, source_url, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				asset.id,
				asset.materialId,
				asset.sha256,
				asset.size,
				asset.contentType,
				asset.fileName,
				asset.role,
				asset.position,
				asset.sourceUrl ?? null,
				asset.createdAt,
			],
		);
		await connection.execute("UPDATE materials SET updated_at = ? WHERE id = ?", [Date.now(), asset.materialId]);
		return asset;
	}
}
