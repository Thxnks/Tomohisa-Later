/**
 * Information Debt commands.
 *
 * /inbox  - browse open debt items; pick one to hand it to the agent.
 * /review - hand the agent a time budget and ask it to pick the debts
 *           most worth handling right now.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { listDebts, listRevisitDue } from "./db.ts";
import type { DebtItem } from "./types.ts";

function formatInboxLine(item: DebtItem): string {
	const flags: string[] = [item.debtType, `p${item.priority}`];
	if (item.project) flags.push(item.project);
	if (item.estimatedMinutes !== undefined) flags.push(`~${item.estimatedMinutes}min`);
	return `${item.title}  (${flags.join(", ")})`;
}

function formatDetail(item: DebtItem): string {
	const lines: string[] = [item.summary ?? "(no summary)"];
	if (item.whySaved) lines.push(`Why saved: ${item.whySaved}`);
	if (item.nextAction) lines.push(`Next action: ${item.nextAction}`);
	if (item.sourceUrl) lines.push(item.sourceUrl);
	return lines.join("\n");
}

export function registerDebtCommands(pi: ExtensionAPI): void {
	pi.registerCommand("inbox", {
		description: "Browse information debt inbox",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/inbox requires interactive mode", "error");
				return;
			}

			const now = Date.now();
			const open = listDebts({ statuses: ["inbox", "active"], limit: 50 });
			const revisitDue = listRevisitDue(now, 50).filter((item) => !open.some((o) => o.id === item.id));
			const items = [...revisitDue, ...open];

			if (items.length === 0) {
				ctx.ui.notify("No open debt items. Capture some with capture_debt.", "info");
				return;
			}

			const lines = items.map((item) =>
				item.revisitAt && item.revisitAt <= now ? `[revisit] ${formatInboxLine(item)}` : formatInboxLine(item),
			);
			const selected = await ctx.ui.select(`Information Debt (${items.length} open)`, lines);
			if (selected === undefined) return;

			const index = lines.indexOf(selected);
			const item = items[index];
			const start = await ctx.ui.confirm(item.title, `${formatDetail(item)}\n\nHand this to the agent?`);
			if (!start) return;

			pi.sendUserMessage(
				`Please work on this information debt item.\n` +
					`Title: ${item.title}\n` +
					`Next action: ${item.nextAction ?? "(none recorded - figure out the best next step)"}\n` +
					`Start by calling get_debt with id ${item.id} for full context, ` +
					`set its status to active via update_debt, do the work, then resolve it with resolve_debt.`,
			);
		},
	});

	pi.registerCommand("review", {
		description: "Review information debt with a time budget (usage: /review [minutes])",
		getArgumentCompletions: (prefix) => {
			const durations = ["15", "30", "60", "120"];
			const matches = durations.filter((d) => d.startsWith(prefix));
			return matches.length > 0 ? matches.map((d) => ({ value: d, label: `${d} minutes` })) : null;
		},
		handler: async (args, ctx) => {
			const minutes = Number.parseInt(args.trim(), 10);
			if (Number.isNaN(minutes) || minutes <= 0) {
				ctx.ui.notify("Usage: /review [minutes], e.g. /review 30", "warning");
				return;
			}

			const now = Date.now();
			const open = listDebts({ statuses: ["inbox", "active"], limit: 50 });
			const overdue = open.filter((item) => item.dueAt !== undefined && item.dueAt < now);
			const revisitDue = listRevisitDue(now, 50).filter((item) => !open.some((o) => o.id === item.id));
			if (open.length + revisitDue.length === 0) {
				ctx.ui.notify("No open debt items to review.", "info");
				return;
			}

			const snapshot = [...overdue, ...revisitDue, ...open.filter((item) => !overdue.includes(item))]
				.filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
				.slice(0, 30)
				.map((item) => {
					const bits = [`#${item.id.slice(0, 8)}`, item.debtType, `p${item.priority}`];
					if (item.estimatedMinutes !== undefined) bits.push(`~${item.estimatedMinutes}min`);
					if (item.dueAt !== undefined && item.dueAt < now) bits.push("OVERDUE");
					const line = `${bits.join(" | ")} ${item.title}`;
					return item.nextAction ? `${line} -> ${item.nextAction}` : line;
				})
				.join("\n");

			pi.sendUserMessage(
				`I have ${minutes} minutes right now. Help me pick the information debt most worth handling in that window.\n\n` +
					`Open debt snapshot:\n${snapshot}\n\n` +
					`Consider priority, overdue due dates, estimated time, and how fresh each item still is. ` +
					`Call get_debt on candidates you need more context for, then recommend a shortlist with your reasoning, ` +
					`set the chosen items to active, and start working on the first one unless I say otherwise.`,
			);
		},
	});
}
