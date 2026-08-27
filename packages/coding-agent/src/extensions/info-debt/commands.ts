/**
 * Information Debt commands.
 *
 * /inbox - browse open debt items; pick one to hand it to the agent.
 * /review - rank eligible debt and hand Top-K candidates to the current agent.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { registerReviewCommand } from "./commands/review.ts";
import { type DebtRepository, getDebtRepository } from "./db.ts";
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

export function registerDebtCommands(pi: ExtensionAPI, repository: DebtRepository = getDebtRepository()): void {
	pi.registerCommand("inbox", {
		description: "Browse information debt inbox",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/inbox requires interactive mode", "error");
				return;
			}

			const now = Date.now();
			const open = await repository.list({ statuses: ["inbox", "active"], limit: 50 });
			const revisitDue = (await repository.listRevisitDue(now, 50)).filter(
				(item) => !open.some((openItem) => openItem.id === item.id),
			);
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

	registerReviewCommand(pi, repository);
}
