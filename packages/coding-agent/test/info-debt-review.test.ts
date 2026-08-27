import { describe, expect, it } from "vitest";
import { parseReviewMinutes } from "../src/extensions/info-debt/commands/review.ts";
import type { DebtFilter, DebtRepository } from "../src/extensions/info-debt/db.ts";
import { selectReviewCandidates } from "../src/extensions/info-debt/review/candidate-selector.ts";
import { ReviewEngine } from "../src/extensions/info-debt/review/review-engine.ts";
import { scoreDebt } from "../src/extensions/info-debt/review/scorer.ts";
import type { DebtItem, DebtStatus } from "../src/extensions/info-debt/types.ts";

const NOW = Date.UTC(2026, 7, 27, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

function debt(overrides: Partial<DebtItem> & { id: string; status?: DebtStatus }): DebtItem {
	return {
		sourceType: "manual",
		debtType: "reading",
		priority: 3,
		createdAt: NOW - DAY_MS,
		updatedAt: NOW - DAY_MS,
		...overrides,
		id: overrides.id,
		title: overrides.title ?? overrides.id,
		status: overrides.status ?? "inbox",
	};
}

class ReviewRepositoryStub implements DebtRepository {
	private readonly items: DebtItem[];

	constructor(items: DebtItem[]) {
		this.items = items;
	}

	async close(): Promise<void> {}
	async create(_item: DebtItem): Promise<void> {}
	async get(_id: string): Promise<DebtItem | undefined> {
		return undefined;
	}
	async listByIdPrefix(_prefix: string): Promise<DebtItem[]> {
		return [];
	}
	async list(_filter?: DebtFilter): Promise<DebtItem[]> {
		return [];
	}
	async listRevisitDue(_now: number, _limit?: number): Promise<DebtItem[]> {
		return [];
	}
	async listReviewCandidates(_now: number, limit = 100): Promise<DebtItem[]> {
		return this.items.slice(0, limit);
	}
	async search(_query: string, _filter?: DebtFilter): Promise<DebtItem[]> {
		return [];
	}
	async update(_id: string, _patch: Partial<DebtItem>): Promise<DebtItem | undefined> {
		return undefined;
	}
	async resolve(_id: string, _note?: string): Promise<DebtItem | undefined> {
		return undefined;
	}
}

describe("review candidate selection", () => {
	it("excludes resolved debt", async () => {
		const repository = new ReviewRepositoryStub([debt({ id: "resolved", status: "resolved" })]);
		expect(await selectReviewCandidates(repository, NOW)).toEqual([]);
	});

	it("excludes archived debt", async () => {
		const repository = new ReviewRepositoryStub([debt({ id: "archived", status: "archived" })]);
		expect(await selectReviewCandidates(repository, NOW)).toEqual([]);
	});

	it("excludes deferred debt before revisit time", async () => {
		const repository = new ReviewRepositoryStub([
			debt({ id: "future", status: "deferred", revisitAt: NOW + DAY_MS }),
		]);
		expect(await selectReviewCandidates(repository, NOW)).toEqual([]);
	});

	it("includes deferred debt once revisit time is due", async () => {
		const due = debt({ id: "due", status: "deferred", revisitAt: NOW });
		const repository = new ReviewRepositoryStub([due]);
		expect(await selectReviewCandidates(repository, NOW)).toEqual([due]);
	});
});

describe("review scoring", () => {
	it("scores an imminent deadline above an ordinary saved item", () => {
		const ordinary = debt({ id: "ordinary" });
		const imminent = debt({ id: "imminent", dueAt: NOW + 60 * 60 * 1000 });
		expect(scoreDebt(imminent, { now: NOW, availableMinutes: 30 }).ruleScore).toBeGreaterThan(
			scoreDebt(ordinary, { now: NOW, availableMinutes: 30 }).ruleScore,
		);
	});

	it("scores higher priority debt above lower priority debt", () => {
		const high = debt({ id: "high", priority: 1 });
		const low = debt({ id: "low", priority: 5 });
		expect(scoreDebt(high, { now: NOW, availableMinutes: 30 }).ruleScore).toBeGreaterThan(
			scoreDebt(low, { now: NOW, availableMinutes: 30 }).ruleScore,
		);
	});

	it("penalizes effort that clearly exceeds the available time", () => {
		const fitting = debt({ id: "fitting", estimatedMinutes: 30 });
		const oversized = debt({ id: "oversized", estimatedMinutes: 90 });
		const fittingScore = scoreDebt(fitting, { now: NOW, availableMinutes: 30 });
		const oversizedScore = scoreDebt(oversized, { now: NOW, availableMinutes: 30 });
		expect(oversizedScore.breakdown.effortPenalty).toBeGreaterThan(0);
		expect(oversizedScore.ruleScore).toBeLessThan(fittingScore.ruleScore);
	});
});

describe("review engine", () => {
	it("sorts by score descending and truncates to Top-K", async () => {
		const items = Array.from({ length: 12 }, (_, index) =>
			debt({
				id: `item-${index}`,
				priority: (index % 5) + 1,
				dueAt: NOW + index * DAY_MS,
				createdAt: NOW - index * 7 * DAY_MS,
			}),
		);
		const result = await new ReviewEngine(new ReviewRepositoryStub(items)).review({
			availableMinutes: 30,
			now: NOW,
			topK: 5,
		});

		expect(result.candidateCount).toBe(12);
		expect(result.candidates).toHaveLength(5);
		expect(result.candidates.map((candidate) => candidate.ruleScore)).toEqual(
			[...result.candidates].map((candidate) => candidate.ruleScore).sort((a, b) => b - a),
		);
	});
});

describe("review command arguments", () => {
	it("uses 30 minutes by default and rejects invalid input", () => {
		expect(parseReviewMinutes("")).toBe(30);
		expect(parseReviewMinutes("30")).toBe(30);
		expect(parseReviewMinutes("abc")).toBeUndefined();
		expect(parseReviewMinutes("0")).toBeUndefined();
		expect(parseReviewMinutes("30 extra")).toBeUndefined();
	});
});
