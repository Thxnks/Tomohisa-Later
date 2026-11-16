/** MySQL repository for Information Debt. */

import { createPool, type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { MySqlMaterialRepository, migrateMaterials } from "../../materials/repository.ts";
import { type DebtItem, type DebtRow, type DebtStatus, type DebtType, rowToItem } from "./types.ts";

type SqlParam = null | number | string | Uint8Array;

export interface DebtFilter {
	status?: DebtStatus;
	statuses?: DebtStatus[];
	debtType?: DebtType;
	project?: string;
	limit?: number;
}

export interface DebtRepository {
	create(item: DebtItem): Promise<void>;
	get(id: string): Promise<DebtItem | undefined>;
	listByIdPrefix(prefix: string): Promise<DebtItem[]>;
	list(filter?: DebtFilter): Promise<DebtItem[]>;
	listRevisitDue(now: number, limit?: number): Promise<DebtItem[]>;
	listReviewCandidates(now: number, limit?: number): Promise<DebtItem[]>;
	search(query: string, filter?: DebtFilter): Promise<DebtItem[]>;
	update(id: string, patch: Partial<DebtItem>): Promise<DebtItem | undefined>;
	resolve(id: string, note?: string): Promise<DebtItem | undefined>;
	close(): Promise<void>;
}

export interface MySqlDebtRepositoryOptions {
	host: string;
	port: number;
	user: string;
	password?: string;
	database: string;
}

interface MySqlDebtRow extends DebtRow, RowDataPacket {}

const COLUMNS = [
	"id",
	"title",
	"source_type",
	"source_url",
	"raw_content",
	"debt_type",
	"summary",
	"why_saved",
	"project",
	"next_action",
	"status",
	"priority",
	"estimated_minutes",
	"due_at",
	"revisit_at",
	"created_at",
	"updated_at",
	"resolved_at",
	"resolution_note",
] as const;

type DebtColumnName = (typeof COLUMNS)[number];

const UPDATABLE_COLUMNS: Partial<Record<keyof DebtItem, DebtColumnName>> = {
	title: "title",
	sourceType: "source_type",
	sourceUrl: "source_url",
	rawContent: "raw_content",
	debtType: "debt_type",
	summary: "summary",
	whySaved: "why_saved",
	project: "project",
	nextAction: "next_action",
	status: "status",
	priority: "priority",
	estimatedMinutes: "estimated_minutes",
	dueAt: "due_at",
	revisitAt: "revisit_at",
	resolvedAt: "resolved_at",
	resolutionNote: "resolution_note",
};

function itemToParams(item: DebtItem): SqlParam[] {
	return [
		item.id,
		item.title,
		item.sourceType,
		item.sourceUrl ?? null,
		item.rawContent ?? null,
		item.debtType,
		item.summary ?? null,
		item.whySaved ?? null,
		item.project ?? null,
		item.nextAction ?? null,
		item.status,
		item.priority,
		item.estimatedMinutes ?? null,
		item.dueAt ?? null,
		item.revisitAt ?? null,
		item.createdAt,
		item.updatedAt,
		item.resolvedAt ?? null,
		item.resolutionNote ?? null,
	];
}

function parsePort(value: string | undefined): number {
	const port = value === undefined ? 3306 : Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`PI_INFO_DEBT_MYSQL_PORT must be an integer from 1 to 65535, got: ${value}`);
	}
	return port;
}

export function getMySqlDebtRepositoryOptions(): MySqlDebtRepositoryOptions {
	return {
		host: process.env.PI_INFO_DEBT_MYSQL_HOST ?? "127.0.0.1",
		port: parsePort(process.env.PI_INFO_DEBT_MYSQL_PORT),
		user: process.env.PI_INFO_DEBT_MYSQL_USER ?? "root",
		password: process.env.PI_INFO_DEBT_MYSQL_PASSWORD,
		database: process.env.PI_INFO_DEBT_MYSQL_DATABASE ?? "tomohisa_helper",
	};
}

export class MySqlDebtRepository implements DebtRepository {
	private readonly pool: Pool;
	private ready: Promise<void> | undefined;
	readonly materials: MySqlMaterialRepository;

