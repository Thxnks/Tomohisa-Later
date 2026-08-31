import type { DebtRepository } from "./db.ts";
import type { DebtItem, DebtType } from "./types.ts";

export interface CaptureDebtInput {
	title: string;
	sourceType?: string;
	sourceUrl?: string;
	rawContent?: string;
	debtType: DebtType;
	summary?: string;
	whySaved?: string;
	project?: string;
	nextAction?: string;
	priority?: number;
	estimatedMinutes?: number;
	dueAt?: number;
	revisitAt?: number;
}

export class DebtService {
	private readonly repository: DebtRepository;

	constructor(repository: DebtRepository) {
		this.repository = repository;
	}

	async capture(input: CaptureDebtInput): Promise<DebtItem> {
		const now = Date.now();
		const item: DebtItem = {
			id: crypto.randomUUID(),
			title: input.title,
			sourceType: input.sourceType ?? "manual",
			sourceUrl: input.sourceUrl,
			rawContent: input.rawContent,
			debtType: input.debtType,
			summary: input.summary,
			whySaved: input.whySaved,
			project: input.project,
			nextAction: input.nextAction,
			status: "inbox",
			priority: input.priority ?? 3,
			estimatedMinutes: input.estimatedMinutes,
			dueAt: input.dueAt,
			revisitAt: input.revisitAt,
			createdAt: now,
			updatedAt: now,
		};
		await this.repository.create(item);
		return item;
	}
}
