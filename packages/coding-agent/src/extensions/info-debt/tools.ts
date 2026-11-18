/**
 * Information Debt tools.
 *
 * Six independent tools registered via pi.registerTool(). Each tool reads and
 * writes the MySQL debt store through DebtService; tool results returned to the LLM are
 * deliberately compact so the session trajectory never becomes the state
 * store — the model can always re-query the DB for current truth.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type DebtRepository, getDebtRepository } from "./db.ts";
import { DebtService } from "./service.ts";
import { DEBT_STATUSES, DEBT_TYPES, type DebtItem, type DebtStatus } from "./types.ts";

/** Accepts an ISO 8601 string or epoch milliseconds. Returns epoch ms. */
function parseTimestamp(value: string | number, field: string): number {
	const ms = typeof value === "number" ? value : Date.parse(value);
	if (Number.isNaN(ms)) {
		throw new Error(`${field} must be an ISO 8601 string or epoch milliseconds, got: ${value}`);
	}
	return ms;
}

const TimestampSchema = Type.Union([Type.String(), Type.Number()], {
	description: "ISO 8601 string (e.g. 2026-09-01T09:00:00Z) or epoch milliseconds",
});

function shortId(id: string): string {
	return id.slice(0, 8);
}

function formatItemLine(item: DebtItem): string {
	const parts = [`#${shortId(item.id)}`, item.status, item.debtType, `p${item.priority}`];
	if (item.project) parts.push(`[${item.project}]`);
	if (item.estimatedMinutes !== undefined) parts.push(`~${item.estimatedMinutes}min`);
	const line = `${parts.join(" | ")} ${item.title}`;
	return item.nextAction ? `${line} -> ${item.nextAction}` : line;
}

function formatFullItem(item: DebtItem): string {
	const lines: string[] = [
		`id: ${item.id}`,
		`title: ${item.title}`,
		`status: ${item.status} | type: ${item.debtType} | priority: ${item.priority} | source: ${item.sourceType}`,
	];
	const optional: Array<[string, string | number | undefined]> = [
		["source_url", item.sourceUrl],
		["project", item.project],
		["summary", item.summary],
		["why_saved", item.whySaved],
		["next_action", item.nextAction],
		["estimated_minutes", item.estimatedMinutes],
		["due_at", item.dueAt],
		["revisit_at", item.revisitAt],
		["resolution_note", item.resolutionNote],
	];
	for (const [key, value] of optional) {
		if (value !== undefined) lines.push(`${key}: ${value}`);
	}
	if (item.rawContent) {
		const raw =
			item.rawContent.length > 4000 ? `${item.rawContent.slice(0, 4000)}\n... (truncated)` : item.rawContent;
		lines.push(`raw_content:\n${raw}`);
	}
	lines.push(`created_at: ${new Date(item.createdAt).toISOString()}`);
	lines.push(`updated_at: ${new Date(item.updatedAt).toISOString()}`);
	return lines.join("\n");
}

interface DebtToolDetails {
	tool: string;
	id?: string;
	title?: string;
	status?: DebtStatus;
	count?: number;
	error?: string;
}

