import type { DebtRepository } from "../db.ts";
import { DEFAULT_REVIEW_CANDIDATE_LIMIT, selectReviewCandidates } from "./candidate-selector.ts";
import { scoreDebt } from "./scorer.ts";
import type { ReviewRequest, ReviewResult, ScoredReviewCandidate } from "./types.ts";

export const DEFAULT_REVIEW_TOP_K = 10;

export type ReviewCandidateSelector = typeof selectReviewCandidates;
export type ReviewScorer = typeof scoreDebt;

export interface ReviewPolicies {
	selectCandidates?: ReviewCandidateSelector;
	score?: ReviewScorer;
}

function compareCandidates(left: ScoredReviewCandidate, right: ScoredReviewCandidate): number {
	if (left.ruleScore !== right.ruleScore) return right.ruleScore - left.ruleScore;
	const leftDue = left.item.dueAt ?? Number.POSITIVE_INFINITY;
	const rightDue = right.item.dueAt ?? Number.POSITIVE_INFINITY;
	if (leftDue !== rightDue) return leftDue - rightDue;
	if (left.item.priority !== right.item.priority) return left.item.priority - right.item.priority;
	return left.item.createdAt - right.item.createdAt;
}

export class ReviewEngine {
	private readonly repository: DebtRepository;
	private readonly selectCandidates: ReviewCandidateSelector;
	private readonly score: ReviewScorer;

	constructor(repository: DebtRepository, policies: ReviewPolicies = {}) {
		this.repository = repository;
		this.selectCandidates = policies.selectCandidates ?? selectReviewCandidates;
		this.score = policies.score ?? scoreDebt;
	}

	async review(request: ReviewRequest): Promise<ReviewResult> {
		const now = request.now ?? Date.now();
		const topK = request.topK ?? DEFAULT_REVIEW_TOP_K;
		const candidateLimit = request.candidateLimit ?? DEFAULT_REVIEW_CANDIDATE_LIMIT;
		const candidates = await this.selectCandidates(this.repository, now, candidateLimit);
		const scored = candidates
			.map((item) => this.score(item, { now, availableMinutes: request.availableMinutes }))
			.sort(compareCandidates)
			.slice(0, topK);

		return {
			availableMinutes: request.availableMinutes,
			generatedAt: now,
			candidateCount: candidates.length,
			candidates: scored,
		};
	}
}