	constructor(options: MySqlDebtRepositoryOptions) {
		this.pool = createPool({
			...options,
			charset: "utf8mb4",
			timezone: "Z",
			waitForConnections: true,
			connectionLimit: 4,
			maxIdle: 4,
			idleTimeout: 60_000,
			queueLimit: 0,
		});
		this.materials = new MySqlMaterialRepository(this.pool, () => this.ensureReady());
	}

	async close(): Promise<void> {
		await this.pool.end();
	}

	async create(item: DebtItem): Promise<void> {
		await this.ensureReady();
		const connection = await this.pool.getConnection();
		try {
			await connection.beginTransaction();
			await connection.execute(
				`INSERT INTO debt_items (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
				itemToParams(item),
			);
			await this.materials.captureDebt(connection, item);
			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async get(id: string): Promise<DebtItem | undefined> {
		await this.ensureReady();
		return this.selectRow("SELECT * FROM debt_items WHERE id = ?", [id]);
	}

	async listByIdPrefix(prefix: string): Promise<DebtItem[]> {
		await this.ensureReady();
		return this.selectRows("SELECT * FROM debt_items WHERE id LIKE CONCAT(?, '%')", [prefix]);
	}

	async list(filter: DebtFilter = {}): Promise<DebtItem[]> {
		await this.ensureReady();
		const params: SqlParam[] = [];
		const limit = filter.limit ?? 30;
		return this.selectRows(
			`SELECT * FROM debt_items${this.whereClause(filter, params)}
			 ORDER BY priority ASC, COALESCE(due_at, 9223372036854775807) ASC, created_at ASC
			 LIMIT ?`,
			[...params, limit],
		);
	}

	async listRevisitDue(now: number, limit = 30): Promise<DebtItem[]> {
		await this.ensureReady();
		return this.selectRows(
			`SELECT * FROM debt_items
			 WHERE status IN ('inbox', 'active') AND revisit_at IS NOT NULL AND revisit_at <= ?
			 ORDER BY priority ASC, revisit_at ASC
			 LIMIT ?`,
			[now, limit],
		);
	}

	async listReviewCandidates(now: number, limit = 100): Promise<DebtItem[]> {
		await this.ensureReady();
		return this.selectRows(
			`SELECT * FROM debt_items
			 WHERE status IN ('inbox', 'active')
			    OR (status = 'deferred' AND revisit_at IS NOT NULL AND revisit_at <= ?)
			 ORDER BY priority ASC, COALESCE(due_at, 9223372036854775807) ASC, created_at ASC
			 LIMIT ?`,
			[now, limit],
		);
	}

	async search(query: string, filter: DebtFilter = {}): Promise<DebtItem[]> {
		await this.ensureReady();
		const pattern = `%${query}%`;
		const conditions = [
			"(title LIKE ? OR summary LIKE ? OR why_saved LIKE ? OR project LIKE ? OR next_action LIKE ? OR source_url LIKE ?)",
		];
		const params: SqlParam[] = [pattern, pattern, pattern, pattern, pattern, pattern];
		if (filter.status) {
			conditions.push("status = ?");
			params.push(filter.status);
		}
		if (filter.debtType) {
			conditions.push("debt_type = ?");
			params.push(filter.debtType);
		}
		if (filter.project) {
			conditions.push("project = ?");
			params.push(filter.project);
		}
		const limit = filter.limit ?? 30;
		return this.selectRows(
			`SELECT * FROM debt_items WHERE ${conditions.join(" AND ")}
			 ORDER BY priority ASC, created_at ASC
			 LIMIT ?`,
			[...params, limit],
		);
	}

	async update(id: string, patch: Partial<DebtItem>): Promise<DebtItem | undefined> {
		await this.ensureReady();
		const assignments: string[] = [];
		const params: SqlParam[] = [];
		for (const [field, column] of Object.entries(UPDATABLE_COLUMNS) as Array<[keyof DebtItem, DebtColumnName]>) {
			if (patch[field] !== undefined) {
				assignments.push(`${column} = ?`);
				params.push(patch[field] as string | number);
			}
		}
		if (assignments.length === 0) return this.get(id);

		assignments.push("updated_at = ?");
		params.push(Date.now(), id);
		const [result] = await this.pool.execute<ResultSetHeader>(
			`UPDATE debt_items SET ${assignments.join(", ")} WHERE id = ?`,
			params,
		);
		return result.affectedRows === 0 ? undefined : this.get(id);
	}

	async resolve(id: string, note?: string): Promise<DebtItem | undefined> {
		const now = Date.now();
		return this.update(id, {
			status: "resolved",
			resolvedAt: now,
			resolutionNote: note,
		});
	}

	private async migrate(): Promise<void> {
		await this.pool.execute(`CREATE TABLE IF NOT EXISTS debt_meta (
			\`key\` VARCHAR(191) PRIMARY KEY,
			\`value\` VARCHAR(191) NOT NULL
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
		await this.pool.execute(`CREATE TABLE IF NOT EXISTS debt_items (
			id VARCHAR(36) PRIMARY KEY,
			title VARCHAR(512) NOT NULL,
			source_type VARCHAR(64) NOT NULL DEFAULT 'manual',
			source_url TEXT,
			raw_content LONGTEXT,
			debt_type VARCHAR(32) NOT NULL,
			summary TEXT,
			why_saved TEXT,
			project VARCHAR(191),
			next_action TEXT,
			status VARCHAR(32) NOT NULL DEFAULT 'inbox',
			priority TINYINT UNSIGNED NOT NULL DEFAULT 3,
			estimated_minutes INT UNSIGNED,
			due_at BIGINT,
			revisit_at BIGINT,
			created_at BIGINT NOT NULL,
			updated_at BIGINT NOT NULL,
			resolved_at BIGINT,
			resolution_note TEXT,
			INDEX idx_debt_status (status),
			INDEX idx_debt_due (due_at),
			INDEX idx_debt_revisit (revisit_at),
			INDEX idx_debt_project (project)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
		await this.pool.execute(
			"INSERT INTO debt_meta (`key`, `value`) VALUES ('schema_version', '1') " +
				"ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
		);
		await migrateMaterials(this.pool);
	}

	private ensureReady(): Promise<void> {
		this.ready ??= this.migrate();
		return this.ready;
	}

	private async selectRow(sql: string, params: SqlParam[]): Promise<DebtItem | undefined> {
		const [rows] = await this.pool.execute<MySqlDebtRow[]>(sql, params);
		const row = rows[0];
		return row ? rowToItem(row) : undefined;
	}

	private async selectRows(sql: string, params: SqlParam[]): Promise<DebtItem[]> {
		const [rows] = await this.pool.execute<MySqlDebtRow[]>(sql, params);
		return rows.map(rowToItem);
	}

	private whereClause(filter: DebtFilter, params: SqlParam[]): string {
		const conditions: string[] = [];
		if (filter.status) {
			conditions.push("status = ?");
			params.push(filter.status);
		}
		if (filter.statuses) {
			conditions.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
			params.push(...filter.statuses);
		}
		if (filter.debtType) {
			conditions.push("debt_type = ?");
			params.push(filter.debtType);
		}
		if (filter.project) {
			conditions.push("project = ?");
			params.push(filter.project);
		}
		return conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
	}
}

let defaultRepository: MySqlDebtRepository | undefined;
let repositoryOwners = 0;

export function getDebtRepository(): MySqlDebtRepository {
	defaultRepository ??= new MySqlDebtRepository(getMySqlDebtRepositoryOptions());
	return defaultRepository;
}

export function getMaterialRepository(): MySqlMaterialRepository {
	defaultRepository ??= new MySqlDebtRepository(getMySqlDebtRepositoryOptions());
	return defaultRepository.materials;
}

/** Each built-in extension releases its ownership when its session shuts down. */
export function retainDebtRepository(): { repository: MySqlDebtRepository; release: () => Promise<void> } {
	const repository = getDebtRepository();
	repositoryOwners++;
	let released = false;
	return {
		repository,
		async release() {
			if (released) return;
			released = true;
			repositoryOwners--;
			if (repositoryOwners === 0) {
				defaultRepository = undefined;
				await repository.close();
			}
		},
	};
}