function textResult(text: string, details: DebtToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

export function registerDebtTools(pi: ExtensionAPI, repository: DebtRepository = getDebtRepository()): void {
	const service = new DebtService(repository);
	pi.registerTool({
		name: "capture_debt",
		label: "Capture Debt",
		description:
			"Record a new information debt item: something worth keeping (article, link, paper, task, idea) " +
			"that is not being handled right now but should not be forgotten. " +
			"Always include why_saved and next_action when the user provides or implies them.",
		promptSnippet: "capture_debt: record information worth keeping for later (articles, links, papers, tasks, ideas)",
		promptGuidelines: [
			"When the user mentions saving, bookmarking, or keeping an article, link, paper, task, or idea for later, capture it with capture_debt including why_saved and next_action.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short human-readable title" }),
			debtType: StringEnum(DEBT_TYPES, { description: "Kind of debt" }),
			sourceType: Type.Optional(
				Type.String({ description: 'Origin, e.g. "xiaohongshu", "x", "paper", "web", "school", "manual"' }),
			),
			sourceUrl: Type.Optional(Type.String({ description: "Original URL, if any" })),
			rawContent: Type.Optional(Type.String({ description: "Raw captured text (paste, excerpt)" })),
			summary: Type.Optional(Type.String({ description: "One-paragraph summary of what it is" })),
			whySaved: Type.Optional(Type.String({ description: "Why this was saved" })),
			project: Type.Optional(Type.String({ description: "Related project or goal" })),
			nextAction: Type.Optional(Type.String({ description: "Concrete next step to resolve it" })),
			priority: Type.Optional(Type.Number({ description: "1 (high) to 5 (low), default 3" })),
			estimatedMinutes: Type.Optional(Type.Number({ description: "Estimated minutes to resolve" })),
			dueAt: Type.Optional(TimestampSchema),
			revisitAt: Type.Optional(TimestampSchema),
		}),
		async execute(_toolCallId, params) {
			const item = await service.capture({
				title: params.title,
				sourceType: params.sourceType ?? "manual",
				sourceUrl: params.sourceUrl,
				rawContent: params.rawContent,
				debtType: params.debtType,
				summary: params.summary,
				whySaved: params.whySaved,
				project: params.project,
				nextAction: params.nextAction,
				priority: params.priority ?? 3,
				estimatedMinutes: params.estimatedMinutes,
				dueAt: params.dueAt ? parseTimestamp(params.dueAt, "dueAt") : undefined,
				revisitAt: params.revisitAt ? parseTimestamp(params.revisitAt, "revisitAt") : undefined,
			});
			return textResult(`Captured debt ${shortId(item.id)}: ${item.title} (status: inbox)`, {
				tool: "capture_debt",
				id: item.id,
				title: item.title,
				status: item.status,
			});
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("capture ")) + theme.fg("muted", `${args.debtType}: `) + args.title,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "list_debts",
		label: "List Debts",
		description:
			"List business tasks and next actions by priority, deadline, then oldest creation time. Filter by status, type, or project. Returns short ids. This does not list the source library or bulk-imported favorites.",
		promptSnippet: "list_debts: business tasks and next actions, filterable by status/type/project",
		promptGuidelines: [
			"Use list_debts for tasks, priorities, and next actions. For recent saved sources, use list_materials; for the last favorites import, use get_saved_import. Debt results are not the user's complete or most recent collection.",
		],
		parameters: Type.Object({
			status: Type.Optional(StringEnum(DEBT_STATUSES, { description: "Filter by status" })),
			debtType: Type.Optional(StringEnum(DEBT_TYPES, { description: "Filter by debt type" })),
			project: Type.Optional(Type.String({ description: "Filter by project" })),
			limit: Type.Optional(Type.Number({ description: "Max items to return, default 30" })),
		}),
		async execute(_toolCallId, params) {
			const items = await repository.list({
				status: params.status,
				debtType: params.debtType,
				project: params.project,
				limit: params.limit,
			});
			if (items.length === 0) {
				return textResult("No debt items match the filters.", { tool: "list_debts", count: 0 });
			}
			return textResult(`${items.length} debt item(s):\n${items.map(formatItemLine).join("\n")}`, {
				tool: "list_debts",
				count: items.length,
			});
		},
		renderCall(args, theme) {
			const filters = [args.status, args.debtType, args.project].filter(Boolean).join(", ");
			return new Text(theme.fg("toolTitle", theme.bold("debts ")) + theme.fg("muted", filters || "all"), 0, 0);
		},
	});

	pi.registerTool({
		name: "get_debt",
		label: "Get Debt",
		description: "Get full details of one information debt item by id (the short 8-char id from list results works).",
		promptSnippet: "get_debt: full details of one debt item by id",
		parameters: Type.Object({
			id: Type.String({ description: "Debt item id (full or 8-char short form)" }),
		}),
		async execute(_toolCallId, params) {
			const item = await findDebtById(repository, params.id);
			return textResult(formatFullItem(item), {
				tool: "get_debt",
				id: item.id,
				title: item.title,
				status: item.status,
			});
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("debt ")) + theme.fg("accent", args.id), 0, 0);
		},
	});

	pi.registerTool({
		name: "search_debts",
		label: "Search Debts",
		description:
			"Search business metadata (titles, summaries, why-saved notes, projects, next actions, URLs) by case-insensitive substring. Does not search original bodies or independent imported favorites. Use search_materials for saved source content.",
		promptSnippet: "search_debts: substring search over saved debt items",
		parameters: Type.Object({
			query: Type.String({ description: "Search text" }),
			status: Type.Optional(StringEnum(DEBT_STATUSES, { description: "Filter by status" })),
			debtType: Type.Optional(StringEnum(DEBT_TYPES, { description: "Filter by debt type" })),
			project: Type.Optional(Type.String({ description: "Filter by project" })),
			limit: Type.Optional(Type.Number({ description: "Max items to return, default 30" })),
		}),
		async execute(_toolCallId, params) {
			const items = await repository.search(params.query, {
				status: params.status,
				debtType: params.debtType,
				project: params.project,
				limit: params.limit,
			});
			if (items.length === 0) {
				return textResult(`No debt items match "${params.query}".`, { tool: "search_debts", count: 0 });
			}
			return textResult(
				`${items.length} match(es) for "${params.query}":\n${items.map(formatItemLine).join("\n")}`,
				{ tool: "search_debts", count: items.length },
			);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("muted", `"${args.query}"`), 0, 0);
		},
	});

	pi.registerTool({
		name: "update_debt",
		label: "Update Debt",
		description:
			"Update fields of an existing debt item. Only provided fields change. Sets status to make progress visible.",
		promptSnippet: "update_debt: change fields of a debt item (status, next_action, priority, ...)",
		parameters: Type.Object({
			id: Type.String({ description: "Debt item id (full or 8-char short form)" }),
			title: Type.Optional(Type.String()),
			debtType: Type.Optional(StringEnum(DEBT_TYPES)),
			status: Type.Optional(StringEnum(DEBT_STATUSES)),
			sourceType: Type.Optional(Type.String()),
			sourceUrl: Type.Optional(Type.String()),
			summary: Type.Optional(Type.String()),
			whySaved: Type.Optional(Type.String()),
			project: Type.Optional(Type.String()),
			nextAction: Type.Optional(Type.String()),
			priority: Type.Optional(Type.Number({ description: "1 (high) to 5 (low)" })),
			estimatedMinutes: Type.Optional(Type.Number()),
			dueAt: Type.Optional(TimestampSchema),
			revisitAt: Type.Optional(TimestampSchema),
		}),
		async execute(_toolCallId, params) {
			const item = await findDebtById(repository, params.id);
			const updated = await repository.update(item.id, {
				title: params.title,
				debtType: params.debtType,
				status: params.status,
				sourceType: params.sourceType,
				sourceUrl: params.sourceUrl,
				summary: params.summary,
				whySaved: params.whySaved,
				project: params.project,
				nextAction: params.nextAction,
				priority: params.priority,
				estimatedMinutes: params.estimatedMinutes,
				dueAt: params.dueAt === undefined ? undefined : parseTimestamp(params.dueAt, "dueAt"),
				revisitAt: params.revisitAt === undefined ? undefined : parseTimestamp(params.revisitAt, "revisitAt"),
			});
			if (!updated) {
				throw new Error(`Debt item ${params.id} disappeared during update`);
			}
			return textResult(`Updated ${shortId(updated.id)}: ${formatItemLine(updated)}`, {
				tool: "update_debt",
				id: updated.id,
				title: updated.title,
				status: updated.status,
			});
		},
		renderCall(args, theme) {
			const changes = [
				args.status ? `status=${args.status}` : undefined,
				args.nextAction ? "next_action" : undefined,
			]
				.filter(Boolean)
				.join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("update ")) +
					theme.fg("accent", args.id) +
					theme.fg("muted", changes ? ` (${changes})` : ""),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "resolve_debt",
		label: "Resolve Debt",
		description: "Mark a debt item as resolved, optionally recording how it was resolved.",
		promptSnippet: "resolve_debt: mark a debt item resolved with an optional note",
		parameters: Type.Object({
			id: Type.String({ description: "Debt item id (full or 8-char short form)" }),
			note: Type.Optional(Type.String({ description: "How it was resolved" })),
		}),
		async execute(_toolCallId, params) {
			const item = await findDebtById(repository, params.id);
			const resolved = await repository.resolve(item.id, params.note);
			if (!resolved) {
				throw new Error(`Debt item ${params.id} disappeared during resolve`);
			}
			return textResult(
				`Resolved ${shortId(resolved.id)}: ${resolved.title}${params.note ? ` (${params.note})` : ""}`,
				{
					tool: "resolve_debt",
					id: resolved.id,
					title: resolved.title,
					status: resolved.status,
				},
			);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("resolve ")) + theme.fg("accent", args.id), 0, 0);
		},
	});
}

/** Resolve full or 8-char short ids; throws a descriptive error when not found. */
async function findDebtById(repository: DebtRepository, id: string): Promise<DebtItem> {
	const exact = await repository.get(id);
	if (exact) return exact;
	if (id.length < 8) {
		throw new Error(`Debt id too short; use the full id or the 8-char short form: ${id}`);
	}
	const candidates = await repository.listByIdPrefix(id);
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0) throw new Error(`No debt item found with id ${id}`);
	throw new Error(`Ambiguous debt id ${id}: matches ${candidates.length} items`);
}
