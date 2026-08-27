import type { DebtItem } from "../types.ts";
import type { ScoreBreakdown, ScoredReviewCandidate } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScoringContext {
	now: number;
	availableMinutes: number;
}

function priorityScore(priority: number): number {
	const normalized = Math.min(5, Math.max(1, priority));
	return (6 - normalized) * 3;
}

function urgencyScore(dueAt: number | undefined, now: number): number {
	if (dueAt === undefined) return 0;
	const remaining = dueAt - now;
	if (remaining <= 0) return 30;
	if (remaining <= DAY_MS) return 20;
	if (remaining <= 3 * DAY_MS) return 12;
	if (remaining <= 7 * DAY_MS) return 5;
	return 0;
}

function ageScore(createdAt: number, now: number): number {
	const ageDays = Math.max(0, now - createdAt) / DAY_MS;
	return Math.min(12, Math.floor(ageDays / 7) * 2);
}

function effortPenalty(estimatedMinutes: number | undefined, availableMinutes: number): number {
	if (estimatedMinutes === undefined || estimatedMinutes <= availableMinutes * 1.25) return 0;
	const overBudgetRatio = estimatedMinutes / Math.max(1, availableMinutes) - 1;
	return Math.min(20, Math.ceil(overBudgetRatio * 10));
}

export function scoreDebt(item: DebtItem, context: ScoringContext): ScoredReviewCandidate {
	const breakdown: ScoreBreakdown = {
		priority: priorityScore(item.priority),
		urgency: urgencyScore(item.dueAt, context.now),
		age: ageScore(item.createdAt, context.now),
		effortPenalty: effortPenalty(item.estimatedMinutes, context.availableMinutes),
	};
	return {
		item,
		ruleScore: breakdown.priority + breakdown.urgency + breakdown.age - breakdown.effortPenalty,
		breakdown,
	};
}
