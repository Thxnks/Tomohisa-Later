import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import type { DebtRepository } from "../db.ts";
import { ReviewEngine } from "../review/review-engine.ts";
import type { ReviewResult } from "../review/types.ts";

export const DEFAULT_REVIEW_MINUTES = 30;

export function parseReviewMinutes(args: string): number | undefined {
	const value = args.trim();
	if (value === "") return DEFAULT_REVIEW_MINUTES;
	if (!/^\d+$/.test(value)) return undefined;
	const minutes = Number(value);
	return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : undefined;
}

function formatReviewPrompt(result: ReviewResult): string {
	const candidates = result.candidates.map(({ item, ruleScore }) => ({
		id: item.id,
		title: item.title,
		debt_type: item.debtType,
		status: item.status,
		why_saved: item.whySaved,
		next_action: item.nextAction,
		priority: item.priority,
		estimated_minutes: item.estimatedMinutes,
		due_at: item.dueAt,
		created_at: item.createdAt,
		rule_score: ruleScore,
	}));

	return [
		`I have ${result.availableMinutes} minutes available for an Information Debt review.`,
		`The deterministic Review Engine selected and ranked ${result.candidates.length} of ${result.candidateCount} eligible candidates.`,
		"Choose the most worthwhile combination from the candidates below. Keep the total known estimated_minutes within the available budget; do not update or resolve any Debt.",
		"Explain briefly why each selected item is worth handling now, considering deadline, priority, relevance, why_saved, and next_action.",
		`Candidates:\n${JSON.stringify(candidates)}`,
	].join("\n\n");
}

export function registerReviewCommand(pi: ExtensionAPI, repository: DebtRepository): void {
	const engine = new ReviewEngine(repository);
	pi.registerCommand("review", {
		description: "Rank information debt for an available time budget",
		handler: async (args, ctx) => {
			const availableMinutes = parseReviewMinutes(args);
			if (availableMinutes === undefined) {
				ctx.ui.notify("Usage: /review [positive whole minutes], for example /review 30", "error");
				return;
			}

			const result = await engine.review({ availableMinutes });
			if (result.candidates.length === 0) {
				ctx.ui.notify("No Information Debt is currently eligible for review.", "info");
				return;
			}

			pi.sendUserMessage(formatReviewPrompt(result));
		},
	});
}
