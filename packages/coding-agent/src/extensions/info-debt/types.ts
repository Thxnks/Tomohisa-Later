/**
 * Information Debt built-in data model.
 *
 * DebtItem is the TypeScript-facing shape (camelCase); DebtRow is the MySQL
 * row shape (snake_case). The only place the two spellings may diverge is the
 * rowToItem() mapping in this file.
 */

export const DEBT_TYPES = ["discovery", "reading", "action", "decision", "follow_up", "idea"] as const;
export type DebtType = (typeof DEBT_TYPES)[number];

export const DEBT_STATUSES = ["inbox", "active", "deferred", "resolved", "archived"] as const;
export type DebtStatus = (typeof DEBT_STATUSES)[number];

export interface DebtItem {
	/** Stable unique id (UUID). Used by all tools and commands. */
	id: string;
	title: string;
	/** Where it came from: "xiaohongshu" | "x" | "paper" | "web" | "school" | "manual" | ... */
	sourceType: string;
	sourceUrl?: string;
	rawContent?: string;
	debtType: DebtType;
	summary?: string;
	whySaved?: string;
	project?: string;
	nextAction?: string;
	status: DebtStatus;
	/** 1 (high) to 5 (low). */
	priority: number;
	estimatedMinutes?: number;
	/** Epoch ms. */
	dueAt?: number;
	/** Epoch ms. When it becomes worth pulling back out. */
	revisitAt?: number;
	/** Epoch ms. */
	createdAt: number;
	/** Epoch ms. */
	updatedAt: number;
	/** Epoch ms. Set when status becomes "resolved". */
	resolvedAt?: number;
	/** Free-form note recorded when the debt was resolved. */
	resolutionNote?: string;
}

/** MySQL row shape. Columns are snake_case; DebtItem fields are camelCase. */
export interface DebtRow {
	id: string;
	title: string;
	source_type: string;
	source_url: string | null;
	raw_content: string | null;
	debt_type: string;
	summary: string | null;
	why_saved: string | null;
	project: string | null;
	next_action: string | null;
	status: string;
	priority: number;
	estimated_minutes: number | null;
	due_at: number | null;
	revisit_at: number | null;
	created_at: number;
	updated_at: number;
	resolved_at: number | null;
	resolution_note: string | null;
}

export function rowToItem(row: DebtRow): DebtItem {
	return {
		id: row.id,
		title: row.title,
		sourceType: row.source_type,
		sourceUrl: row.source_url ?? undefined,
		rawContent: row.raw_content ?? undefined,
		debtType: row.debt_type as DebtType,
		summary: row.summary ?? undefined,
		whySaved: row.why_saved ?? undefined,
		project: row.project ?? undefined,
		nextAction: row.next_action ?? undefined,
		status: row.status as DebtStatus,
		priority: row.priority,
		estimatedMinutes: row.estimated_minutes ?? undefined,
		dueAt: row.due_at ?? undefined,
		revisitAt: row.revisit_at ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		resolvedAt: row.resolved_at ?? undefined,
		resolutionNote: row.resolution_note ?? undefined,
	};
}
