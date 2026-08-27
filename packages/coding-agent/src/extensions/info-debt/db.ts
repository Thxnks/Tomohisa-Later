/**
 * Debt Store: SQLite persistence for information debt.
 *
 * The database is the single source of truth for business state. It lives
 * outside pi sessions on purpose: sessions are the agent's execution
 * trajectory (messages, tool results), the debt DB is long-term state that
 * survives session branching, compaction, and deletion.
 *
 * Location: <agentDir>/info-debt/debt.db (global, cross-project).
 * Uses node:sqlite (DatabaseSync) — synchronous, no external dependencies.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "../../config.ts";
import { type DebtItem, type DebtRow, type DebtStatus, type DebtType, rowToItem } from "./types.ts";

/** Bindable SQLite parameter (node:sqlite SQLInputValue). */
type SqlParam = null | number | bigint | string | Uint8Array;

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
	if (!db) {
		const dir = join(getAgentDir(), "info-debt");
		mkdirSync(dir, { recursive: true });
		db = new DatabaseSync(join(dir, "debt.db"));
		db.exec("PRAGMA journal_mode=WAL");
		migrate(db);
	}
	return db;
}

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

/**
 * Numbered migrations, applied in order. The applied version is tracked in
 * the debt_meta table. Append new entries; never edit shipped ones.
 */
const MIGRATIONS: string[] = [
	`CREATE TABLE IF NOT EXISTS debt_items (
		id                TEXT PRIMARY KEY,
		title             TEXT NOT NULL,
		source_type       TEXT NOT NULL DEFAULT 'manual',
		source_url        TEXT,
		raw_content       TEXT,
		debt_type         TEXT NOT NULL,
		summary           TEXT,
		why_saved         TEXT,
		project           TEXT,
		next_action       TEXT,
		status            TEXT NOT NULL DEFAULT 'inbox',
		priority          INTEGER NOT NULL DEFAULT 3,
		estimated_minutes INTEGER,
		due_at            INTEGER,
		revisit_at        INTEGER,
		created_at        INTEGER NOT NULL,
		updated_at        INTEGER NOT NULL,
		resolved_at       INTEGER,
		resolution_note   TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_debt_status  ON debt_items(status);
	CREATE INDEX IF NOT EXISTS idx_debt_due     ON debt_items(due_at);
	CREATE INDEX IF NOT EXISTS idx_debt_revisit ON debt_items(revisit_at);
	CREATE INDEX IF NOT EXISTS idx_debt_project ON debt_items(project);`,
];

function migrate(database: DatabaseSync): void {
	database.exec("CREATE TABLE IF NOT EXISTS debt_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const row = database.prepare("SELECT value FROM debt_meta WHERE key = 'schema_version'").get() as
		| { value: string }
		| undefined;
	const current = row ? Number.parseInt(row.value, 10) : 0;

	for (let version = current; version < MIGRATIONS.length; version++) {
		database.exec("BEGIN");
		try {
			database.exec(MIGRATIONS[version]);
			database
				.prepare(
					"INSERT INTO debt_meta (key, value) VALUES ('schema_version', ?) " +
						"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(String(version + 1));
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}
}

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

function selectRow(database: DatabaseSync, sql: string, params: SqlParam[]): DebtItem | undefined {
	const row = database.prepare(sql).get(...params) as DebtRow | undefined;
	return row ? rowToItem(row) : undefined;
}

function selectRows(database: DatabaseSync, sql: string, params: SqlParam[]): DebtItem[] {
	const rows = database.prepare(sql).all(...params) as unknown as DebtRow[];
	return rows.map(rowToItem);
}

export function insertDebt(item: DebtItem): void {
	getDb()
		.prepare(`INSERT INTO debt_items (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`)
		.run(...itemToParams(item));
}

export function getDebt(id: string): DebtItem | undefined {
	return selectRow(getDb(), "SELECT * FROM debt_items WHERE id = ?", [id]);
}

/** Items whose id starts with the given prefix (short-id lookup). */
export function listDebtsByIdPrefix(prefix: string): DebtItem[] {
	return selectRows(getDb(), "SELECT * FROM debt_items WHERE id LIKE ? || '%'", [prefix]);
}

export interface DebtFilter {
	status?: DebtStatus;
	statuses?: DebtStatus[];
	debtType?: DebtType;
	project?: string;
	limit?: number;
}

function whereClause(filter: DebtFilter, params: SqlParam[]): string {
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

export function listDebts(filter: DebtFilter = {}): DebtItem[] {
	const params: SqlParam[] = [];
	const limit = filter.limit ?? 30;
	return selectRows(
		getDb(),
		`SELECT * FROM debt_items${whereClause(filter, params)}
		 ORDER BY priority ASC, COALESCE(due_at, 9223372036854775807) ASC, created_at ASC
		 LIMIT ?`,
		[...params, limit],
	);
}

/** Items that are due for a revisit: open (inbox/active) with a past revisit_at. */
export function listRevisitDue(now: number, limit = 30): DebtItem[] {
	return selectRows(
		getDb(),
		`SELECT * FROM debt_items
		 WHERE status IN ('inbox', 'active') AND revisit_at IS NOT NULL AND revisit_at <= ?
		 ORDER BY priority ASC, revisit_at ASC
		 LIMIT ?`,
		[now, limit],
	);
}

export function searchDebts(query: string, filter: DebtFilter = {}): DebtItem[] {
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
	return selectRows(
		getDb(),
		`SELECT * FROM debt_items WHERE ${conditions.join(" AND ")}
		 ORDER BY priority ASC, created_at ASC
		 LIMIT ?`,
		[...params, limit],
	);
}

/** Fields of DebtItem that updateDebt may change, mapped to columns. */
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

export function updateDebt(id: string, patch: Partial<DebtItem>): DebtItem | undefined {
	const assignments: string[] = [];
	const params: SqlParam[] = [];
	for (const [field, column] of Object.entries(UPDATABLE_COLUMNS) as Array<[keyof DebtItem, DebtColumnName]>) {
		if (patch[field] !== undefined) {
			assignments.push(`${column} = ?`);
			params.push(patch[field] as string | number);
		}
	}
	if (assignments.length === 0) {
		return getDebt(id);
	}
	assignments.push("updated_at = ?");
	params.push(Date.now(), id);

	getDb()
		.prepare(`UPDATE debt_items SET ${assignments.join(", ")} WHERE id = ?`)
		.run(...params);
	return getDebt(id);
}

export function resolveDebt(id: string, note?: string): DebtItem | undefined {
	const now = Date.now();
	return updateDebt(id, {
		status: "resolved",
		resolvedAt: now,
		resolutionNote: note,
	});
}
