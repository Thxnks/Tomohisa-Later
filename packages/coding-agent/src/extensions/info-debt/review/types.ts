import type { DebtItem } from "../types.ts";

export interface ReviewRequest {
	availableMinutes: number;
	now?: number;
	topK?: number;
	candidateLimit?: number;
}

export interface ScoreBreakdown {
	priority: number;
	urgency: number;
	age: number;
	effortPenalty: number;
}

export interface ScoredReviewCandidate {
	item: DebtItem;
	ruleScore: number;
	breakdown: ScoreBreakdown;
}

export interface ReviewResult {
	availableMinutes: number;
	generatedAt: number;
	candidateCount: number;
	candidates: ScoredReviewCandidate[];
}
