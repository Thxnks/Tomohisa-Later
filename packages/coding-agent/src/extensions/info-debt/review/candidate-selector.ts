import type { DebtRepository } from "../db.ts";
import type { DebtItem } from "../types.ts";

export const DEFAULT_REVIEW_CANDIDATE_LIMIT = 100;

export function isReviewEligible(item: DebtItem, now: number): boolean {
	if (item.status === "inbox" || item.status === "active") return true;
	return item.status === "deferred" && item.revisitAt !== undefined && item.revisitAt <= now;
}

export async function selectReviewCandidates(
	repository: DebtRepository,
	now: number,
	limit = DEFAULT_REVIEW_CANDIDATE_LIMIT,
): Promise<DebtItem[]> {
	const candidates = await repository.listReviewCandidates(now, limit);
	return candidates.filter((item) => isReviewEligible(item, now)).slice(0, limit);
}
